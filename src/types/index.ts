/** Interfaces globais do gateway. */

// ─────────────────────────── Máquina de estados ───────────────────────────

export const OrderStatus = {
  /** Webhook aceito e persistido. Nada on-chain ainda. */
  PENDING: 'PENDING',
  /** Pipeline em execução (deposit check / swap em voo). */
  PROCESSING: 'PROCESSING',
  /** Swap confirmado: o SOL desta ordem está no vault. */
  SWAPPED: 'SWAPPED',
  /** Cliente já recebeu a parte dele; o lucro está retido no vault. */
  SETTLED: 'SETTLED',
  /** O lucro desta ordem entrou num PayoutRun concluído. Estado final. */
  DISTRIBUTED: 'DISTRIBUTED',
  /** Esgotou tentativas ou erro irrecuperável. Exige intervenção. */
  FAILED: 'FAILED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const PayoutRunStatus = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  /** Parte dos lotes foi paga; retomável. */
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  /** Nada a distribuir ou abaixo do mínimo — não é erro. */
  SKIPPED: 'SKIPPED',
} as const;

export type PayoutRunStatus = (typeof PayoutRunStatus)[keyof typeof PayoutRunStatus];

export const PayoutStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
} as const;

export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

export const FiatCurrency = {
  EUR: 'EUR',
  USD: 'USD',
  BRL: 'BRL',
} as const;

export type FiatCurrency = (typeof FiatCurrency)[keyof typeof FiatCurrency];

export const SUPPORTED_CURRENCIES: readonly FiatCurrency[] = [
  FiatCurrency.EUR,
  FiatCurrency.USD,
  FiatCurrency.BRL,
];

// ─────────────────────────── Webhook (fiat) ───────────────────────────

/**
 * Forma normalizada de um evento de pagamento, independente do provedor.
 * Os adapters (SpherePay / MoonPay) traduzem para cá.
 */
export interface NormalizedFiatEvent {
  provider: 'spherepay' | 'moonpay';
  /** Chave de idempotência: id do evento no provedor. */
  eventId: string;
  /** Tipo já normalizado. Só `payment.completed` dispara a pipeline. */
  type: 'payment.completed' | 'payment.failed' | 'payment.pending' | 'unknown';
  paymentId: string | null;
  customerRef: string | null;
  fiatCurrency: FiatCurrency;
  fiatAmount: string;
  /** Base units do stablecoin creditado (USDC 6 decimais). */
  cryptoAmountRaw: bigint;
  cryptoMint: string;
  /**
   * Carteira do CLIENTE — destino do SOL menos a taxa (modelo broker).
   * Obrigatória: sem ela não há como liquidar a ordem.
   */
  customerWallet: string | null;
  /** Assinatura da tx de settlement do on-ramp, se o provedor já a conhece. */
  depositSignature: string | null;
  rawType: string;
}

export interface SignatureVerification {
  valid: boolean;
  reason?: string;
  timestamp?: number;
}

/** Body do Express com o buffer cru preservado (necessário para o HMAC). */
export interface RawBodyRequest {
  rawBody?: Buffer;
}

// ─────────────────────────── Jupiter v6 ───────────────────────────

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRoutePlanStep[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface JupiterRoutePlanStep {
  swapInfo: {
    ammKey: string;
    label?: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface JupiterSwapResponse {
  /** VersionedTransaction serializada em base64, ainda não assinada. */
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
}

export interface SwapResult {
  signature: string;
  /** Delta real de lamports no vault (o que importa para o rateio). */
  lamportsReceived: bigint;
  quotedOutLamports: bigint;
  priceImpactPct: string;
}

// ─────────────────────── Taxas dos on-ramps ───────────────────────

export type FeeProviderName = 'moonpay' | 'transak' | 'ramp' | 'spherepay';

/** Cotação de custo de um on-ramp para um par (moeda, valor). */
export interface ProviderFeeQuote {
  provider: FeeProviderName;
  /** Custo total do provedor em bps sobre o valor fiat. */
  costBps: number;
  /** Custo bruto reportado pelo provedor, para auditoria. */
  rawFeeAmount: string | null;
  available: boolean;
  error?: string;
  /** true quando o adapter nunca foi validado contra a API real. */
  unverified: boolean;
}

export interface FeeComparison {
  fiatCurrency: FiatCurrency;
  fiatAmount: string;
  quotes: ProviderFeeQuote[];
  /** O mais barato disponível — a escolha "sempre o melhor". */
  best: ProviderFeeQuote | null;
  /** true quando nenhum provedor respondeu e usamos o fallback. */
  usedFallback: boolean;
  collectedAt: string;
  fromCache: boolean;
}

/** Taxa efetiva aplicada a uma operação. */
export interface EffectiveFee {
  providerCostBps: number;
  marginBps: number;
  /** providerCostBps + marginBps, limitado por minFeeBps/maxFeeBps. */
  feeBps: number;
  sourceProvider: FeeProviderName | 'fallback';
  clamped: boolean;
}

// ─────────────────────────── Distribuição ───────────────────────────

export interface RecipientConfig {
  label: string;
  address: string;
  bps: number;
}

/** Resultado do cálculo do split: soma dos lamports === total, sempre. */
export interface SplitAllocation extends RecipientConfig {
  lamports: bigint;
  /** true no destinatário que absorveu o resto da divisão inteira. */
  absorbedRemainder: boolean;
}

export interface DistributionBatchResult {
  batchIndex: number;
  signature: string;
  addresses: string[];
  lamports: bigint;
}

export interface DistributionResult {
  totalDistributedLamports: bigint;
  batches: DistributionBatchResult[];
  allocations: SplitAllocation[];
}

// ─────────────────────────── Settings (admin) ───────────────────────────

export interface GatewaySettingsView {
  distributionEnabled: boolean;
  distributionHour: number;
  distributionMinute: number;
  distributionTimezone: string;
  minProfitLamports: string;
  marginBps: number;
  minFeeBps: number;
  maxFeeBps: number;
  fallbackProviderCostBps: number;
  /** Próximo disparo calculado, em ISO UTC. */
  nextRunAt: string;
  updatedAt: string;
}

// ─────────────────────────── Erros ───────────────────────────

/**
 * Erro de domínio com semântica de retry: `retryable=false` manda a ordem
 * direto para FAILED em vez de queimar tentativas.
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean = true,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
