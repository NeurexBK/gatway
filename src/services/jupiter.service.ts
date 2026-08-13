import axios, { AxiosError, type AxiosInstance } from 'axios';
import { VersionedTransaction } from '@solana/web3.js';
import { config } from '../config';
import {
  GatewayError,
  type JupiterQuoteResponse,
  type JupiterSwapResponse,
  type SwapResult,
} from '../types';
import { logger } from '../utils/logger';
import { getBalance, getVaultPublicKey, sendSignedTransaction, signWithVault } from './solana.service';

/**
 * Integração com o Jupiter Aggregator v6 (stablecoin -> SOL nativo).
 *
 * Fluxo: GET /quote (rota + cotação) -> POST /swap (tx v0 pronta, não assinada)
 * -> assinar com o vault -> broadcast. `wrapAndUnwrapSol: true` faz o Jupiter
 * fechar a wSOL no fim, então o vault recebe SOL nativo — que é o que o
 * SystemProgram.transfer da distribuição precisa.
 */

const log = logger.child({ scope: 'jupiter' });

const http: AxiosInstance = axios.create({
  baseURL: config.swap.jupiterBase,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describeAxiosError(err: unknown): { message: string; status?: number; body?: unknown } {
  if (axios.isAxiosError(err)) {
    const axErr = err as AxiosError<unknown>;
    return {
      message: axErr.message,
      ...(axErr.response ? { status: axErr.response.status, body: axErr.response.data } : {}),
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

/** 429 e 5xx são transitórios; 4xx restantes indicam pedido inválido. */
function isTransient(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const info = describeAxiosError(err);
      if (!isTransient(info.status) || i === attempts) break;
      const backoff = 500 * 2 ** (i - 1);
      log.warn({ ...info, attempt: i, backoff }, `${label} falhou, tentando de novo`);
      await sleep(backoff);
    }
  }
  const info = describeAxiosError(last);
  throw new GatewayError(
    `Jupiter ${label} falhou: ${info.message}`,
    'JUPITER_REQUEST_FAILED',
    isTransient(info.status),
    info,
  );
}

// ─────────────────────────────── Cotação ───────────────────────────────

/**
 * Cotação de `amountRaw` (base units do mint de entrada) para SOL.
 * `restrictIntermediateTokens` reduz rotas exóticas com pool raso — menos
 * price impact surpresa e menos falha de execução.
 */
export async function getQuote(amountRaw: bigint): Promise<JupiterQuoteResponse> {
  if (amountRaw <= 0n) {
    throw new GatewayError('valor de swap deve ser positivo', 'INVALID_SWAP_AMOUNT', false);
  }

  const quote = await withRetry('quote', async () => {
    const { data } = await http.get<JupiterQuoteResponse>('/quote', {
      params: {
        inputMint: config.swap.inputMint,
        outputMint: config.swap.outputMint,
        amount: amountRaw.toString(),
        slippageBps: config.swap.slippageBps,
        swapMode: 'ExactIn',
        onlyDirectRoutes: false,
        restrictIntermediateTokens: true,
      },
    });
    return data;
  });

  if (!quote?.outAmount || BigInt(quote.outAmount) <= 0n) {
    throw new GatewayError('Jupiter devolveu cotação sem rota utilizável', 'NO_ROUTE', true, quote);
  }

  // Proteção contra pool raso / sandwich: acima do teto, não executa. É
  // retryable de propósito — o mercado pode normalizar na próxima tentativa.
  const impactBps = Math.round(Math.abs(Number(quote.priceImpactPct ?? '0')) * 10_000);
  if (Number.isFinite(impactBps) && impactBps > config.swap.maxPriceImpactBps) {
    throw new GatewayError(
      `price impact de ${impactBps}bps excede o teto de ${config.swap.maxPriceImpactBps}bps`,
      'PRICE_IMPACT_TOO_HIGH',
      true,
      { priceImpactPct: quote.priceImpactPct, impactBps },
    );
  }

  log.info(
    {
      inAmount: quote.inAmount,
      outAmountLamports: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
      hops: quote.routePlan?.length ?? 0,
      route: quote.routePlan?.map((s) => s.swapInfo.label ?? s.swapInfo.ammKey).join(' > '),
    },
    'cotação obtida',
  );

  return quote;
}

/** Cotação em unidades humanas — útil para o /health e para pré-visualização. */
export async function quoteHuman(amountRaw: bigint): Promise<{
  inAmount: string;
  outSol: number;
  priceImpactPct: string;
}> {
  const quote = await getQuote(amountRaw);
  const divisor = 10 ** config.swap.inputMintDecimals;
  return {
    inAmount: (Number(quote.inAmount) / divisor).toFixed(config.swap.inputMintDecimals),
    outSol: Number(quote.outAmount) / 1e9,
    priceImpactPct: quote.priceImpactPct,
  };
}

// ─────────────────────────────── Execução ───────────────────────────────

async function buildSwapTransaction(
  quote: JupiterQuoteResponse,
): Promise<{ transaction: VersionedTransaction; lastValidBlockHeight: number }> {
  const swap = await withRetry('swap', async () => {
    const { data } = await http.post<JupiterSwapResponse>('/swap', {
      quoteResponse: quote,
      userPublicKey: getVaultPublicKey().toBase58(),
      // Fecha a conta wSOL no fim: o vault fica com SOL nativo.
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports:
        config.swap.priorityFeeMicroLamports > 0
          ? { priorityLevelWithMaxLamports: { priorityLevel: 'high', maxLamports: 5_000_000 } }
          : 0,
    });
    return data;
  });

  if (!swap?.swapTransaction) {
    throw new GatewayError('Jupiter não devolveu swapTransaction', 'SWAP_BUILD_FAILED', true, swap);
  }

  const transaction = VersionedTransaction.deserialize(
    Buffer.from(swap.swapTransaction, 'base64'),
  );

  return { transaction, lastValidBlockHeight: swap.lastValidBlockHeight };
}

/**
 * Executa o swap e devolve o **delta real de lamports do vault** — não o valor
 * cotado. É esse delta (já líquido de fees e slippage) que a distribuição
 * divide, garantindo que nunca se prometa mais SOL do que efetivamente entrou.
 */
export async function swapToSol(
  amountRaw: bigint,
  context: Record<string, unknown> = {},
): Promise<SwapResult> {
  const quote = await getQuote(amountRaw);
  const quotedOutLamports = BigInt(quote.outAmount);

  const balanceBefore = await getBalance();
  const { transaction, lastValidBlockHeight } = await buildSwapTransaction(quote);
  const signed = signWithVault(transaction);

  const signature = await sendSignedTransaction(signed, lastValidBlockHeight, {
    ...context,
    step: 'swap',
  });

  const balanceAfter = await getBalance();
  const lamportsReceived = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;

  if (lamportsReceived === 0n) {
    throw new GatewayError(
      'swap confirmou mas o saldo do vault não aumentou — investigar manualmente',
      'SWAP_NO_BALANCE_DELTA',
      false,
      { signature, balanceBefore: balanceBefore.toString(), balanceAfter: balanceAfter.toString() },
    );
  }

  log.info(
    {
      signature,
      quotedSol: Number(quotedOutLamports) / 1e9,
      receivedSol: Number(lamportsReceived) / 1e9,
      slippageRealPct:
        quotedOutLamports > 0n
          ? (
              (Number(quotedOutLamports - lamportsReceived) / Number(quotedOutLamports)) *
              100
            ).toFixed(4)
          : '0',
    },
    'swap concluído',
  );

  return { signature, lamportsReceived, quotedOutLamports, priceImpactPct: quote.priceImpactPct };
}
