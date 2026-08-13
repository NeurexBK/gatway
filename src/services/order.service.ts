import { Prisma, type Order } from '@prisma/client';
import { config, TOTAL_BPS } from '../config';
import { prisma } from '../database/client';
import {
  GatewayError,
  OrderStatus,
  type FiatCurrency,
  type NormalizedFiatEvent,
} from '../types';
import { orderLogger, logger } from '../utils/logger';
import { sendLamports } from './distribution.service';
import { resolveEffectiveFee } from './fee.service';
import { swapToSol } from './jupiter.service';
import { getTokenBalanceRaw, waitForTokenBalance } from './solana.service';

/**
 * Orquestrador da pipeline (modelo BROKER):
 *
 *   fiat pago -> USDC no vault -> swap para SOL -> cliente recebe (SOL - taxa)
 *   -> a taxa fica retida no vault como lucro -> distribuída no horário fixo
 *      pelo `payout.service` (não aqui).
 *
 * Sobre "atomicidade": swap e liquidação são transações Solana distintas — não
 * existe atomicidade real entre elas (nem entre elas e o fiat, que vive fora
 * da chain). O que existe aqui é o equivalente prático e auditável:
 *
 *   • idempotência na borda      — `providerEventId` é UNIQUE;
 *   • estado durável por etapa   — cada transição é gravada ANTES da próxima;
 *   • reserva de depósito        — duas ordens nunca gastam o mesmo USDC.
 */

const log = logger.child({ scope: 'orders' });

/** Guarda contra processamento concorrente da MESMA ordem. */
const inFlight = new Set<string>();

/**
 * Serializa os swaps do processo inteiro.
 *
 * Sem isto, duas ordens concorrentes leem o mesmo saldo de USDC do vault,
 * ambas se julgam cobertas e ambas fazem swap — a segunda gastando dinheiro
 * que pertence à primeira. O mutex torna a sequência "verificar saldo não
 * reservado -> swapar" indivisível dentro do processo.
 *
 * Limitação conhecida: é in-process. Com mais de uma instância, isto precisa
 * virar lock no banco (advisory lock no Postgres).
 */
let swapChain: Promise<unknown> = Promise.resolve();
function withSwapLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = swapChain.then(fn, fn);
  // A cadeia ignora o resultado (e o erro) para não travar as próximas ordens.
  swapChain = result.catch(() => undefined);
  return result;
}

// ─────────────────────────── Criação (idempotente) ───────────────────────────

export interface CreateOrderResult {
  order: Order;
  /** false quando o evento já havia sido processado antes. */
  created: boolean;
}

export async function createOrderFromEvent(
  event: NormalizedFiatEvent,
): Promise<CreateOrderResult> {
  const existing = await prisma.order.findUnique({ where: { providerEventId: event.eventId } });
  if (existing) {
    log.info(
      { orderId: existing.id, eventId: event.eventId, status: existing.status },
      'evento já conhecido — ignorando (idempotência)',
    );
    return { order: existing, created: false };
  }

  if (event.customerWallet === null) {
    throw new GatewayError(
      'evento sem carteira do cliente — impossível liquidar',
      'MISSING_CUSTOMER_WALLET',
      false,
    );
  }
  if (event.cryptoAmountRaw > config.runtime.maxOrderInputRaw) {
    // Teto por ordem: limita o dano de um evento forjado ou de um bug de parsing.
    throw new GatewayError(
      `valor da ordem (${event.cryptoAmountRaw}) excede MAX_ORDER_INPUT_RAW ` +
        `(${config.runtime.maxOrderInputRaw})`,
      'ORDER_ABOVE_LIMIT',
      false,
    );
  }

  // Taxa em tempo real: custo do melhor on-ramp + margem, snapshot na ordem.
  const fee = await resolveEffectiveFee(
    event.fiatCurrency as FiatCurrency,
    Number(event.fiatAmount),
  );

  try {
    const order = await prisma.order.create({
      data: {
        provider: event.provider,
        providerEventId: event.eventId,
        providerPaymentId: event.paymentId,
        customerRef: event.customerRef,
        fiatCurrency: event.fiatCurrency,
        fiatAmount: new Prisma.Decimal(event.fiatAmount),
        inputMint: event.cryptoMint,
        inputAmountRaw: event.cryptoAmountRaw,
        depositSignature: event.depositSignature,
        customerWallet: event.customerWallet,
        providerCostBps: fee.providerCostBps,
        marginBps: fee.marginBps,
        feeBps: fee.feeBps,
        feeSourceProvider: fee.sourceProvider,
        status: OrderStatus.PENDING,
      },
    });
    log.info(
      {
        orderId: order.id,
        eventId: event.eventId,
        fiat: `${event.fiatAmount} ${event.fiatCurrency}`,
        customerWallet: event.customerWallet,
        feeBps: fee.feeBps,
        feeSource: fee.sourceProvider,
      },
      'ordem criada',
    );
    return { order, created: true };
  } catch (err) {
    // Corrida entre duas entregas simultâneas do mesmo evento: o UNIQUE
    // resolve, e nós devolvemos a ordem que ganhou.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.order.findUnique({
        where: { providerEventId: event.eventId },
      });
      if (winner) return { order: winner, created: false };
    }
    throw err;
  }
}

