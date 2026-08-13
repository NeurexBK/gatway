import type { Server } from 'node:http';
import { createApp } from './app';
import { config, LAMPORTS_PER_SOL } from './config';
import { disconnectDatabase, prisma } from './database/client';
import { previewSplit } from './services/distribution.service';
import { retryPendingOrders } from './services/order.service';
import { resumeIncompleteRuns } from './services/payout.service';
import { startScheduler, stopScheduler } from './services/scheduler.service';
import { ensureSeeded, getSettingsView } from './services/settings.service';
import { assertSolanaReachable, lamportsToSol } from './services/solana.service';
import { logger } from './utils/logger';

/**
 * Inicialização real do servidor de longa duração.
 *
 * Está separado de `server.ts` porque os imports deste módulo podem lançar
 * `ConfigError` durante o próprio `import` — e um `try/catch` só alcança isso
 * se o módulo for carregado dinamicamente por quem chama. `server.ts` é o
 * invólucro fino que faz esse carregamento e imprime o erro de forma legível.
 */

let server: Server | undefined;
let shuttingDown = false;

async function main(): Promise<void> {
  // Falhar aqui é barato; falhar no meio de uma ordem paga, não.
  await prisma.$queryRaw`SELECT 1`;
  const { slot, vaultLamports } = await assertSolanaReachable();

  // Cria a linha de settings e semeia os destinatários na primeira subida.
  await ensureSeeded();
  const settings = await getSettingsView();

  let split: unknown;
  try {
    split = (await previewSplit(BigInt(LAMPORTS_PER_SOL))).map((p) => `${p.label}=${p.sol}`);
  } catch (err) {
    split = { error: err instanceof Error ? err.message : String(err) };
  }

  logger.info(
    {
      model: 'broker',
      vault: config.solana.vaultPublicKey.toBase58(),
      vaultSol: lamportsToSol(vaultLamports),
      rpcHost: new URL(config.solana.rpcEndpoint).host,
      slot,
      provider: config.fiat.provider,
      inputMint: config.swap.inputMint,
      marginBps: settings.marginBps,
      distributionAt: `${String(settings.distributionHour).padStart(2, '0')}:${String(
        settings.distributionMinute,
      ).padStart(2, '0')} ${settings.distributionTimezone}`,
      pipelineEnabled: config.runtime.allowPipeline,
      splitPreview1Sol: split,
    },
    'gateway inicializado',
  );

  if (!config.runtime.allowPipeline) {
    logger.error(
      'PIPELINE DESABILITADA: este runtime não garante instância única. ' +
        'Ordens serão registradas mas NÃO processadas. Ver DEPLOY.md.',
    );
  }

  const app = createApp();
  server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        webhook: 'POST /webhook/fiat-payment',
        admin: 'GET /admin',
        quote: 'GET /quote?currency=EUR&amount=100',
      },
      `escutando em http://localhost:${config.port}`,
    );
  });

  // Retomada em background: não bloqueia o readiness do processo.
  void resumeIncompleteRuns()
    .then(() => retryPendingOrders())
    .catch((err: unknown) => logger.error({ err }, 'retomada de trabalho inacabado falhou'));

  await startScheduler();
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'encerrando');

  const timer = setTimeout(() => {
    logger.error('shutdown excedeu 15s — encerrando à força');
    process.exit(1);
  }, 15_000);
  timer.unref();

  try {
    stopScheduler();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await disconnectDatabase();
    logger.info('encerrado com sucesso');
    process.exit(exitCode);
  } catch (err) {
    logger.error({ err }, 'falha no shutdown');
    process.exit(1);
  }
}

export async function start(): Promise<void> {
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandledRejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    void shutdown('uncaughtException', 1);
  });

  await main();
}
