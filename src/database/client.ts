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
prisma.$on('error' as never, (e: unknown) => logger.error({ prisma: e }, 'prisma error'));

if (!config.isProduction) globalForPrisma.prisma = prisma;

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
