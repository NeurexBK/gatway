import { Router, type Request, type Response } from 'express';
import { config, LAMPORTS_PER_SOL } from '../config';
import { prisma } from '../database/client';
import { getAccruedProfit, getOrderStats } from '../services/order.service';
import { previewSplit } from '../services/distribution.service';
import { getNextRunAt } from '../services/scheduler.service';
import { getSettingsView } from '../services/settings.service';
import { connection, getBalance, lamportsToSol } from '../services/solana.service';
import { ah } from '../utils/async-route';

const router: Router = Router();
const startedAt = Date.now();

/** Liveness: não toca em dependência externa — só diz que o processo respira. */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'solana-fiat-gateway',
    env: config.env,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

/** Readiness: DB + RPC + saldo do vault. É este que o load balancer deve usar. */
router.get('/ready', ah(async (_req: Request, res: Response) => {
  const checks: Record<string, { ok: boolean; detail?: unknown }> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true };
  } catch (err) {
    checks.database = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  try {
    const slot = await connection.getSlot('confirmed');
    checks.rpc = { ok: true, detail: { slot, endpoint: new URL(config.solana.rpcEndpoint).host } };
  } catch (err) {
    checks.rpc = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  try {
    const lamports = await getBalance();
    const sufficient = lamports >= config.distribution.feeReserveLamports;
    checks.vault = {
      ok: sufficient,
      detail: {
        address: config.solana.vaultPublicKey.toBase58(),
        sol: lamportsToSol(lamports),
        reserveSol: lamportsToSol(config.distribution.feeReserveLamports),
        ...(sufficient ? {} : { warning: 'saldo abaixo da reserva de fee' }),
      },
    };
  } catch (err) {
    checks.vault = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  let orders: Record<string, number> | { error: string };
  let profit: unknown = null;
  try {
    orders = await getOrderStats();
    const accrued = await getAccruedProfit();
    profit = {
      accruedSol: Number(accrued.lamports) / LAMPORTS_PER_SOL,
      orderCount: accrued.orderCount,
    };
  } catch (err) {
    orders = { error: err instanceof Error ? err.message : String(err) };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ready' : 'degraded',
    checks,
    orders,
    profit,
    nextDistributionAt: getNextRunAt()?.toISOString() ?? null,
  });
}));

/**
 * Configuração efetiva — sem segredos. Inclui a pré-visualização do split para
 * 1 SOL: a forma mais rápida de confirmar que as carteiras estão certas antes
 * de mover dinheiro real.
 */
router.get('/config', ah(async (_req: Request, res: Response) => {
  const settings = await getSettingsView();

  let split: unknown;
  try {
    split = await previewSplit(BigInt(LAMPORTS_PER_SOL));
  } catch (err) {
    split = { error: err instanceof Error ? err.message : String(err) };
  }

  res.json({
    env: config.env,
    model: 'broker: cliente recebe SOL menos a taxa; a taxa é o lucro distribuído',
    provider: config.fiat.provider,
    vault: config.solana.vaultPublicKey.toBase58(),
    rpcHost: new URL(config.solana.rpcEndpoint).host,
    swap: {
      inputMint: config.swap.inputMint,
      outputMint: config.swap.outputMint,
      slippageBps: config.swap.slippageBps,
      maxPriceImpactBps: config.swap.maxPriceImpactBps,
      jupiter: config.swap.jupiterBase,
    },
    fee: {
      marginBps: settings.marginBps,
      minFeeBps: settings.minFeeBps,
      maxFeeBps: settings.maxFeeBps,
      fallbackProviderCostBps: settings.fallbackProviderCostBps,
    },
    distribution: {
      enabled: settings.distributionEnabled,
      dailyAt: `${String(settings.distributionHour).padStart(2, '0')}:${String(
        settings.distributionMinute,
      ).padStart(2, '0')}`,
      timezone: settings.distributionTimezone,
      nextRunAt: getNextRunAt()?.toISOString() ?? settings.nextRunAt,
      minProfitSol: Number(settings.minProfitLamports) / LAMPORTS_PER_SOL,
      feeReserveSol: lamportsToSol(config.distribution.feeReserveLamports),
      maxTransfersPerTx: config.distribution.maxTransfersPerTx,
    },
    splitPreviewFor1Sol: split,
  });
}));

export default router;
