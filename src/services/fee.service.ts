import axios from 'axios';
import { Prisma } from '@prisma/client';
import { config, TOTAL_BPS } from '../config';
import { prisma } from '../database/client';
import {
  GatewayError,
  type EffectiveFee,
  type FeeComparison,
  type FeeProviderName,
  type FiatCurrency,
  type ProviderFeeQuote,
} from '../types';
import { logger } from '../utils/logger';
import { getSettings } from './settings.service';

/**
 * Agregador de taxas dos on-ramps.
 *
 * Objetivo: consultar os provedores em tempo real, eleger o mais barato e usar
 * esse custo como base da taxa cobrada ao cliente (custo + margem). Provedor
 * mais barato = mais margem retida, sem mexer no preço final.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AVISO — ADAPTERS NÃO VERIFICADOS
 *
 * Nenhum destes adapters foi executado contra a API real: o projeto não tem
 * chaves de provedor. Os endpoints e o formato de resposta abaixo refletem a
 * documentação pública de cada um, mas **precisam ser confirmados** antes de
 * confiar no número em produção. Por isso:
 *
 *   • todos os adapters vêm DESABILITADOS por default (`*_ENABLED=false`);
 *   • cada cotação carrega `unverified: true`;
 *   • falha de adapter nunca derruba um pagamento — cai no fallback.
 *
 * Ao plugar uma chave, compare o `costBps` calculado aqui com o extrato real
 * do provedor antes de remover a flag `unverified` do adapter correspondente.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Sobre o roteamento: a escolha do provedor acontece no CHECKOUT, quando o
 * cliente inicia a compra — não depois do fato. É por isso que existe o
 * endpoint público `GET /quote`: o frontend consulta, recebe o melhor provedor
 * e direciona o cliente para ele. O webhook depois apenas registra o custo que
 * valia naquele instante.
 */

const log = logger.child({ scope: 'fees' });

const http = axios.create({
  timeout: 8_000,
  headers: { Accept: 'application/json' },
  // Nunca lançar por status: cada adapter decide o que fazer.
  validateStatus: () => true,
});

interface AdapterContext {
  fiatCurrency: FiatCurrency;
  /** Valor fiat em unidades humanas (ex.: 100.00). */
  fiatAmount: number;
}

type Adapter = (ctx: AdapterContext) => Promise<ProviderFeeQuote>;

function bpsFrom(fee: number, base: number): number {
  if (!Number.isFinite(fee) || !Number.isFinite(base) || base <= 0) return Number.NaN;
  return Math.round((fee / base) * TOTAL_BPS);
}

function unavailable(provider: FeeProviderName, error: string): ProviderFeeQuote {
  return { provider, costBps: Number.NaN, rawFeeAmount: null, available: false, error, unverified: true };
}

function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

// ─────────────────────────────── Adapters ───────────────────────────────

/**
 * MoonPay — GET /v3/currencies/sol/buy_quote
 * Custo = feeAmount + extraFeeAmount + networkFeeAmount, sobre baseCurrencyAmount.
 * A `apiKey` publicável (pk_live_/pk_test_) é suficiente para cotação.
 *
 * Endpoint CONFIRMADO existente (responde 401 "Not authorized" com chave
 * inválida, não 404). O formato da resposta é que segue não verificado.
 */
