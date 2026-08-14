import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../database/client';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';

/**
 * Lock distribuído com lease, sobre a tabela `Lock`.
 *
 * Por que existe: as garantias de concorrência do gateway eram um `Set` e uma
 * cadeia de promises — corretas dentro de um processo, inúteis com duas
 * instâncias. Em serverless há N instâncias por definição, e sem exclusão real
 * duas ordens podem gastar o mesmo depósito de USDC.
 *
 * Como funciona:
 *  • **exclusão** vem do PRIMARY KEY: dois `create` concorrentes do mesmo
 *    `name` — um ganha, o outro recebe P2002. Não há janela entre "verificar" e
 *    "criar", que é justamente o furo de qualquer implementação com SELECT+INSERT;
 *  • **lease** com `expiresAt`: se o detentor morrer (função que estoura o
 *    tempo, container derrubado), o lock não fica preso para sempre — passado o
 *    prazo, outro processo rouba;
 *  • **roubo seguro**: o update condicional exige `expiresAt < agora`, então
 *    ninguém tira o lock de quem ainda o detém legitimamente;
 *  • **liberação segura**: o delete exige o `owner`, então quem já perdeu o
 *    lease (por timeout) não libera o lock do novo detentor.
 *
 * Funciona igual em SQLite e Postgres: nada de `pg_advisory_lock`, que exigiria
 * manter uma transação aberta durante chamadas HTTP externas de vários segundos.
 */

const log = logger.child({ scope: 'lock' });

/** Identidade deste processo/invocação — distingue detentores do mesmo lock. */
const PROCESS_ID = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;

export interface LockHandle {
  name: string;
  owner: string;
  expiresAt: Date;
}

export interface AcquireOptions {
  /** Duração do lease. Deve cobrir a operação com folga. */
  ttlMs?: number;
  /** Quanto tempo insistir antes de desistir. 0 = tentativa única. */
  waitMs?: number;
  /** Intervalo entre tentativas. */
  retryIntervalMs?: number;
  /** Texto livre para diagnóstico. */
  meta?: string;
}

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_RETRY_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tenta uma vez. Devolve o handle ou null se outro processo detém o lock. */
export async function tryAcquire(
  name: string,
  options: AcquireOptions = {},
): Promise<LockHandle | null> {
  const { ttlMs = DEFAULT_TTL_MS, meta } = options;
  const owner = `${PROCESS_ID}:${crypto.randomBytes(4).toString('hex')}`;
  const expiresAt = new Date(Date.now() + ttlMs);

  try {
    await prisma.lock.create({
      data: { name, owner, expiresAt, ...(meta !== undefined ? { meta } : {}) },
    });
    return { name, owner, expiresAt };
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      throw err;
    }
  }

  // Já existe. Só assume se o lease do detentor anterior expirou. O `where` com
  // `expiresAt: { lt: now }` é o que torna o roubo atômico: se dois processos
  // tentarem roubar, apenas um vê rowCount 1.
  const stolen = await prisma.lock.updateMany({
    where: { name, expiresAt: { lt: new Date() } },
    data: { owner, expiresAt, acquiredAt: new Date(), meta: meta ?? null },
  });

  if (stolen.count === 1) {
    log.warn({ name, owner }, 'lease expirado — lock assumido de detentor anterior');
    return { name, owner, expiresAt };
  }

  return null;
}

/** Insiste até `waitMs`. Devolve null se não conseguir no prazo. */
export async function acquire(
  name: string,
  options: AcquireOptions = {},
): Promise<LockHandle | null> {
  const { waitMs = 0, retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS } = options;
  const deadline = Date.now() + waitMs;

  for (;;) {
    const handle = await tryAcquire(name, options);
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(retryIntervalMs, Math.max(deadline - Date.now(), 1)));
  }
}

/** Libera só se ainda for o detentor. Nunca lança. */
export async function release(handle: LockHandle): Promise<void> {
  try {
    const deleted = await prisma.lock.deleteMany({
      where: { name: handle.name, owner: handle.owner },
    });
    if (deleted.count === 0) {
      // Perdemos o lease durante a operação e outro processo assumiu. Grave:
      // significa que o TTL foi curto demais para o trabalho executado.
      log.error(
        { name: handle.name, owner: handle.owner },
        'lock já não era nosso ao liberar — TTL curto demais para a operação',
      );
    }
  } catch (err) {
    log.error({ err, name: handle.name }, 'falha ao liberar lock');
  }
}

/** Estende o lease. Use em operações longas para não perder o lock no meio. */
export async function renew(handle: LockHandle, ttlMs = DEFAULT_TTL_MS): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const updated = await prisma.lock.updateMany({
    where: { name: handle.name, owner: handle.owner },
    data: { expiresAt },
  });
  if (updated.count === 1) {
    handle.expiresAt = expiresAt;
    return true;
  }
  return false;
}

/**
 * Executa `fn` sob o lock, liberando sempre. Se não conseguir o lock, devolve
 * `{ acquired: false }` em vez de lançar — quase sempre "outro processo já está
 * cuidando disso" é resultado esperado, não erro.
 */
export async function withLock<T>(
  name: string,
  fn: (handle: LockHandle) => Promise<T>,
  options: AcquireOptions = {},
): Promise<{ acquired: true; result: T } | { acquired: false; result?: undefined }> {
  const handle = await acquire(name, options);
  if (!handle) {
    log.debug({ name }, 'lock ocupado — pulando');
    return { acquired: false };
  }
  try {
    return { acquired: true, result: await fn(handle) };
  } finally {
    await release(handle);
  }
}

/** Como `withLock`, mas lança quando o lock é indispensável. */
export async function withLockOrThrow<T>(
  name: string,
  fn: (handle: LockHandle) => Promise<T>,
  options: AcquireOptions = {},
): Promise<T> {
  const outcome = await withLock(name, fn, options);
  if (!outcome.acquired) {
    throw new GatewayError(
      `não foi possível obter o lock "${name}" — outra instância está processando`,
      'LOCK_UNAVAILABLE',
      true,
    );
  }
  return outcome.result;
}

/** Remove locks expirados. Chamado pelo tick — só higiene, não correção. */
export async function pruneExpiredLocks(): Promise<number> {
  const { count } = await prisma.lock.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 60_000) } },
  });
  if (count > 0) log.debug({ count }, 'locks expirados removidos');
  return count;
}

/** Locks ativos, para o painel do admin. */
export async function listLocks(): Promise<
  Array<{ name: string; owner: string; expiresAt: string; expired: boolean; meta: string | null }>
> {
  const rows = await prisma.lock.findMany({ orderBy: { acquiredAt: 'desc' }, take: 50 });
  const now = Date.now();
  return rows.map((r) => ({
    name: r.name,
    owner: r.owner,
    expiresAt: r.expiresAt.toISOString(),
    expired: r.expiresAt.getTime() < now,
    meta: r.meta,
  }));
}

export const LOCK_NAMES = {
  /** Serializa a sequência "verificar saldo não reservado -> swapar". */
  SWAP: 'swap:global',
  /** Uma execução de distribuição de lucro por vez. */
  PAYOUT: 'payout:global',
  /** Uma ordem por vez. */
  order: (orderId: string) => `order:${orderId}`,
} as const;
