import { PublicKey } from '@solana/web3.js';
import type { GatewaySettings, Recipient } from '@prisma/client';
import { config, TOTAL_BPS } from '../config';
import { prisma } from '../database/client';
import { GatewayError, type GatewaySettingsView, type RecipientConfig } from '../types';
import { logger } from '../utils/logger';

/**
 * Configuração viva do gateway: split e parâmetros de taxa/horário passam a
 * morar no banco, editáveis pelo admin sem redeploy.
 *
 * `RECIPIENTS_JSON` do .env virou apenas o seed da primeira subida — depois
 * disso a fonte de verdade é a tabela `Recipient`.
 */

const log = logger.child({ scope: 'settings' });
const SETTINGS_ID = 'default';

/** Cache curto: o hot path (webhook) lê settings a cada ordem. */
let cache: { settings: GatewaySettings; at: number } | null = null;
const CACHE_TTL_MS = 5_000;

// ─────────────────────────── Timezone ───────────────────────────

/** Offset (ms) entre a timezone e UTC no instante dado. Respeita DST. */
function timezoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour` pode vir como 24 em algumas engines para meia-noite.
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  );
  return asUtc - date.getTime();
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Próximo instante (UTC) em que o relógio de parede de `timeZone` marca
 * `hour:minute`. A iteração dupla corrige a virada de horário de verão: o
 * offset usado na primeira estimativa pode ser o do lado errado da transição.
 */
export function computeNextRunAt(
  hour: number,
  minute: number,
  timeZone: string,
  from: Date = new Date(),
): Date {
  const offsetNow = timezoneOffsetMs(from, timeZone);
  const local = new Date(from.getTime() + offsetNow);

  let target = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    hour,
    minute,
    0,
    0,
  );
  // Já passou hoje? Vai para amanhã.
  if (target - offsetNow <= from.getTime()) target += 24 * 60 * 60 * 1000;

  let instant = target - offsetNow;
  const refined = timezoneOffsetMs(new Date(instant), timeZone);
  if (refined !== offsetNow) instant = target - refined;

  return new Date(instant);
}

// ─────────────────────────── Seed / leitura ───────────────────────────

export async function ensureSeeded(): Promise<void> {
  const settings = await prisma.gatewaySettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
  });

  const count = await prisma.recipient.count();
  if (count === 0) {
    await prisma.recipient.createMany({
      data: config.distribution.recipientsSeed.map((r) => ({
        label: r.label,
        address: r.address,
        bps: r.bps,
        active: true,
      })),
    });
    log.info(
      { recipients: config.distribution.recipientsSeed.length },
      'destinatários semeados a partir de RECIPIENTS_JSON',
    );
  }

  log.info(
    {
      distributionEnabled: settings.distributionEnabled,
      dailyAt: `${String(settings.distributionHour).padStart(2, '0')}:${String(
        settings.distributionMinute,
      ).padStart(2, '0')} ${settings.distributionTimezone}`,
      marginBps: settings.marginBps,
    },
    'configuração carregada',
  );
}

export async function getSettings(force = false): Promise<GatewaySettings> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.settings;

  const settings = await prisma.gatewaySettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
  });
  cache = { settings, at: Date.now() };
  return settings;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

export async function getSettingsView(): Promise<GatewaySettingsView> {
  const s = await getSettings();
  return {
    distributionEnabled: s.distributionEnabled,
    distributionHour: s.distributionHour,
    distributionMinute: s.distributionMinute,
    distributionTimezone: s.distributionTimezone,
    minProfitLamports: s.minProfitLamports.toString(),
    marginBps: s.marginBps,
    minFeeBps: s.minFeeBps,
    maxFeeBps: s.maxFeeBps,
    fallbackProviderCostBps: s.fallbackProviderCostBps,
    nextRunAt: computeNextRunAt(
      s.distributionHour,
      s.distributionMinute,
      s.distributionTimezone,
    ).toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// ─────────────────────────── Escrita (admin) ───────────────────────────

export interface SettingsPatch {
  distributionEnabled?: boolean;
  distributionHour?: number;
  distributionMinute?: number;
  distributionTimezone?: string;
  minProfitLamports?: string;
  marginBps?: number;
  minFeeBps?: number;
  maxFeeBps?: number;
  fallbackProviderCostBps?: number;
}

export async function updateSettings(patch: SettingsPatch): Promise<GatewaySettings> {
  const data: Record<string, unknown> = {};

  if (patch.distributionEnabled !== undefined) {
    data.distributionEnabled = Boolean(patch.distributionEnabled);
  }
  if (patch.distributionHour !== undefined) {
    if (!Number.isInteger(patch.distributionHour) || patch.distributionHour < 0 || patch.distributionHour > 23) {
      throw new GatewayError('distributionHour precisa ser inteiro 0..23', 'INVALID_SETTING', false);
    }
    data.distributionHour = patch.distributionHour;
  }
  if (patch.distributionMinute !== undefined) {
    if (
      !Number.isInteger(patch.distributionMinute) ||
      patch.distributionMinute < 0 ||
      patch.distributionMinute > 59
    ) {
      throw new GatewayError('distributionMinute precisa ser inteiro 0..59', 'INVALID_SETTING', false);
    }
    data.distributionMinute = patch.distributionMinute;
  }
  if (patch.distributionTimezone !== undefined) {
    if (!isValidTimezone(patch.distributionTimezone)) {
      throw new GatewayError(
        `timezone IANA inválida: "${patch.distributionTimezone}"`,
        'INVALID_SETTING',
        false,
      );
    }
    data.distributionTimezone = patch.distributionTimezone;
  }
  if (patch.minProfitLamports !== undefined) {
    if (!/^\d+$/.test(patch.minProfitLamports)) {
      throw new GatewayError('minProfitLamports precisa ser inteiro >= 0', 'INVALID_SETTING', false);
    }
    data.minProfitLamports = BigInt(patch.minProfitLamports);
  }

  for (const key of ['marginBps', 'minFeeBps', 'maxFeeBps', 'fallbackProviderCostBps'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0 || value > TOTAL_BPS) {
      throw new GatewayError(`${key} precisa ser inteiro 0..${TOTAL_BPS}`, 'INVALID_SETTING', false);
    }
    data[key] = value;
  }

  if (Object.keys(data).length === 0) {
    throw new GatewayError('nenhum campo válido para atualizar', 'EMPTY_PATCH', false);
  }

  const merged = { ...(await getSettings(true)), ...data } as GatewaySettings;
  if (merged.minFeeBps > merged.maxFeeBps) {
    throw new GatewayError('minFeeBps não pode ser maior que maxFeeBps', 'INVALID_SETTING', false);
  }

  const updated = await prisma.gatewaySettings.update({ where: { id: SETTINGS_ID }, data });
  invalidateSettingsCache();
  log.info({ changed: Object.keys(data) }, 'configuração atualizada pelo admin');
  return updated;
}

// ─────────────────────────── Destinatários ───────────────────────────

export async function getRecipients(): Promise<Recipient[]> {
  return prisma.recipient.findMany({ where: { active: true }, orderBy: { bps: 'desc' } });
}

/**
 * Destinatários no formato do split, com a invariante de 100% garantida.
 * A distribuição chama isto — se a config estiver quebrada, nada é enviado.
 */
export async function getSplitRecipients(): Promise<RecipientConfig[]> {
  const recipients = await getRecipients();
  if (recipients.length === 0) {
    throw new GatewayError('nenhum destinatário ativo configurado', 'NO_RECIPIENTS', false);
  }
  const sum = recipients.reduce((acc, r) => acc + r.bps, 0);
  if (sum !== TOTAL_BPS) {
    throw new GatewayError(
      `soma dos bps dos destinatários ativos é ${sum}, precisa ser ${TOTAL_BPS}`,
      'INVALID_BPS_SUM',
      false,
    );
  }
  return recipients.map((r) => ({ label: r.label, address: r.address, bps: r.bps }));
}

export interface RecipientInput {
  label?: string;
  address: string;
  bps: number;
  active?: boolean;
}

/**
 * Substitui o conjunto inteiro de destinatários numa transação — evita o
 * estado intermediário inválido de editar um por um (soma ≠ 100%).
 */
export async function replaceRecipients(list: RecipientInput[]): Promise<Recipient[]> {
  if (!Array.isArray(list) || list.length === 0) {
    throw new GatewayError('envie ao menos um destinatário', 'INVALID_RECIPIENTS', false);
  }

  const seen = new Set<string>();
  for (const r of list) {
    if (typeof r.address !== 'string') {
      throw new GatewayError('address precisa ser string', 'INVALID_RECIPIENTS', false);
    }
    try {
      new PublicKey(r.address);
    } catch {
      throw new GatewayError(
        `"${r.address}" não é uma public key Solana válida`,
        'INVALID_RECIPIENTS',
        false,
      );
    }
    if (r.address === config.solana.vaultPublicKey.toBase58()) {
      throw new GatewayError(
        'o vault não pode ser destinatário do próprio split',
        'INVALID_RECIPIENTS',
        false,
      );
    }
    if (seen.has(r.address)) {
      throw new GatewayError(`endereço duplicado: ${r.address}`, 'INVALID_RECIPIENTS', false);
    }
    seen.add(r.address);
    if (!Number.isInteger(r.bps) || r.bps <= 0 || r.bps > TOTAL_BPS) {
      throw new GatewayError(
        `bps inválido para ${r.address}: ${r.bps} (1..${TOTAL_BPS})`,
        'INVALID_RECIPIENTS',
        false,
      );
    }
  }

  const activeSum = list
    .filter((r) => r.active !== false)
    .reduce((acc, r) => acc + r.bps, 0);
  if (activeSum !== TOTAL_BPS) {
    throw new GatewayError(
      `a soma dos bps ativos é ${activeSum}, precisa ser exatamente ${TOTAL_BPS} (100%)`,
      'INVALID_BPS_SUM',
      false,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.recipient.deleteMany({});
    await tx.recipient.createMany({
      data: list.map((r, i) => ({
        label: r.label?.trim() || `recipient-${i + 1}`,
        address: r.address,
        bps: r.bps,
        active: r.active !== false,
      })),
    });
    return tx.recipient.findMany({ orderBy: { bps: 'desc' } });
  });

  log.info(
    { recipients: result.map((r) => `${r.label}:${r.bps}`) },
    'destinatários substituídos pelo admin',
  );
  return result;
}
