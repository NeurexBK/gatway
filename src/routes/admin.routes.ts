import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config, LAMPORTS_PER_SOL } from '../config';
import { prisma } from '../database/client';
import { GatewayError, SUPPORTED_CURRENCIES, type FiatCurrency as Fiat } from '../types';
import { logger } from '../utils/logger';
import { jsonSafe } from '../utils/serialize';
import { previewSplit } from '../services/distribution.service';
import { adapterStatus, compareProviderFees, recentFeeSnapshots, resolveEffectiveFee } from '../services/fee.service';
import { getAccruedProfit, getOrderStats } from '../services/order.service';
import { hasPartialRuns, listRuns, runProfitDistribution } from '../services/payout.service';
import { getNextRunAt, scheduleNextRun } from '../services/scheduler.service';
import {
  getRecipients,
  getSettingsView,
  replaceRecipients,
  updateSettings,
  type RecipientInput,
  type SettingsPatch,
} from '../services/settings.service';
import { getBalance, lamportsToSol } from '../services/solana.service';
import { ADMIN_PAGE_HTML } from './admin.page';
import { ah } from '../utils/async-route';

/**
 * Painel administrativo.
 *
 * Autenticação por `ADMIN_API_KEY` (Bearer ou `x-admin-key`), comparada em
 * tempo constante. É proteção de chave estática, adequada para uso interno —
 * não substitui login por usuário com auditoria por pessoa, que é o que uma
 * operação com múltiplos sócios eventualmente vai querer.
 */

const router: Router = Router();
const log = logger.child({ scope: 'admin' });

// ─────────────────────────── Autenticação ───────────────────────────

/** Contador simples de falhas por IP, para não deixar a chave ser adivinhada. */
const failures = new Map<string, { count: number; first: number }>();
const LOCKOUT_WINDOW_MS = 10 * 60 * 1_000;
const MAX_FAILURES = 10;

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractKey(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const direct = req.headers['x-admin-key'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return null;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? 'unknown';
  const record = failures.get(ip);
  if (record && Date.now() - record.first < LOCKOUT_WINDOW_MS && record.count >= MAX_FAILURES) {
    res.status(429).json({ error: 'too_many_attempts', message: 'tente novamente mais tarde' });
    return;
  }

  const provided = extractKey(req);
  if (provided === null || !constantTimeEquals(provided, config.admin.apiKey)) {
    const next_ = record && Date.now() - record.first < LOCKOUT_WINDOW_MS
      ? { count: record.count + 1, first: record.first }
      : { count: 1, first: Date.now() };
    failures.set(ip, next_);

    // Diagnóstico sem vazar a chave: só o comprimento, e só fora de produção.
    // Um campo de senha invisível com autofill do navegador é indistinguível de
    // "chave errada" sem esta dica.
    const hint =
      config.isProduction
        ? undefined
        : provided === null
          ? 'nenhum header de chave recebido (esperado x-admin-key ou Authorization: Bearer)'
          : `comprimento recebido ${provided.length}, esperado ${config.admin.apiKey.length}` +
            (provided.length !== config.admin.apiKey.length
              ? ' — o campo provavelmente foi autopreenchido pelo navegador'
              : ' — comprimento bate, conteúdo não');

    log.warn(
      { ip, attempts: next_.count, receivedLength: provided?.length ?? 0 },
      'acesso ao admin rejeitado',
    );
    res.status(401).json({ error: 'unauthorized', ...(hint ? { message: hint } : {}) });
    return;
  }

  failures.delete(ip);
  next();
}

// ─────────────────────────── Página ───────────────────────────

/** A página em si não expõe dado nenhum: pede a chave e chama a API. */
router.get('/', (_req: Request, res: Response) => {
  res.type('html').send(ADMIN_PAGE_HTML);
});

router.use('/api', requireAdmin);

// ─────────────────────────── Visão geral ───────────────────────────

router.get('/api/overview', ah(async (_req: Request, res: Response) => {
  const [stats, profit, settings, vaultLamports, partial] = await Promise.all([
    getOrderStats(),
    getAccruedProfit(),
    getSettingsView(),
    getBalance().catch(() => null),
    hasPartialRuns(),
  ]);

  res.json({
    orders: stats,
    profit: {
      accruedLamports: profit.lamports.toString(),
      accruedSol: Number(profit.lamports) / LAMPORTS_PER_SOL,
      orderCount: profit.orderCount,
    },
    vault: {
      address: config.solana.vaultPublicKey.toBase58(),
      sol: vaultLamports === null ? null : lamportsToSol(vaultLamports),
      feeReserveSol: lamportsToSol(config.distribution.feeReserveLamports),
    },
    schedule: {
      enabled: settings.distributionEnabled,
      localTime: `${String(settings.distributionHour).padStart(2, '0')}:${String(
        settings.distributionMinute,
      ).padStart(2, '0')}`,
      timezone: settings.distributionTimezone,
      nextRunAt: getNextRunAt()?.toISOString() ?? settings.nextRunAt,
      minProfitSol: Number(settings.minProfitLamports) / LAMPORTS_PER_SOL,
    },
    warnings: {
      partialRuns: partial,
      vaultBelowReserve:
        vaultLamports !== null && vaultLamports < config.distribution.feeReserveLamports,
    },
    env: config.env,
  });
}));

// ─────────────────────────── Configurações ───────────────────────────

router.get('/api/settings', ah(async (_req: Request, res: Response) => {
  res.json(await getSettingsView());
}));

router.put('/api/settings', ah(async (req: Request, res: Response) => {
  const patch = req.body as SettingsPatch;
  await updateSettings(patch);
  // Horário pode ter mudado: reagenda imediatamente.
  await scheduleNextRun();
  res.json(await getSettingsView());
}));

// ─────────────────────────── Destinatários (split) ───────────────────────────

router.get('/api/recipients', ah(async (_req: Request, res: Response) => {
  const recipients = await getRecipients();
  let preview: unknown = null;
  try {
    preview = await previewSplit(BigInt(LAMPORTS_PER_SOL));
  } catch (err) {
    preview = { error: err instanceof Error ? err.message : String(err) };
  }
  res.json({
    recipients: recipients.map((r) => ({
      label: r.label,
      address: r.address,
      bps: r.bps,
      percent: `${(r.bps / 100).toFixed(2)}%`,
      active: r.active,
    })),
    totalBps: recipients.reduce((acc, r) => acc + r.bps, 0),
    splitPreviewFor1Sol: preview,
  });
}));

router.put('/api/recipients', ah(async (req: Request, res: Response) => {
  const body = req.body as { recipients?: RecipientInput[] };
  if (!body || !Array.isArray(body.recipients)) {
    throw new GatewayError('esperado { recipients: [...] }', 'INVALID_BODY', false);
  }
  const saved = await replaceRecipients(body.recipients);
  res.json({
    recipients: saved.map((r) => ({
      label: r.label,
      address: r.address,
      bps: r.bps,
      percent: `${(r.bps / 100).toFixed(2)}%`,
      active: r.active,
    })),
  });
}));

// ─────────────────────────── Taxas dos on-ramps ───────────────────────────

function parseCurrency(raw: unknown): Fiat {
  const value = String(raw ?? 'EUR').toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(value as Fiat)) {
    throw new GatewayError(
      `moeda não suportada: "${value}" (aceitas: ${SUPPORTED_CURRENCIES.join(', ')})`,
      'UNSUPPORTED_CURRENCY',
      false,
    );
  }
  return value as Fiat;
}

