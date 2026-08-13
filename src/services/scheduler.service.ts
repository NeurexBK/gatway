import { logger } from '../utils/logger';
import { retryPendingOrders } from './order.service';
import { runProfitDistribution } from './payout.service';
import { computeNextRunAt, getSettings } from './settings.service';

/**
 * Agendador do horário fixo diário da distribuição de lucro.
 *
 * Usa `setTimeout` recalculado a cada disparo em vez de um cron por intervalo:
 * assim o horário acompanha a timezone configurada e sobrevive a horário de
 * verão (o próximo instante é recalculado do zero, sempre a partir do relógio
 * de parede da timezone).
 *
 * Também roda um varredor periódico de ordens inacabadas — sem ele, uma ordem
 * que falha por erro transitório só seria retomada no próximo boot.
 */

const log = logger.child({ scope: 'scheduler' });

/** Teto do setTimeout no Node (~24.8 dias); o nosso alvo é sempre < 24h. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const SWEEP_INTERVAL_MS = 5 * 60 * 1_000;

let distributionTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let nextRunAt: Date | null = null;
let started = false;

export function getNextRunAt(): Date | null {
  return nextRunAt;
}

/**
 * (Re)agenda o próximo disparo. Chamado no boot, após cada execução e sempre
 * que o admin muda o horário — por isso é idempotente: limpa o timer anterior.
 */
export async function scheduleNextRun(): Promise<Date | null> {
  if (distributionTimer) {
    clearTimeout(distributionTimer);
    distributionTimer = null;
  }

  const settings = await getSettings(true);
  if (!settings.distributionEnabled) {
    nextRunAt = null;
    log.warn('distribuição automática DESABILITADA nas configurações');
    return null;
  }

  const target = computeNextRunAt(
    settings.distributionHour,
    settings.distributionMinute,
    settings.distributionTimezone,
  );
  nextRunAt = target;

  const delay = Math.min(Math.max(target.getTime() - Date.now(), 0), MAX_TIMEOUT_MS);
  distributionTimer = setTimeout(() => {
    void fire(target);
  }, delay);
  distributionTimer.unref();

  log.info(
    {
      nextRunAt: target.toISOString(),
      inMinutes: Math.round(delay / 60_000),
      localTime: `${String(settings.distributionHour).padStart(2, '0')}:${String(
        settings.distributionMinute,
      ).padStart(2, '0')} ${settings.distributionTimezone}`,
    },
    'próxima distribuição de lucro agendada',
  );

  return target;
}

async function fire(scheduledFor: Date): Promise<void> {
  log.info({ scheduledFor: scheduledFor.toISOString() }, 'disparando distribuição agendada');
  try {
    const summary = await runProfitDistribution({ trigger: 'SCHEDULED', scheduledFor });
    log.info({ summary }, 'distribuição agendada finalizada');
  } catch (err) {
    // Falhar aqui não pode matar o agendamento: o próximo ciclo tenta de novo,
    // e o estado da execução ficou registrado no banco.
    log.error({ err }, 'distribuição agendada falhou');
  } finally {
    await scheduleNextRun().catch((err: unknown) =>
      log.error({ err }, 'falha ao reagendar a distribuição'),
    );
  }
}

export async function startScheduler(): Promise<void> {
  if (started) return;
  started = true;

  await scheduleNextRun();

  sweepTimer = setInterval(() => {
    void retryPendingOrders().catch((err: unknown) =>
      log.error({ err }, 'varredura de ordens pendentes falhou'),
    );
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  log.info({ sweepMinutes: SWEEP_INTERVAL_MS / 60_000 }, 'agendador iniciado');
}

export function stopScheduler(): void {
  if (distributionTimer) clearTimeout(distributionTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  distributionTimer = null;
  sweepTimer = null;
  started = false;
}
