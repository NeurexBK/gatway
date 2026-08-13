import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import { config } from './config';
import { logger } from './utils/logger';
import { GatewayError, type RawBodyRequest } from './types';
import adminRoutes from './routes/admin.routes';
import healthRoutes from './routes/health.routes';
import quoteRoutes from './routes/quote.routes';
import webhookRoutes from './routes/webhook.routes';

export function createApp(): Application {
  const app = express();

  app.disable('x-powered-by');
  // Respeita X-Forwarded-* atrás de proxy/LB (req.ip correto nos logs).
  app.set('trust proxy', true);

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  /**
   * O HMAC do webhook é calculado sobre os bytes exatos recebidos. Se
   * deixássemos o Express re-serializar o JSON, qualquer diferença de
   * espaçamento ou ordem de chaves invalidaria assinaturas legítimas — por
   * isso guardamos o buffer cru aqui.
   */
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as Request & RawBodyRequest).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.use('/health', healthRoutes);
  app.use('/webhook', webhookRoutes);
  app.use('/quote', quoteRoutes);
  app.use('/admin', adminRoutes);

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Handler de erro final. A assinatura de 4 args é obrigatória para o Express
  // reconhecê-lo como error handler.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const isGatewayError = err instanceof GatewayError;
    const status = isGatewayError && !err.retryable ? 400 : 500;
    const message = err instanceof Error ? err.message : 'erro interno';

    req.log?.error({ err, code: isGatewayError ? err.code : 'INTERNAL' }, 'requisição falhou');

    res.status(status).json({
      error: isGatewayError ? err.code : 'internal_error',
      // Em produção não devolvemos detalhe interno de erro não-tipado.
      message: isGatewayError || !config.isProduction ? message : 'erro interno',
    });
  });

  return app;
}
