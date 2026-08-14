import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { prisma } from '../database/client';
import { GatewayError, OrderStatus } from '../types';
import { logger } from '../utils/logger';
import { createOrderFromEvent, processOrder } from '../services/order.service';
import {
  assertEventIsProcessable,
  getSignatureHeader,
  normalizeEvent,
  verifySignature,
} from '../services/webhook.service';
import { jsonSafe } from '../utils/serialize';
import { ah } from '../utils/async-route';

/**
 * Webhook do provedor fiat.
 *
 * Contrato de resposta, deliberado:
 *  • 401 → assinatura inválida (o provedor deve alertar, não retentar);
 *  • 400 → payload que nunca vai funcionar (moeda errada, carteira inválida);
 *  • 200 → evento aceito mas não acionável (pagamento pendente/falhado);
 *  • 202 → ordem aceita; a pipeline roda em background.
 *
 * O 202 é imediato de propósito: provedores derrubam a conexão em poucos
 * segundos, e swap + liquidação na Solana não cabem nessa janela. A resiliência
 * vem do estado persistido, não do retry HTTP do provedor.
 */

const router: Router = Router();
const log = logger.child({ scope: 'webhook.route' });

router.post('/fiat-payment', ah(async (req: Request, res: Response) => {
  const header = getSignatureHeader(req);

  // 1) Autenticidade antes de qualquer parsing de negócio.
  const verification = verifySignature(req);
  if (!verification.valid) {
    log.warn(
      { reason: verification.reason, signatureHeader: header?.name ?? null, ip: req.ip },
      'webhook rejeitado: assinatura inválida',
    );
    return res.status(401).json({ error: 'invalid_signature', message: verification.reason });
  }

  // 2) Normalização multi-provedor + validações de segurança.
  let event;
  try {
    event = normalizeEvent(req.body);
    assertEventIsProcessable(event);
  } catch (err) {
    if (err instanceof GatewayError && !err.retryable) {
      log.warn({ code: err.code, err: err.message }, 'webhook rejeitado: payload inaceitável');
      return res.status(400).json({ error: err.code, message: err.message });
    }
    throw err;
  }

  // 3) Só pagamento concluído dispara a cadeia on-chain.
  if (event.type !== 'payment.completed') {
    log.info(
      { eventId: event.eventId, type: event.type, rawType: event.rawType },
      'evento reconhecido mas não acionável',
    );
    return res.status(200).json({ received: true, acted: false, reason: event.type });
  }

  // 4) Persistência idempotente (inclui o snapshot da taxa em tempo real).
  let created: boolean;
  let orderId: string;
  let status: string;
  try {
    const result = await createOrderFromEvent(event);
    created = result.created;
    orderId = result.order.id;
    status = result.order.status;
  } catch (err) {
    if (err instanceof GatewayError && !err.retryable) {
      log.warn({ code: err.code, err: err.message }, 'ordem rejeitada');
      return res.status(400).json({ error: err.code, message: err.message });
    }
    throw err;
  }

  // 5) Dispara a pipeline.
  const shouldProcess =
    created || status === OrderStatus.PENDING || status === OrderStatus.SWAPPED;

  if (shouldProcess && config.isServerless) {
    /**
     * Em serverless a pipeline roda ANTES da resposta.
     *
     * Não existe background aqui: depois do `res.end()` a função pode ser
     * congelada ou morta, então `setImmediate` não garante execução alguma — a
     * ordem ficaria registrada e nunca processada. O custo é uma resposta mais
     * lenta ao provedor; o teto é `serverlessBudgetMs`, e o que não terminar
     * dentro dele é retomado pelo tick do cron.
     */
    const budget = config.runtime.serverlessBudgetMs;
    const started = Date.now();
    let timedOut = false;

    await Promise.race([
      processOrder(orderId).catch((err: unknown) =>
        log.error({ orderId, err }, 'processOrder falhou'),
      ),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, budget),
      ),
    ]);

    const fresh = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });

    return res.status(202).json({
      received: true,
      acted: true,
      duplicate: !created,
      orderId,
      status: fresh?.status ?? status,
      processedInline: true,
      elapsedMs: Date.now() - started,
      ...(timedOut
        ? { note: 'orçamento da invocação esgotado — o restante será retomado pelo cron' }
        : {}),
    });
  }

  if (shouldProcess) {
    // Host persistente: responde já e processa em background, que aqui é real.
    setImmediate(() => {
      void processOrder(orderId).catch((err: unknown) =>
        log.error({ orderId, err }, 'processOrder estourou fora do handler'),
      );
    });
  }

  return res.status(202).json({ received: true, acted: true, duplicate: !created, orderId, status });
}));

/** Observabilidade: estado de uma ordem, com taxa aplicada e liquidação. */
router.get('/orders/:id', ah(async (req: Request, res: Response) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id as string } });
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  return res.json(jsonSafe(order));
}));

export default router;
