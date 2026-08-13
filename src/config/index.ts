import 'dotenv/config';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';

/**
 * Carrega e valida TODO o ambiente uma única vez, no boot.
 * Se algo estiver errado o processo morre aqui — nunca em runtime, no meio de
 * uma ordem já paga pelo cliente.
 *
 * Nota: o split e os parâmetros de taxa/horário vivem no BANCO (editáveis pelo
 * admin). `RECIPIENTS_JSON` aqui é apenas o seed da primeira subida.
 */

const BPS_TOTAL = 10_000;

const recipientSchema = z.object({
  label: z.string().min(1).optional(),
  address: z.string().min(32).max(44),
  bps: z.number().int().positive().max(BPS_TOTAL),
});

const recipientsSchema = z
  .array(recipientSchema)
  .min(1, 'RECIPIENTS_JSON precisa de ao menos 1 destinatário')
  .superRefine((list, ctx) => {
    const sum = list.reduce((acc, r) => acc + r.bps, 0);
    if (sum !== BPS_TOTAL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a soma dos bps precisa ser exatamente ${BPS_TOTAL} (100%), recebido ${sum}`,
      });
    }
    const seen = new Set<string>();
    list.forEach((r, i) => {
      try {
        new PublicKey(r.address);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'address'],
          message: `"${r.address}" não é uma public key Solana válida`,
        });
      }
      if (seen.has(r.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'address'],
          message: `endereço duplicado: ${r.address}`,
        });
      }
      seen.add(r.address);
    });
  });

/** Aceita base58 (Phantom) ou array JSON de 64 bytes (solana-keygen). */
function parseSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== 'number')) {
      throw new Error('VAULT_PRIVATE_KEY: array JSON inválido');
    }
    return Uint8Array.from(parsed as number[]);
  }
  return bs58.decode(trimmed);
}

const numeric = (fallback: number, opts: { min?: number; max?: number } = {}) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(opts.min ?? 0).max(opts.max ?? Number.MAX_SAFE_INTEGER));

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v)));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: numeric(3000, { min: 1, max: 65_535 }),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  RPC_ENDPOINT: z.string().url(),
  RPC_SEND_ENDPOINT: z.string().url().optional().or(z.literal('')),

  VAULT_PRIVATE_KEY: z.string().min(1, 'VAULT_PRIVATE_KEY é obrigatória'),

  FIAT_PROVIDER: z.enum(['spherepay', 'moonpay']).default('spherepay'),
  FIAT_PROVIDER_SECRET: z.string().min(8, 'FIAT_PROVIDER_SECRET é obrigatória'),
  WEBHOOK_TOLERANCE_SECONDS: numeric(300, { min: 0 }),

  /** Protege /admin/*. Sem isto o painel não sobe. */
  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY precisa de ao menos 16 caracteres'),

  /**
   * Segredo do cron externo (Vercel Cron manda `Authorization: Bearer`).
   * Só necessário onde o agendador in-process não funciona.
   */
  CRON_SECRET: z.string().min(16).optional(),

  /**
   * Libera a pipeline que move dinheiro (swap + liquidação).
   * Default: ligada em host persistente, DESLIGADA em serverless — ver
   * `isServerless` abaixo. Só force para `true` em serverless depois de trocar
   * os locks in-process por lock no banco.
   */
  ALLOW_PIPELINE: z.string().optional(),

  RECIPIENTS_JSON: z.string().min(2, 'RECIPIENTS_JSON é obrigatória (seed inicial)'),

  // `quote-api.jup.ag/v6` foi retirado do ar (o host não resolve mais).
  // `lite-api.jup.ag/swap/v1` é o tier público atual e serve exatamente o
  // mesmo contrato do v6 (/quote e /swap, mesmos campos) — verificado.
  JUPITER_API_BASE: z.string().url().default('https://lite-api.jup.ag/swap/v1'),
  INPUT_MINT: z.string().min(32),
  INPUT_MINT_DECIMALS: numeric(6, { min: 0, max: 18 }),
  SLIPPAGE_BPS: numeric(50, { min: 1, max: BPS_TOTAL }),
  PRIORITY_FEE_MICRO_LAMPORTS: numeric(200_000, { min: 0 }),
  /** Aborta o swap se o price impact passar disto (proteção contra pool raso). */
  MAX_PRICE_IMPACT_BPS: numeric(300, { min: 1, max: BPS_TOTAL }),

  FEE_RESERVE_LAMPORTS: numeric(10_000_000, { min: 0 }),
  MIN_TRANSFER_LAMPORTS: numeric(890_880, { min: 1 }),
  MAX_TRANSFERS_PER_TX: numeric(18, { min: 1, max: 24 }),
  MAX_ATTEMPTS: numeric(3, { min: 1, max: 10 }),
  DEPOSIT_WAIT_TIMEOUT_MS: numeric(180_000, { min: 0 }),
  /** Teto por ordem — limita o dano de um evento forjado ou de um bug. */
  MAX_ORDER_INPUT_RAW: numeric(50_000_000_000, { min: 1 }),

  // ── Agregador de taxas dos on-ramps ──
  FEE_CACHE_TTL_MS: numeric(300_000, { min: 0 }),
  MOONPAY_ENABLED: boolish(false),
  MOONPAY_API_KEY: z.string().optional(),
  MOONPAY_API_BASE: z.string().url().default('https://api.moonpay.com'),
  TRANSAK_ENABLED: boolish(false),
  TRANSAK_API_KEY: z.string().optional(),
  TRANSAK_API_BASE: z.string().url().default('https://api.transak.com'),
  RAMP_ENABLED: boolish(false),
  RAMP_API_KEY: z.string().optional(),
  RAMP_API_BASE: z.string().url().default('https://api.ramp.network'),
  SPHEREPAY_ENABLED: boolish(false),
  SPHEREPAY_API_KEY: z.string().optional(),
  SPHEREPAY_API_BASE: z.string().url().default('https://api.spherepay.co'),
});

/**
 * Erro de configuração com a lista completa do que está errado.
 *
 * Este módulo NÃO chama `process.exit()`. Matar o processo durante o `import`
 * é o pior comportamento possível fora de um servidor de longa duração: numa
 * função serverless o resultado é um `FUNCTION_INVOCATION_FAILED` opaco, sem
 * nenhuma pista de qual variável falta. Quem importa decide o que fazer —
 * `server.ts` encerra com a lista impressa, o handler serverless responde 503
 * com ela em JSON.
 */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`configuração inválida:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new ConfigError(
    parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  );
}
const env = parsed.data;

let vaultKeypair: Keypair;
try {
  vaultKeypair = Keypair.fromSecretKey(parseSecretKey(env.VAULT_PRIVATE_KEY));
} catch (err) {
  throw new ConfigError([
    `VAULT_PRIVATE_KEY inválida (esperado base58 ou array de 64 bytes): ${
      err instanceof Error ? err.message : String(err)
    }`,
  ]);
}

const recipientsSeed = (() => {
  let json: unknown;
  try {
    json = JSON.parse(env.RECIPIENTS_JSON);
  } catch {
    throw new ConfigError(['RECIPIENTS_JSON não é um JSON válido']);
  }
  const result = recipientsSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `RECIPIENTS_JSON[${issue.path.join('.')}]: ${issue.message}`),
    );
  }
  return result.data;
})();

