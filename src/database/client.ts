import { PrismaClient } from '@prisma/client';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Instância única do Prisma. Em dev o `tsx watch` recarrega o módulo a cada
 * save, então guardamos no globalThis para não abrir uma pool nova por reload.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.isProduction
      ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
      : [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
  });

prisma.$on('warn' as never, (e: unknown) => logger.warn({ prisma: e }, 'prisma warn'));

prisma.$on('error' as never, (e: unknown) => {
  /**
   * Contenção de lock não é erro.
   *
   * `lock.create` falhando por unique constraint é o mecanismo normal de
   * exclusão mútua — acontece a cada disputa e é tratado em `lock.service`.
   * Deixar isso como `error` encheria o log de produção de alarme falso e
   * esconderia problemas reais.
   */
  const message =
    e !== null && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : '';
  const isLockContention =
    message.includes('lock.create') && message.includes('Unique constraint failed');

  if (isLockContention) {
    logger.debug({ target: 'lock.create' }, 'contenção de lock (esperado)');
    return;
  }
  logger.error({ prisma: e }, 'prisma error');
});

if (!config.isProduction) globalForPrisma.prisma = prisma;

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