function parseAmount(raw: unknown): number {
  const value = Number(raw ?? 100);
  if (!Number.isFinite(value) || value <= 0) {
    throw new GatewayError('amount precisa ser um número positivo', 'INVALID_AMOUNT', false);
  }
  return value;
}

router.get('/api/fees', ah(async (req: Request, res: Response) => {
  const currency = parseCurrency(req.query.currency);
  const amount = parseAmount(req.query.amount);
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';

  const [comparison, fee] = await Promise.all([
    compareProviderFees(currency, amount, { skipCache: refresh }),
    resolveEffectiveFee(currency, amount),
  ]);

  res.json({
    comparison,
    effectiveFee: fee,
    adapters: adapterStatus(),
    note:
      'Adapters não verificados contra as APIs reais (sem chaves). Confirme o costBps ' +
      'contra o extrato do provedor antes de confiar em produção.',
  });
}));

router.get('/api/fees/history', ah(async (_req: Request, res: Response) => {
  res.json({ snapshots: await recentFeeSnapshots(60) });
}));

// ─────────────────────────── Distribuição ───────────────────────────

router.get('/api/runs', ah(async (_req: Request, res: Response) => {
  res.json({ runs: await listRuns(20) });
}));

router.post('/api/distribution/run-now', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { ignoreMinimum?: boolean };
  log.warn({ ignoreMinimum: Boolean(body.ignoreMinimum) }, 'distribuição manual disparada pelo admin');
  const summary = await runProfitDistribution({
    trigger: 'MANUAL',
    ignoreMinimum: Boolean(body.ignoreMinimum),
  });
  res.json(summary);
}));

// ─────────────────────────── Ordens ───────────────────────────

router.get('/api/orders', ah(async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 25), 1), 100);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const orders = await prisma.order.findMany({
    ...(status ? { where: { status } } : {}),
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  res.json(
    jsonSafe({
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        fiat: `${o.fiatAmount.toString()} ${o.fiatCurrency}`,
        customerWallet: o.customerWallet,
        feeBps: o.feeBps,
        feeSourceProvider: o.feeSourceProvider,
        customerSol: o.customerLamports === null ? null : Number(o.customerLamports) / LAMPORTS_PER_SOL,
        profitSol: o.profitLamports === null ? null : Number(o.profitLamports) / LAMPORTS_PER_SOL,
        swapSignature: o.swapSignature,
        customerPayoutSignature: o.customerPayoutSignature,
        payoutRunId: o.payoutRunId,
        attempts: o.attempts,
        lastError: o.lastError,
        createdAt: o.createdAt.toISOString(),
      })),
    }),
  );
}));

export default router;
