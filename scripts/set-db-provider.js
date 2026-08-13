#!/usr/bin/env node
/**
 * Troca o `provider` do datasource no schema do Prisma.
 *
 *   node scripts/set-db-provider.js postgresql
 *   node scripts/set-db-provider.js sqlite
 *
 * Por que um script e não `env()`: o Prisma **não** aceita `env()` no `provider`
 * do datasource (só em `url`/`directUrl`) — verificado com a 5.22. As
 * alternativas seriam manter dois schemas (que divergem com o tempo) ou editar
 * a linha na mão em cada deploy. Um script idempotente sobre um schema único é
 * o menor mal.
 *
 * Se `DATABASE_PROVIDER` estiver no ambiente e nenhum argumento for passado,
 * usa essa variável — assim o build do host cuida disso sozinho.
 */
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = path.join(__dirname, '..', 'src', 'database', 'schema.prisma');
const SUPPORTED = ['sqlite', 'postgresql', 'mysql'];

const target = (process.argv[2] || process.env.DATABASE_PROVIDER || '').trim();

if (!target) {
  console.error('uso: node scripts/set-db-provider.js <sqlite|postgresql|mysql>');
  console.error('(ou defina DATABASE_PROVIDER no ambiente)');
  process.exit(1);
}
if (!SUPPORTED.includes(target)) {
  console.error(`provider não suportado: "${target}" (aceitos: ${SUPPORTED.join(', ')})`);
  process.exit(1);
}

const original = fs.readFileSync(SCHEMA, 'utf8');
const re = /(datasource\s+db\s*\{[^}]*?provider\s*=\s*")([^"]+)(")/s;
const match = re.exec(original);

if (!match) {
  console.error(`não encontrei o provider no datasource de ${SCHEMA}`);
  process.exit(1);
}

const current = match[2];
if (current === target) {
  console.log(`provider já é "${target}" — nada a fazer`);
  process.exit(0);
}

fs.writeFileSync(SCHEMA, original.replace(re, `$1${target}$3`));
console.log(`provider: "${current}" -> "${target}"`);
console.log('rode `npx prisma generate` (e a migration correspondente) em seguida.');
