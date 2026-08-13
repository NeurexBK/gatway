import crypto from 'node:crypto';
import type { Request } from 'express';
import { PublicKey } from '@solana/web3.js';
import { config } from '../config';
import {
  FiatCurrency,
  GatewayError,
  SUPPORTED_CURRENCIES,
  type NormalizedFiatEvent,
  type RawBodyRequest,
  type SignatureVerification,
} from '../types';
import { logger } from '../utils/logger';

/**
 * Validação de webhook do provedor fiat (HMAC SHA-256) + normalização do
 * payload.
 *
 * O esquema é o padrão da indústria (Stripe/SpherePay/MoonPay v2):
 *   header: `t=<unix>,v1=<hex>`   →   assinatura = HMAC(secret, `${t}.${rawBody}`)
 *
 * Três detalhes que decidem se isto é seguro ou teatro:
 *  1. O HMAC é sobre o **corpo cru**, não sobre o JSON re-serializado.
 *  2. Comparação em tempo constante (`timingSafeEqual`).
 *  3. Timestamp dentro da janela de tolerância — sem isso, um atacante que
 *     capture um payload válido pode reenviá-lo para sempre.
 */

const log = logger.child({ scope: 'webhook' });

/** Headers de assinatura aceitos, em ordem de preferência. */
const SIGNATURE_HEADERS = [
  'x-spherepay-signature',
  'spherepay-signature',
  'moonpay-signature-v2',
  'moonpay-signature',
  'x-webhook-signature',
  'x-signature',
] as const;

interface ParsedSignatureHeader {
  timestamp: number | null;
  signatures: string[];
}

/** Aceita `t=..,v1=..` (com múltiplos v1 na rotação de segredo) ou hex puro. */
function parseSignatureHeader(raw: string): ParsedSignatureHeader {
  if (!raw.includes('=')) return { timestamp: null, signatures: [raw.trim()] };

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of raw.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') {
      const parsedTs = Number(value);
      // Alguns provedores enviam ms; normalizamos para segundos.
      timestamp = Number.isFinite(parsedTs)
        ? parsedTs > 1e12
          ? Math.floor(parsedTs / 1000)
          : parsedTs
        : null;
    } else if (key === 'v1' || key === 's' || key === 'signature' || key === 'v0') {
      signatures.push(value);
    }
  }

  return { timestamp, signatures };
}

function hmacHex(payload: string): string {
  return crypto.createHmac('sha256', config.fiat.webhookSecret).update(payload, 'utf8').digest('hex');
}

/** Compara em tempo constante, tolerando hex ou base64 do outro lado. */
function signatureMatches(expectedHex: string, provided: string): boolean {
  const candidates = [provided];
  if (!/^[0-9a-f]+$/i.test(provided)) {
    try {
      candidates.push(Buffer.from(provided, 'base64').toString('hex'));
    } catch {
      /* ignora: candidato inválido */
    }
  }

  const expected = Buffer.from(expectedHex, 'hex');
  return candidates.some((candidate) => {
    const buf = Buffer.from(candidate.toLowerCase().replace(/^sha256=/, ''), 'hex');
    return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
  });
}

export function getSignatureHeader(req: Request): { name: string; value: string } | null {
  for (const name of SIGNATURE_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string' && value.length > 0) return { name, value };
  }
  return null;
}

/**
 * Verifica a assinatura da requisição. Requer `rawBody` (ver o middleware
 * `express.json({ verify })` em app.ts).
 */