// ─────────────────────────── Reserva de depósito ───────────────────────────

/**
 * Soma o que está prometido a ordens MAIS ANTIGAS ainda não swapadas.
 *
 * O saldo de USDC do vault é um pote comum: on-chain não há como saber qual
 * depósito pertence a qual ordem. A atribuição é então FIFO — quem chegou
 * primeiro tem direito ao dinheiro que já aterrou.
 *
 * Contar *todas* as outras ordens (e não só as anteriores) seria errado no
 * outro sentido: bloquearia a ordem mais antiga, que é justamente a dona
 * legítima do saldo presente, criando um impasse enquanto uma ordem mais nova
 * espera o próprio depósito.
 */
export async function committedInputRaw(
  mint: string,
  order: { id: string; createdAt: Date },
): Promise<bigint> {
  const rows = await prisma.order.findMany({
    where: {
      inputMint: mint,
      swapSignature: null,
      status: { in: [OrderStatus.PENDING, OrderStatus.PROCESSING] },
      // Estritamente anteriores; o id desempata timestamps idênticos.
      OR: [
        { createdAt: { lt: order.createdAt } },
        { createdAt: order.createdAt, id: { lt: order.id } },
      ],
    },
    select: { inputAmountRaw: true },
  });
  return rows.reduce((acc, r) => acc + r.inputAmountRaw, 0n);
}

async function assertDepositIsUnreserved(order: Order): Promise<void> {
  const balance = await getTokenBalanceRaw(order.inputMint);
  const committed = await committedInputRaw(order.inputMint, order);
  const available = balance > committed ? balance - committed : 0n;

  if (available < order.inputAmountRaw) {
    throw new GatewayError(
      `depósito não coberto: saldo=${balance}, comprometido com ordens anteriores=${committed}, ` +
        `disponível=${available}, necessário=${order.inputAmountRaw}`,
      'DEPOSIT_NOT_COVERED',
      true,
      {
        balance: balance.toString(),
        committed: committed.toString(),
        required: order.inputAmountRaw.toString(),
      },
    );
  }
}

// ─────────────────────────── Etapas da pipeline ───────────────────────────

