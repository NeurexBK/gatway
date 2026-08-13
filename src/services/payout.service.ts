import type { PayoutRun } from '@prisma/client';
import { prisma } from '../database/client';
import { OrderStatus, PayoutRunStatus, PayoutStatus, type SplitAllocation } from '../types';
import { logger } from '../utils/logger';
import {
  clampToVaultHeadroom,
  computeProfitSplit,
  distribute,
  vaultHeadroomLamports,
} from './distribution.service';
import { getSettings } from './settings.service';

/**
 * Distribuição do lucro acumulado entre os sócios.
 *
 * Roda no horário fixo diário (ou por disparo manual no admin). Um `PayoutRun`
 * registra cada execução; as ordens cujo lucro entrou nela ficam amarradas
 * pelo `payoutRunId`, o que dá duas garantias:
 *
 *   • nenhum lucro é distribuído duas vezes (a ordem sai do pool elegível no
 *     instante em que é vinculada);
 *   • se a execução falhar no meio, as ordens voltam ao pool ou a execução é
 *     retomada — nunca ficam num limbo silencioso.
 */

const log = logger.child({ scope: 'payout' });

/** Uma execução por vez no processo — duas paralelas dividiriam o mesmo saldo. */
let running = false;

export interface RunOptions {
  trigger?: 'SCHEDULED' | 'MANUAL';
  scheduledFor?: Date;
  /** Ignora o mínimo de lucro configurado (usado no disparo manual). */
  ignoreMinimum?: boolean;
}

export interface RunSummary {
  runId: string | null;
  status: PayoutRunStatus;
  totalLamports: string;
  orderCount: number;
  batches: number;
  skipReason?: string;
}

async function persistAllocations(
  runId: string,
  allocations: readonly SplitAllocation[],
): Promise<void> {
  await prisma.$transaction(
    allocations.map((a) =>
      prisma.payout.upsert({
        where: { runId_address: { runId, address: a.address } },
        create: {
          runId,
          label: a.label,
          address: a.address,
          bps: a.bps,
          lamports: a.lamports,
          status: PayoutStatus.PENDING,
        },
        update: { label: a.label, bps: a.bps, lamports: a.lamports },
      }),
    ),
  );
}

/**
 * Executa a distribuição do lucro.
 *
 * Decisão deliberada: se o headroom do vault não cobre o lucro inteiro, a
 * execução é **pulada**, não parcial. Distribuir metade tornaria a
 * contabilidade ambígua (quais ordens foram pagas?) — melhor não mover nada e
 * deixar o motivo registrado para inspeção.
 */