export function verifySignature(req: Request): SignatureVerification {
  const rawBody = (req as Request & RawBodyRequest).rawBody;
  if (!rawBody || rawBody.length === 0) {
    return { valid: false, reason: 'corpo cru ausente — middleware de raw body não aplicado' };
  }

  const header = getSignatureHeader(req);
  if (!header) {
    return { valid: false, reason: 'header de assinatura ausente' };
  }

  const { timestamp, signatures } = parseSignatureHeader(header.value);
  if (signatures.length === 0) {
    return { valid: false, reason: 'header de assinatura mal formado' };
  }

  if (timestamp !== null && config.fiat.toleranceSeconds > 0) {
    const skew = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (skew > config.fiat.toleranceSeconds) {
      return {
        valid: false,
        reason: `timestamp fora da janela de tolerância (${skew}s > ${config.fiat.toleranceSeconds}s)`,
        timestamp,
      };
    }
  }

  const body = rawBody.toString('utf8');
  // Com `t` presente, o payload assinado é `${t}.${body}`; sem, é o body cru.
  const payloads = timestamp !== null ? [`${timestamp}.${body}`, body] : [body];

  for (const payload of payloads) {
    const expected = hmacHex(payload);
    if (signatures.some((sig) => signatureMatches(expected, sig))) {
      return { valid: true, ...(timestamp !== null ? { timestamp } : {}) };
    }
  }

  return { valid: false, reason: 'assinatura HMAC não corresponde' };
}

// ─────────────────────── Normalização do payload ───────────────────────