async function stepSwap(order: Order): Promise<Order> {
  const olog = orderLogger(order.id, { step: 'swap' });

  // O webhook confirma o fiat; o settlement on-chain pode aterrar depois.
  olog.info({ inputAmountRaw: order.inputAmountRaw.toString() }, 'aguardando depósito no vault');
  await waitForTokenBalance(order.inputMint, order.inputAmountRaw);

  const result = await withSwapLock(async () => {
    // Verificação e swap sob o mesmo lock: entre uma e outra ninguém mais
    // pode consumir o saldo.
    await assertDepositIsUnreserved(order);
    olog.info('depósito confirmado e não reservado — swapando');
    return swapToSol(order.inputAmountRaw, { orderId: order.id });
  });

  return prisma.order.update({
    where: { id: order.id },
    data: {
      status: OrderStatus.SWAPPED,
      swapSignature: result.signature,
      solReceivedLamports: result.lamportsReceived,
      quotedOutLamports: result.quotedOutLamports,
      priceImpactPct: result.priceImpactPct,
      swappedAt: new Date(),
      lastError: null,
    },
  });
}

/**
 * Liquidação do cliente: ele recebe o SOL menos a taxa; a taxa fica no vault.
 *
 * O rateio usa o **delta real de lamports** do swap, não o valor cotado — a
 * slippage e a fee do swap ficam do lado do cliente na mesma proporção da
 * cotação que ele aceitou no checkout, e a nossa margem não é corroída por
 * variação de mercado.
 */
async function stepSettleCustomer(order: Order): Promise<Order> {
  const olog = orderLogger(order.id, { step: 'settle' });

  if (order.solReceivedLamports === null || order.feeBps === null) {
    throw new GatewayError(
      'ordem em SWAPPED sem solReceivedLamports/feeBps — estado inconsistente',
      'INCONSISTENT_STATE',
      false,
    );
  }

  const total = order.solReceivedLamports;
  // Fixa o valor do cliente na primeira passagem; um retry reusa o mesmo
  // número para não pagar diferente do que foi contabilizado.
  const customerLamports =
    order.customerLamports ?? (total * BigInt(TOTAL_BPS - order.feeBps)) / BigInt(TOTAL_BPS);
  const profitLamports = total - customerLamports;

  if (order.customerLamports === null) {
    await prisma.order.update({
      where: { id: order.id },
      data: { customerLamports, profitLamports },
    });
  }

  // Idempotência da transferência: se já houver assinatura, não reenvia.
  let signature = order.customerPayoutSignature;
  if (signature === null) {
    signature = await sendLamports(order.customerWallet, customerLamports, {
      orderId: order.id,
      step: 'settle',
    });
    olog.info(
      {
        signature,
        customerSol: Number(customerLamports) / 1e9,
        profitSol: Number(profitLamports) / 1e9,
        feeBps: order.feeBps,
      },
      'cliente liquidado',
    );
  }

  return prisma.order.update({
    where: { id: order.id },
    data: {
      status: OrderStatus.SETTLED,
      customerPayoutSignature: signature,
      customerLamports,
      profitLamports,
      settledAt: new Date(),
      lastError: null,
    },
  });
}

// ─────────────────── Loop da máquina de estados ───────────────────

async function markFailed(orderId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof GatewayError ? err.code : 'UNKNOWN';
  await prisma.order.update({
    where: { id: orderId },
    data: { status: OrderStatus.FAILED, lastError: `[${code}] ${message}`.slice(0, 1_000) },
  });
  orderLogger(orderId).error({ code, err: message }, 'ordem marcada como FAILED');
}

/**
 * Executa a ordem até a liquidação do cliente. Chamada em background pelo
 * webhook (o provedor recebe 202 imediatamente).
 *
 * A distribuição do lucro NÃO acontece aqui — ela é agendada.
 */