const moonpayAdapter: Adapter = async ({ fiatCurrency, fiatAmount }) => {
  const cfg = config.feeProviders.moonpay;
  if (!cfg.apiKey) return unavailable('moonpay', 'MOONPAY_API_KEY ausente');

  const res = await http.get(`${cfg.base}/v3/currencies/sol/buy_quote`, {
    params: {
      apiKey: cfg.apiKey,
      baseCurrencyCode: fiatCurrency.toLowerCase(),
      baseCurrencyAmount: fiatAmount,
      fixed: true,
    },
  });
  if (res.status >= 400) {
    return unavailable('moonpay', `HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 160)}`);
  }

  const d = res.data as Record<string, unknown>;
  const base = num(d.baseCurrencyAmount) || fiatAmount;
  const fee = num(d.feeAmount) + (num(d.extraFeeAmount) || 0) + (num(d.networkFeeAmount) || 0);
  const costBps = bpsFrom(fee, base);
  if (!Number.isFinite(costBps)) {
    return unavailable('moonpay', `resposta sem campos de fee reconhecíveis`);
  }

  return {
    provider: 'moonpay',
    costBps,
    rawFeeAmount: String(fee),
    available: true,
    unverified: true,
  };
};

/**
 * Transak — GET /api/v2/currencies/price
 * Custo = response.totalFee sobre fiatAmount.
 */
const transakAdapter: Adapter = async ({ fiatCurrency, fiatAmount }) => {
  const cfg = config.feeProviders.transak;
  if (!cfg.apiKey) return unavailable('transak', 'TRANSAK_API_KEY ausente');

  const res = await http.get(`${cfg.base}/api/v2/currencies/price`, {
    params: {
      partnerApiKey: cfg.apiKey,
      fiatCurrency,
      cryptoCurrency: 'SOL',
      network: 'solana',
      isBuyOrSell: 'BUY',
      fiatAmount,
      paymentMethod: 'credit_debit_card',
    },
  });
  if (res.status >= 400) {
    return unavailable('transak', `HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 160)}`);
  }

  const payload = (res.data as Record<string, unknown>)?.response as
    | Record<string, unknown>
    | undefined;
  const fee = num(payload?.totalFee);
  const base = num(payload?.fiatAmount) || fiatAmount;
  const costBps = bpsFrom(fee, base);
  if (!Number.isFinite(costBps)) {
    return unavailable('transak', 'resposta sem totalFee reconhecível');
  }

  return {
    provider: 'transak',
    costBps,
    rawFeeAmount: String(fee),
    available: true,
    unverified: true,
  };
};

/**
 * Ramp Network — POST /api/host-api/v3/onramp/quote/all
 *
 * Endpoint CONFIRMADO existente: sem `hostApiKey` responde
 * `400 ValidationException: ["hostApiKey must be a string"]`, o que prova o
 * path e mostra que a chave é obrigatória. O formato da resposta segue não
 * verificado — a leitura abaixo assume um objeto por método de pagamento com
 * `appliedFee`, e usamos CARD_PAYMENT (comparável ao cartão dos outros),
 * caindo no primeiro método que tiver o campo.
 */