function pick(obj: Record<string, unknown>, ...paths: string[]): unknown {
  for (const path of paths) {
    let cursor: unknown = obj;
    for (const key of path.split('.')) {
      if (cursor && typeof cursor === 'object' && key in (cursor as Record<string, unknown>)) {
        cursor = (cursor as Record<string, unknown>)[key];
      } else {
        cursor = undefined;
        break;
      }
    }
    if (cursor !== undefined && cursor !== null && cursor !== '') return cursor;
  }
  return undefined;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

function classify(rawType: string, status: string | null): NormalizedFiatEvent['type'] {
  const haystack = `${rawType} ${status ?? ''}`.toLowerCase();
  if (/(completed|complete|succeeded|success|settled|paid|finished)/.test(haystack)) {
    return 'payment.completed';
  }
  if (/(failed|cancel|expired|declined|rejected|error)/.test(haystack)) return 'payment.failed';
  if (/(pending|processing|created|waiting|initiated)/.test(haystack)) return 'payment.pending';
  return 'unknown';
}

/**
 * Converte o valor cripto para base units inteiras. Aceita tanto o valor já em
 * base units (`amountRaw`/`baseUnits`) quanto decimal humano ("125.50"), sem
 * passar por `float` — parsing manual da string para não perder precisão.
 */
function toBaseUnits(value: unknown, decimals: number, alreadyRaw: boolean): bigint {
  const str = asString(value);
  if (str === null) {
    throw new GatewayError('valor cripto ausente no payload', 'MISSING_CRYPTO_AMOUNT', false);
  }
  if (alreadyRaw) {
    if (!/^\d+$/.test(str.trim())) {
      throw new GatewayError(`valor em base units inválido: "${str}"`, 'INVALID_AMOUNT', false);
    }
    return BigInt(str.trim());
  }

  const match = /^(\d+)(?:[.,](\d+))?$/.exec(str.trim());
  if (!match) {
    throw new GatewayError(`valor decimal inválido: "${str}"`, 'INVALID_AMOUNT', false);
  }
  const whole = match[1] ?? '0';
  const frac = (match[2] ?? '').padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

/**
 * Normaliza payloads de SpherePay e MoonPay para um formato único.
 * Os nomes de campo variam entre provedores (e entre versões deles), por isso
 * cada campo é procurado num conjunto de caminhos alternativos.
 */
export function normalizeEvent(body: unknown): NormalizedFiatEvent {
  if (!body || typeof body !== 'object') {
    throw new GatewayError('corpo do webhook não é um objeto JSON', 'INVALID_PAYLOAD', false);
  }
  const root = body as Record<string, unknown>;

  const rawType = asString(pick(root, 'type', 'event', 'eventType', 'data.type')) ?? 'unknown';
  const status = asString(
    pick(root, 'data.status', 'status', 'data.object.status', 'payment.status'),
  );

  const eventId =
    asString(pick(root, 'id', 'eventId', 'event_id', 'data.id', 'data.object.id')) ??
    // Sem id de evento não há idempotência forte; derivamos um hash estável do
    // payload para ao menos bloquear reentregas idênticas.
    `derived_${crypto.createHash('sha256').update(JSON.stringify(root)).digest('hex').slice(0, 32)}`;

  const currencyRaw =
    asString(
      pick(
        root,
        'data.fiatCurrency',
        'data.currency',
        'data.baseCurrencyCode',
        'baseCurrencyCode',
        'currency',
        'data.object.currency',
      ),
    ) ?? '';
  const currency = currencyRaw.toUpperCase() as FiatCurrency;
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new GatewayError(
      `moeda não suportada: "${currencyRaw}" (aceitas: ${SUPPORTED_CURRENCIES.join(', ')})`,
      'UNSUPPORTED_CURRENCY',
      false,
    );
  }

  const fiatAmount =
    asString(
      pick(
        root,
        'data.fiatAmount',
        'data.baseCurrencyAmount',
        'baseCurrencyAmount',
        'data.amount',
        'amount',
      ),
    ) ?? '0';

  // Preferimos base units explícitas; se só houver decimal humano, convertemos.
  const rawUnits = pick(root, 'data.amountRaw', 'data.baseUnits', 'amountRaw', 'data.cryptoAmountRaw');
  const humanUnits = pick(
    root,
    'data.cryptoAmount',
    'data.quoteCurrencyAmount',
    'quoteCurrencyAmount',
    'data.destinationAmount',
    'cryptoAmount',
  );

  const cryptoMint =
    asString(pick(root, 'data.mint', 'data.tokenMint', 'mint', 'data.currencyMint')) ??
    config.swap.inputMint;

  const cryptoAmountRaw = toBaseUnits(
    rawUnits ?? humanUnits,
    config.swap.inputMintDecimals,
    rawUnits !== undefined,
  );

  return {
    provider: config.fiat.provider,
    eventId,
    type: classify(rawType, status),
    paymentId: asString(
      pick(root, 'data.paymentId', 'data.transactionId', 'data.id', 'paymentId', 'transactionId'),
    ),
    customerRef: asString(
      pick(root, 'data.customerId', 'data.customer', 'data.externalCustomerId', 'customerId'),
    ),
    fiatCurrency: currency,
    fiatAmount,
    cryptoAmountRaw,
    cryptoMint,
    // Modelo broker: este é o endereço do CLIENTE, destino do SOL menos a taxa.
    customerWallet: asString(
      pick(
        root,
        'data.walletAddress',
        'data.customerWallet',
        'data.destinationWallet',
        'walletAddress',
        'data.destination',
      ),
    ),
    depositSignature: asString(
      pick(root, 'data.txSignature', 'data.signature', 'data.transactionHash', 'txSignature'),
    ),
    rawType,
  };
}

/**
 * Valida o evento contra esta integração antes de qualquer movimento de
 * dinheiro:
 *
 *  • mint tem de ser o `INPUT_MINT` configurado — sem isto, um evento legítimo
 *    de outro produto do mesmo provedor dispararia um swap com dinheiro que
 *    não chegou;
 *  • a carteira do cliente tem de ser uma public key válida e diferente do
 *    vault — enviar para o próprio vault "liquidaria" a ordem sem o cliente
 *    receber nada.
 */
export function assertEventIsProcessable(event: NormalizedFiatEvent): void {
  if (event.cryptoMint !== config.swap.inputMint) {
    throw new GatewayError(
      `mint do evento (${event.cryptoMint}) difere do INPUT_MINT configurado`,
      'MINT_MISMATCH',
      false,
    );
  }

  if (!event.customerWallet) {
    throw new GatewayError(
      'evento sem carteira do cliente (walletAddress) — impossível liquidar',
      'MISSING_CUSTOMER_WALLET',
      false,
    );
  }
  try {
    new PublicKey(event.customerWallet);
  } catch {
    throw new GatewayError(
      `carteira do cliente inválida: "${event.customerWallet}"`,
      'INVALID_CUSTOMER_WALLET',
      false,
    );
  }
  if (event.customerWallet === config.solana.vaultPublicKey.toBase58()) {
    throw new GatewayError(
      'carteira do cliente é o próprio vault — evento rejeitado',
      'CUSTOMER_IS_VAULT',
      false,
    );
  }

  log.debug(
    { eventId: event.eventId, type: event.type, customerWallet: event.customerWallet },
    'evento validado',
  );
}