export async function runProfitDistribution(options: RunOptions = {}): Promise<RunSummary> {
  const { trigger = 'SCHEDULED', scheduledFor = new Date(), ignoreMinimum = false } = options;

  if (running) {
    log.warn('distribuição já em execução — ignorando disparo concorrente');
    return {
      runId: null,
      status: PayoutRunStatus.SKIPPED,
      totalLamports: '0',
      orderCount: 0,
      batches: 0,
      skipReason: 'execução concorrente em andamento',
    };
  }
  running = true;

  try {
    const settings = await getSettings();

    // 1) Pool elegível: ordens liquidadas cujo lucro ainda não saiu.
    const eligible = await prisma.order.findMany({
      where: { status: OrderStatus.SETTLED, payoutRunId: null },
      select: { id: true, profitLamports: true },
      orderBy: { settledAt: 'asc' },
    });
    const totalProfit = eligible.reduce((acc, o) => acc + (o.profitLamports ?? 0n), 0n);

    const skip = async (reason: string): Promise<RunSummary> => {
      const run = await prisma.payoutRun.create({
        data: {
          scheduledFor,
          trigger,
          totalLamports: totalProfit,
          orderCount: eligible.length,
          status: PayoutRunStatus.SKIPPED,
          skipReason: reason,
          completedAt: new Date(),
        },
      });
      log.info({ runId: run.id, reason, totalProfit: totalProfit.toString() }, 'distribuição pulada');
      return {
        runId: run.id,
        status: PayoutRunStatus.SKIPPED,
        totalLamports: totalProfit.toString(),
        orderCount: eligible.length,
        batches: 0,
        skipReason: reason,
      };
    };

    if (eligible.length === 0 || totalProfit <= 0n) {
      return skip('nenhum lucro acumulado');
    }
    if (!ignoreMinimum && totalProfit < settings.minProfitLamports) {
      return skip(
        `lucro acumulado (${totalProfit}) abaixo do mínimo configurado ` +
          `(${settings.minProfitLamports}) — acumula para a próxima execução`,
      );
    }

    // 2) O lucro tem de estar efetivamente disponível no vault.
    const recipients = await computeProfitSplit(totalProfit);
    const headroom = await vaultHeadroomLamports(recipients.length);
    if (headroom < totalProfit) {
      return skip(
        `headroom do vault (${headroom}) não cobre o lucro acumulado (${totalProfit}) — ` +
          'verifique a reserva de fee e o saldo do vault',
      );
    }
    const amount = await clampToVaultHeadroom(totalProfit, recipients.length);

    // 3) Cria a execução e VINCULA as ordens antes de mover dinheiro: a partir
    //    daqui elas saem do pool elegível, então um disparo concorrente ou um
    //    retry não distribui o mesmo lucro de novo.
    const run = await prisma.$transaction(async (tx) => {
      const created = await tx.payoutRun.create({
        data: {
          scheduledFor,
          trigger,
          totalLamports: amount,
          orderCount: eligible.length,
          status: PayoutRunStatus.RUNNING,
        },
      });
      await tx.order.updateMany({
        where: { id: { in: eligible.map((o) => o.id) } },
        data: { payoutRunId: created.id },
      });
      return created;
    });

    const allocations = await computeProfitSplit(amount);
    await persistAllocations(run.id, allocations);

    log.info(
      {
        runId: run.id,
        trigger,
        totalSol: Number(amount) / 1e9,
        orders: eligible.length,
        recipients: allocations.length,
      },
      'iniciando distribuição de lucro',
    );

    return await executeRun(run, allocations);
  } catch (err) {
    log.error({ err }, 'distribuição de lucro falhou');
    throw err;
  } finally {
    running = false;
  }
}