const rampAdapter: Adapter = async ({ fiatCurrency, fiatAmount }) => {
  const cfg = config.feeProviders.ramp;
  if (!cfg.apiKey) return unavailable('ramp', 'RAMP_API_KEY (hostApiKey) ausente e obrigatória');

  const res = await http.post(
    `${cfg.base}/api/host-api/v3/onramp/quote/all`,
    {
      fiatCurrency,
      fiatValue: fiatAmount,
      cryptoAssetSymbol: 'SOLANA_SOL',
      hostApiKey: cfg.apiKey,
    },
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (res.status >= 400) {
    return unavailable('ramp', `HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 160)}`);
  }

  const d = res.data as Record<string, unknown>;
  const method =
    (d.CARD_PAYMENT as Record<string, unknown> | undefined) ??
    (Object.values(d).find(
      (v) => v && typeof v === 'object' && 'appliedFee' in (v as Record<string, unknown>),
    ) as Record<string, unknown> | undefined);

  const fee = num(method?.appliedFee ?? method?.baseRampFee);
  const base = num(method?.fiatValue) || fiatAmount;
  const costBps = bpsFrom(fee, base);
  if (!Number.isFinite(costBps)) {
    return unavailable('ramp', 'resposta sem appliedFee reconhecível');
  }

  return { provider: 'ramp', costBps, rawFeeAmount: String(fee), available: true, unverified: true };
};

/**
 * SpherePay — deliberadamente NÃO implementado.
 *
 * Não encontrei endpoint de cotação público e verificável para preencher isto
 * sem inventar. Implemente aqui quando tiver a documentação da sua conta; o
 * contrato é devolver `costBps` sobre o valor fiat. Enquanto isso o provedor
 * simplesmente não entra no ranking.
 */
const spherepayAdapter: Adapter = async () =>
  unavailable(
    'spherepay',
    'adapter não implementado: sem endpoint de cotação público verificável',
  );

const ADAPTERS: Record<FeeProviderName, { adapter: Adapter; enabled: boolean }> = {
  moonpay: { adapter: moonpayAdapter, enabled: config.feeProviders.moonpay.enabled },
  transak: { adapter: transakAdapter, enabled: config.feeProviders.transak.enabled },
  ramp: { adapter: rampAdapter, enabled: config.feeProviders.ramp.enabled },
  spherepay: { adapter: spherepayAdapter, enabled: config.feeProviders.spherepay.enabled },
};

// ─────────────────────────────── Comparação ───────────────────────────────

/**
 * Cache por (moeda, faixa de valor). A taxa dos provedores varia por faixa,
 * então arredondamos o valor para uma faixa em vez de cachear por centavo.
 */
const comparisonCache = new Map<string, { comparison: FeeComparison; at: number }>();

function amountBucket(fiatAmount: number): number {
  if (fiatAmount <= 100) return 100;
  if (fiatAmount <= 500) return 500;
  if (fiatAmount <= 1_000) return 1_000;
  if (fiatAmount <= 5_000) return 5_000;
  return 10_000;
}

/** Coleta as taxas de todos os provedores habilitados e elege a melhor. */
export async function compareProviderFees(
  fiatCurrency: FiatCurrency,
  fiatAmount: number,
  options: { skipCache?: boolean; persist?: boolean } = {},
): Promise<FeeComparison> {
  const { skipCache = false, persist = true } = options;
  const key = `${fiatCurrency}:${amountBucket(fiatAmount)}`;

  if (!skipCache) {
    const hit = comparisonCache.get(key);
    if (hit && Date.now() - hit.at < config.feeProviders.cacheTtlMs) {
      return { ...hit.comparison, fromCache: true };
    }
  }

  const enabled = (Object.keys(ADAPTERS) as FeeProviderName[]).filter(
    (name) => ADAPTERS[name].enabled,
  );

  const quotes: ProviderFeeQuote[] = await Promise.all(
    enabled.map(async (name) => {
      try {
        return await ADAPTERS[name].adapter({ fiatCurrency, fiatAmount });
      } catch (err) {
        return unavailable(name, err instanceof Error ? err.message : String(err));
      }
    }),
  );

  // "Sempre o melhor": menor custo entre os disponíveis.
  const usable = quotes.filter((q) => q.available && Number.isFinite(q.costBps));
  const best = usable.length > 0 ? usable.reduce((a, b) => (b.costBps < a.costBps ? b : a)) : null;

  const comparison: FeeComparison = {
    fiatCurrency,
    fiatAmount: fiatAmount.toFixed(2),
    quotes,
    best,
    usedFallback: best === null,
    collectedAt: new Date().toISOString(),
    fromCache: false,
  };

  comparisonCache.set(key, { comparison, at: Date.now() });

  if (persist && quotes.length > 0) {
    // Histórico de quem estava mais barato e quando — auditoria da escolha.
    await prisma.providerFeeSnapshot
      .createMany({
        data: quotes.map((q) => ({
          provider: q.provider,
          fiatCurrency,
          fiatAmount: new Prisma.Decimal(fiatAmount.toFixed(2)),
          costBps: Number.isFinite(q.costBps) ? q.costBps : 0,
          rawFeeAmount: q.rawFeeAmount,
          available: q.available,
          error: q.error ?? null,
          selected: best !== null && q.provider === best.provider,
        })),
      })
      .catch((err: unknown) => log.warn({ err }, 'falha ao gravar snapshot de taxas'));
  }

  log.info(
    {
      fiatCurrency,
      fiatAmount,
      best: best ? `${best.provider}@${best.costBps}bps` : 'nenhum (fallback)',
      quotes: quotes.map((q) => `${q.provider}=${q.available ? `${q.costBps}bps` : 'off'}`),
    },
    'taxas dos provedores coletadas',
  );

  return comparison;
}

// ─────────────────────────────── Taxa efetiva ───────────────────────────────

/**
 * Taxa cobrada ao cliente = custo do melhor provedor + nossa margem, limitada
 * por minFeeBps/maxFeeBps.
 *
 * O clamp existe para que um provedor devolvendo lixo (ou um adapter com
 * parsing errado) não produza uma taxa absurda para o cliente nem uma margem
 * negativa para nós.
 */
export async function resolveEffectiveFee(
  fiatCurrency: FiatCurrency,
  fiatAmount: number,
): Promise<EffectiveFee> {
  const settings = await getSettings();
  const comparison = await compareProviderFees(fiatCurrency, fiatAmount);

  const providerCostBps = comparison.best?.costBps ?? settings.fallbackProviderCostBps;
  const sourceProvider: EffectiveFee['sourceProvider'] = comparison.best?.provider ?? 'fallback';

  const raw = providerCostBps + settings.marginBps;
  const feeBps = Math.min(Math.max(raw, settings.minFeeBps), settings.maxFeeBps);

  if (feeBps >= TOTAL_BPS) {
    throw new GatewayError(
      `taxa efetiva de ${feeBps}bps é >= 100% — configuração inválida`,
      'INVALID_FEE',
      false,
    );
  }

  return {
    providerCostBps,
    marginBps: settings.marginBps,
    feeBps,
    sourceProvider,
    clamped: feeBps !== raw,
  };
}

/** Snapshots recentes para o painel do admin. */
export async function recentFeeSnapshots(limit = 40): Promise<
  Array<{
    provider: string;
    fiatCurrency: string;
    fiatAmount: string;
    costBps: number;
    available: boolean;
    selected: boolean;
    error: string | null;
    collectedAt: string;
  }>
> {
  const rows = await prisma.providerFeeSnapshot.findMany({
    orderBy: { collectedAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    provider: r.provider,
    fiatCurrency: r.fiatCurrency,
    fiatAmount: r.fiatAmount.toString(),
    costBps: r.costBps,
    available: r.available,
    selected: r.selected,
    error: r.error,
    collectedAt: r.collectedAt.toISOString(),
  }));
}

/** Status dos adapters para o painel — deixa explícito o que está ligado. */
export function adapterStatus(): Array<{
  provider: FeeProviderName;
  enabled: boolean;
  hasApiKey: boolean;
  implemented: boolean;
  unverified: boolean;
}> {
  return [
    {
      provider: 'moonpay',
      enabled: config.feeProviders.moonpay.enabled,
      hasApiKey: config.feeProviders.moonpay.apiKey !== '',
      implemented: true,
      unverified: true,
    },
    {
      provider: 'transak',
      enabled: config.feeProviders.transak.enabled,
      hasApiKey: config.feeProviders.transak.apiKey !== '',
      implemented: true,
      unverified: true,
    },
    {
      provider: 'ramp',
      enabled: config.feeProviders.ramp.enabled,
      hasApiKey: config.feeProviders.ramp.apiKey !== '',
      implemented: true,
      unverified: true,
    },
    {
      provider: 'spherepay',
      enabled: config.feeProviders.spherepay.enabled,
      hasApiKey: config.feeProviders.spherepay.apiKey !== '',
      implemented: false,
      unverified: true,
    },
  ];
}