/**
 * Detecção de ambiente serverless.
 *
 * Importa porque três garantias do sistema dependem de um processo único e de
 * longa duração: o agendador (`setTimeout`), o mutex de swap e o guard de
 * concorrência por ordem. Nenhuma delas sobrevive a N instâncias efêmeras.
 */
const isServerless =
  process.env.VERCEL === '1' ||
  process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
  process.env.FUNCTIONS_WORKER_RUNTIME !== undefined;

/** Mint nativo do SOL empacotado — output do swap no Jupiter. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const TOTAL_BPS = BPS_TOTAL;

/** Override explícito vence a detecção; sem override, serverless => desligada. */
const allowPipeline =
  env.ALLOW_PIPELINE === undefined || env.ALLOW_PIPELINE === ''
    ? !isServerless
    : /^(1|true|yes|on)$/i.test(env.ALLOW_PIPELINE);

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isServerless,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,

  solana: {
    rpcEndpoint: env.RPC_ENDPOINT,
    sendEndpoint: env.RPC_SEND_ENDPOINT || env.RPC_ENDPOINT,
    vaultKeypair,
    vaultPublicKey: vaultKeypair.publicKey,
  },

  fiat: {
    provider: env.FIAT_PROVIDER,
    webhookSecret: env.FIAT_PROVIDER_SECRET,
    toleranceSeconds: env.WEBHOOK_TOLERANCE_SECONDS,
  },

  admin: {
    apiKey: env.ADMIN_API_KEY,
    ...(env.CRON_SECRET !== undefined ? { cronSecret: env.CRON_SECRET } : { cronSecret: '' }),
  },

  swap: {
    jupiterBase: env.JUPITER_API_BASE,
    inputMint: env.INPUT_MINT,
    inputMintDecimals: env.INPUT_MINT_DECIMALS,
    outputMint: SOL_MINT,
    slippageBps: env.SLIPPAGE_BPS,
    priorityFeeMicroLamports: env.PRIORITY_FEE_MICRO_LAMPORTS,
    maxPriceImpactBps: env.MAX_PRICE_IMPACT_BPS,
  },

  distribution: {
    /** Seed only: a fonte de verdade é a tabela `Recipient`. */
    recipientsSeed: recipientsSeed.map((r, i) => ({
      label: r.label ?? `recipient-${i + 1}`,
      address: r.address,
      bps: r.bps,
    })),
    feeReserveLamports: BigInt(env.FEE_RESERVE_LAMPORTS),
    minTransferLamports: BigInt(env.MIN_TRANSFER_LAMPORTS),
    maxTransfersPerTx: env.MAX_TRANSFERS_PER_TX,
  },

  runtime: {
    maxAttempts: env.MAX_ATTEMPTS,
    depositWaitTimeoutMs: env.DEPOSIT_WAIT_TIMEOUT_MS,
    maxOrderInputRaw: BigInt(env.MAX_ORDER_INPUT_RAW),
    /** Quando false, nenhuma etapa que move dinheiro executa. */
    allowPipeline,
  },

  feeProviders: {
    cacheTtlMs: env.FEE_CACHE_TTL_MS,
    moonpay: {
      enabled: env.MOONPAY_ENABLED,
      apiKey: env.MOONPAY_API_KEY ?? '',
      base: env.MOONPAY_API_BASE,
    },
    transak: {
      enabled: env.TRANSAK_ENABLED,
      apiKey: env.TRANSAK_API_KEY ?? '',
      base: env.TRANSAK_API_BASE,
    },
    ramp: {
      enabled: env.RAMP_ENABLED,
      apiKey: env.RAMP_API_KEY ?? '',
      base: env.RAMP_API_BASE,
    },
    spherepay: {
      enabled: env.SPHEREPAY_ENABLED,
      apiKey: env.SPHEREPAY_API_KEY ?? '',
      base: env.SPHEREPAY_API_BASE,
    },
  },
} as const;

export type AppConfig = typeof config;
