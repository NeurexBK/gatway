import pino from 'pino';
import { config } from '../config';

/**
 * Log estruturado. Em dev usa pino-pretty; em produção JSON puro (ingestão
 * por Datadog/Loki/CloudWatch). `redact` garante que segredo nenhum vaze
 * por acidente num objeto logado.
 */
export const logger = pino({
  level: config.logLevel,
  base: { service: 'solana-fiat-gateway', env: config.env },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-spherepay-signature"]',
      'req.headers["moonpay-signature"]',
      'secret',
      '*.secret',
      'privateKey',
      '*.privateKey',
      'VAULT_PRIVATE_KEY',
      'FIAT_PROVIDER_SECRET',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(config.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
        },
      }),
});

/** Logger com contexto de ordem — todo log da pipeline sai correlacionado. */
export function orderLogger(orderId: string, extra: Record<string, unknown> = {}) {
  return logger.child({ orderId, ...extra });
}

export type Logger = typeof logger;