export async function processOrder(orderId: string): Promise<void> {
  if (inFlight.has(orderId)) {
    log.debug({ orderId }, 'ordem já em processamento — ignorando chamada concorrente');
    return;
  }
  inFlight.add(orderId);
  const olog = orderLogger(orderId);

  try {
    let order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    if (order.status === OrderStatus.SETTLED || order.status === OrderStatus.DISTRIBUTED) {
      olog.debug({ status: order.status }, 'ordem já liquidada — nada a fazer');
      return;
    }
    if (order.attempts >= config.runtime.maxAttempts) {
      throw new GatewayError(
        `tentativas esgotadas (${order.attempts}/${config.runtime.maxAttempts})`,
        'MAX_ATTEMPTS_EXCEEDED',
        false,
      );
    }

    order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: order.status === OrderStatus.SWAPPED ? OrderStatus.SWAPPED : OrderStatus.PROCESSING,
        attempts: { increment: 1 },
      },
    });

    if (order.status !== OrderStatus.SWAPPED) {
      order = await stepSwap(order);
    }
    order = await stepSettleCustomer(order);

    olog.info(
      {
        swapSignature: order.swapSignature,
        customerPayoutSignature: order.customerPayoutSignature,
        profitSol: order.profitLamports ? Number(order.profitLamports) / 1e9 : null,
      },
      'ordem liquidada — lucro acumulado para a próxima distribuição',
    );
  } catch (err) {
    const retryable = err instanceof GatewayError ? err.retryable : true;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    const attempts = order?.attempts ?? config.runtime.maxAttempts;

    if (!retryable || attempts >= config.runtime.maxAttempts) {
      await markFailed(orderId, err);
      return;
    }

    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: order?.status === OrderStatus.SWAPPED ? OrderStatus.SWAPPED : OrderStatus.PENDING,
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 1_000),
      },
    });
    orderLogger(orderId).warn(
      { err: err instanceof Error ? err.message : String(err), attempts },
      'etapa falhou — ordem devolvida para retomada',
    );
  } finally {
    inFlight.delete(orderId);
  }
}

/**
 * Retomada de ordens inacabadas. Roda no boot e periodicamente.
 *
 * `PROCESSING` sem `swapSignature` é o caso delicado: o processo pode ter
 * morrido com um swap em voo. Só retomamos se a stablecoin ainda estiver
 * disponível no vault; caso contrário exigimos revisão manual em vez de
 * arriscar um segundo swap.
 */
export async function retryPendingOrders(): Promise<void> {
  const orders = await prisma.order.findMany({
    where: {
      status: { in: [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.SWAPPED] },
      attempts: { lt: config.runtime.maxAttempts },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  if (orders.length === 0) return;
  log.info({ count: orders.length }, 'retomando ordens inacabadas');

  for (const order of orders) {
    if (order.status === OrderStatus.PROCESSING && order.swapSignature === null) {
      const tokenBalance = await getTokenBalanceRaw(order.inputMint).catch(() => 0n);
      if (tokenBalance < order.inputAmountRaw) {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.FAILED,
            lastError:
              'NEEDS_MANUAL_REVIEW: processo interrompido com swap possivelmente em voo e ' +
              'sem stablecoin suficiente no vault. Verifique o histórico on-chain do vault ' +
              'antes de reprocessar.',
          },
        });
        orderLogger(order.id).error('retomada bloqueada — requer revisão manual');
        continue;
      }
    }
    await processOrder(order.id);
  }
}

// ─────────────────────────── Consultas ───────────────────────────

/** Snapshot de contagem por status — usado pelo /health e pelo admin. */
export async function getOrderStats(): Promise<Record<string, number>> {
  const grouped = await prisma.order.groupBy({ by: ['status'], _count: { _all: true } });
  const stats: Record<string, number> = {
    PENDING: 0,
    PROCESSING: 0,
    SWAPPED: 0,
    SETTLED: 0,
    DISTRIBUTED: 0,
    FAILED: 0,
  };
  for (const row of grouped) stats[row.status] = row._count._all;
  return stats;
}

/** Lucro contabilizado e ainda não distribuído. */
export async function getAccruedProfit(): Promise<{ lamports: bigint; orderCount: number }> {
  const rows = await prisma.order.findMany({
    where: { status: OrderStatus.SETTLED, payoutRunId: null },
    select: { profitLamports: true },
  });
  return {
    lamports: rows.reduce((acc, r) => acc + (r.profitLamports ?? 0n), 0n),
    orderCount: rows.length,
  };
}
