#!/usr/bin/env node
/**
 * Envia as variáveis de ambiente do `.env` local para a Vercel via CLI.
 *
 *   node scripts/vercel-env.js            # mostra o que faria (valores ocultos)
 *   node scripts/vercel-env.js --apply    # envia de verdade
 *
 * Por que existe: colar 8 variáveis à mão no painel é lento e é onde se erra —
 * um espaço a mais no fim de uma chave e o deploy volta a responder 401 sem
 * explicação. Aqui os valores saem direto do arquivo que já funciona local.
 *
 * O valor de cada variável vai por **stdin** para o `vercel env add`, não como
 * argumento: argumento de processo aparece na lista de processos e no histórico
 * do shell.
 *
 * `DATABASE_URL` é ignorada de propósito — a forma certa é criar o Postgres em
 * Storage no painel da Vercel, que injeta a variável no projeto sozinho, sem
 * ninguém copiar connection string com senha dentro.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ENV_FILE = path.join(__dirname, '..', '.env');
const TARGETS = ['production', 'preview'];

/** Variáveis que o deploy precisa. A ordem é a que aparece no resumo. */
const REQUIRED = [
  'RPC_ENDPOINT',
  'VAULT_PRIVATE_KEY',
  'FIAT_PROVIDER_SECRET',
  'ADMIN_API_KEY',
  'RECIPIENTS_JSON',
  'INPUT_MINT',
];
const OPTIONAL = [
  'CRON_SECRET',
  'RPC_SEND_ENDPOINT',
  'INPUT_MINT_DECIMALS',
  'SLIPPAGE_BPS',
  'MAX_PRICE_IMPACT_BPS',
  'PRIORITY_FEE_MICRO_LAMPORTS',
  'FEE_RESERVE_LAMPORTS',
  'MIN_TRANSFER_LAMPORTS',
  'MAX_TRANSFERS_PER_TX',
  'MAX_ATTEMPTS',
  'MAX_ORDER_INPUT_RAW',
  'DEPOSIT_WAIT_TIMEOUT_MS',
  'SERVERLESS_BUDGET_MS',
  'JUPITER_API_BASE',
  'FIAT_PROVIDER',
  'WEBHOOK_TOLERANCE_SECONDS',
  'LOG_LEVEL',
];
/** Nunca enviadas: só fazem sentido local, ou vêm da integração da Vercel. */
const SKIP = new Set(['DATABASE_URL', 'DATABASE_PROVIDER', 'PORT', 'NODE_ENV', 'LOG_LEVEL']);

/** Forçadas, independente do que está no .env local. */
const FORCED = { NODE_ENV: 'production', LOG_LEVEL: 'info' };

const apply = process.argv.includes('--apply');

function parseEnvFile(file) {
  if (!fs.existsSync(file)) {
    console.error(`não encontrei ${file}. Copie .env.example para .env primeiro.`);
    process.exit(1);
  }
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Remove aspas envolventes (RECIPIENTS_JSON vem entre apóstrofos).
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== '') out[key] = value;
  }
  return out;
}

/** Mostra o suficiente para reconhecer o valor, sem revelá-lo. */
function mask(key, value) {
  if (/KEY|SECRET|PRIVATE|TOKEN|PASSWORD/i.test(key)) {
    return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
  }
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
}

const env = parseEnvFile(ENV_FILE);

const missing = REQUIRED.filter((k) => env[k] === undefined);
if (missing.length > 0) {
  console.error('faltam variáveis obrigatórias no .env:');
  missing.forEach((k) => console.error(`  - ${k}`));
  process.exit(1);
}

const toSend = [...REQUIRED, ...OPTIONAL].filter((k) => !SKIP.has(k) && env[k] !== undefined);

console.log(`\nVariáveis a enviar (${toSend.length}), ambientes: ${TARGETS.join(', ')}\n`);
for (const key of toSend) {
  console.log(`  ${key.padEnd(30)} ${mask(key, env[key])}`);
}
console.log('');
for (const [k, v] of Object.entries(FORCED)) {
  console.log(`  ${k.padEnd(30)} ${v}  (forçado)`);
}
console.log('\n  DATABASE_URL                   IGNORADA — crie o Postgres em');
console.log('                                 Vercel → Storage, que injeta sozinho\n');

if (!apply) {
  console.log('Isto foi só a prévia. Para enviar de verdade:\n');
  console.log('  npx vercel login          # se ainda não estiver autenticado');
  console.log('  npx vercel link           # associa esta pasta ao projeto');
  console.log('  node scripts/vercel-env.js --apply\n');
  process.exit(0);
}

if (!fs.existsSync(path.join(__dirname, '..', '.vercel', 'project.json'))) {
  console.error('projeto não linkado. Rode `npx vercel link` primeiro.\n');
  process.exit(1);
}

function addEnv(key, value, target) {
  try {
    // Valor por stdin: não aparece na lista de processos nem no histórico.
    execFileSync('npx', ['--yes', 'vercel', 'env', 'add', key, target], {
      input: value,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    return { ok: true };
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (/already exists/i.test(out)) return { ok: false, reason: 'já existe (remova antes para trocar)' };
    return { ok: false, reason: out.trim().split('\n').slice(-2).join(' ').slice(0, 160) };
  }
}

let ok = 0;
let failed = 0;

for (const target of TARGETS) {
  console.log(`\n── ${target} ──`);
  for (const key of [...toSend, ...Object.keys(FORCED)]) {
    const value = FORCED[key] ?? env[key];
    const r = addEnv(key, value, target);
    if (r.ok) {
      ok += 1;
      console.log(`  ok      ${key}`);
    } else {
      failed += 1;
      console.log(`  falhou  ${key}  — ${r.reason}`);
    }
  }
}

console.log(`\n${ok} enviadas, ${failed} falharam.`);
console.log('\nAgora faça o redeploy — variáveis novas não entram num deploy já feito:\n');
console.log('  npx vercel --prod\n');
if (env.ADMIN_API_KEY) {
  console.log(`Chave para entrar no painel: ${env.ADMIN_API_KEY}\n`);
}