/** Envia os lotes de uma execução e fecha o estado (também usado na retomada). */
async function executeRun(
  run: PayoutRun,
  allocations: readonly SplitAllocation[],
): Promise<RunSummary> {
  const alreadySent = await prisma.payout.findMany({
    where: { runId: run.id, status: PayoutStatus.SENT },
    select: { address: true },
  });
  const sent = new Set(alreadySent.map((p) => p.address));
  const pending = allocations.filter((a) => !sent.has(a.address));

  if (sent.size > 0) {
    log.warn({ runId: run.id, alreadySent: sent.size, pending: pending.length }, 'retomando execução parcial');
  }

  try {
    const result =
      pending.length > 0
        ? await distribute(pending, {
            context: { runId: run.id },
            onBatchConfirmed: async (batch) => {
              await prisma.payout.updateMany({
                where: { runId: run.id, address: { in: batch.addresses } },
                data: {
                  status: PayoutStatus.SENT,
                  signature: batch.signature,
                  batchIndex: batch.batchIndex,
                },
              });
            },
          })
        : { batches: [], totalDistributedLamports: 0n, allocations: [] };

    // Tudo pago: fecha a execução e marca as ordens como distribuídas.
    await prisma.$transaction([
      prisma.payoutRun.update({
        where: { id: run.id },
        data: { status: PayoutRunStatus.COMPLETED, completedAt: new Date(), lastError: null },
      }),
      prisma.order.updateMany({
        where: { payoutRunId: run.id },
        data: { status: OrderStatus.DISTRIBUTED, distributedAt: new Date() },
      }),
    ]);

    log.info(
      { runId: run.id, batches: result.batches.length, totalSol: Number(run.totalLamports) / 1e9 },
      'distribuição de lucro concluída',
    );

    return {
      runId: run.id,
      status: PayoutRunStatus.COMPLETED,
      totalLamports: run.totalLamports.toString(),
      orderCount: run.orderCount,
      batches: result.batches.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const anySent = await prisma.payout.count({
      where: { runId: run.id, status: PayoutStatus.SENT },
    });

    if (anySent === 0) {
      // Nada saiu: devolve as ordens ao pool para a próxima execução tentar
      // de novo, e marca a execução como FAILED (sem lucro preso).
      await prisma.$transaction([
        prisma.order.updateMany({ where: { payoutRunId: run.id }, data: { payoutRunId: null } }),
        prisma.payoutRun.update({
          where: { id: run.id },
          data: { status: PayoutRunStatus.FAILED, lastError: message.slice(0, 1_000) },
        }),
      ]);
      log.error({ runId: run.id, err: message }, 'execução falhou sem pagar nada — ordens devolvidas ao pool');
    } else {
      // Parte saiu: NÃO devolve as ordens (evita pagar duas vezes). A execução
      // fica PARTIAL e é retomada no próximo boot ou disparo.
      await prisma.payoutRun.update({
        where: { id: run.id },
        data: { status: PayoutRunStatus.PARTIAL, lastError: message.slice(0, 1_000) },
      });
      log.error(
        { runId: run.id, sentBatches: anySent, err: message },
        'execução parcial — retomável, NÃO redistribuir manualmente',
      );
    }

    throw err;
  }
}

/** Retoma execuções interrompidas (RUNNING/PARTIAL) — chamada no boot. */
export async function resumeIncompleteRuns(): Promise<void> {
  const runs = await prisma.payoutRun.findMany({
    where: { status: { in: [PayoutRunStatus.RUNNING, PayoutRunStatus.PARTIAL] } },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
  if (runs.length === 0) return;

  log.info({ count: runs.length }, 'retomando execuções de distribuição incompletas');

  for (const run of runs) {
    const payouts = await prisma.payout.findMany({ where: { runId: run.id } });
    if (payouts.length === 0) {
      // Execução criada mas sem alocações: seguro descartar e devolver as ordens.
      await prisma.$transaction([
        prisma.order.updateMany({ where: { payoutRunId: run.id }, data: { payoutRunId: null } }),
        prisma.payoutRun.update({
          where: { id: run.id },
          data: {
            status: PayoutRunStatus.FAILED,
            lastError: 'execução sem alocações — descartada no boot',
          },
        }),
      ]);
      continue;
    }

    const allocations: SplitAllocation[] = payouts.map((p) => ({
      label: p.label,
      address: p.address,
      bps: p.bps,
      lamports: p.lamports,
      absorbedRemainder: false,
    }));

    await executeRun(run, allocations).catch((err: unknown) =>
      log.error({ runId: run.id, err }, 'retomada da execução falhou'),
    );
  }
}

/** Histórico de execuções para o painel do admin. */
export async function listRuns(limit = 20): Promise<unknown[]> {
  const runs = await prisma.payoutRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { payouts: { orderBy: { bps: 'desc' } } },
  });

  return runs.map((run) => ({
    id: run.id,
    scheduledFor: run.scheduledFor.toISOString(),
    trigger: run.trigger,
    status: run.status,
    totalSol: Number(run.totalLamports) / 1e9,
    orderCount: run.orderCount,
    skipReason: run.skipReason,
    lastError: run.lastError,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    payouts: run.payouts.map((p) => ({
      label: p.label,
      address: p.address,
      bps: p.bps,
      sol: Number(p.lamports) / 1e9,
      status: p.status,
      signature: p.signature,
    })),
  }));
}

/** Guard para o admin: existe execução parcial exigindo atenção? */
export async function hasPartialRuns(): Promise<boolean> {
  const count = await prisma.payoutRun.count({ where: { status: PayoutRunStatus.PARTIAL } });
  return count > 0;
}
