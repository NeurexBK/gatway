/**
 * Assina um payload de teste com FIAT_PROVIDER_SECRET e dispara o webhook —
 * simula o provedor fiat sem precisar de chaves reais.
 *
 *   npm run sign-webhook                       # payload default (100 EUR)
 *   npm run sign-webhook -- ./meu-evento.json  # payload próprio
 *
 * Variáveis opcionais: GATEWAY_URL, AMOUNT, CURRENCY.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import 'dotenv/config';

const secret = process.env.FIAT_PROVIDER_SECRET;
if (!secret) {
  console.error('FIAT_PROVIDER_SECRET não definida (copie .env.example para .env)');
  process.exit(1);
}

const url = process.env.GATEWAY_URL ?? 'http://localhost:3000/webhook/fiat-payment';
const fiatAmount = process.env.AMOUNT ?? '100.00';
const currency = process.env.CURRENCY ?? 'EUR';
const mint = process.env.INPUT_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const decimals = Number(process.env.INPUT_MINT_DECIMALS ?? 6);

const fileArg = process.argv[2];
const payload: unknown = fileArg
  ? JSON.parse(fs.readFileSync(fileArg, 'utf8'))
  : {
      id: `evt_test_${Date.now()}`,
      type: 'payment.completed',
      data: {
        paymentId: `pay_test_${Date.now()}`,
        status: 'completed',
        customerId: 'cus_test_123',
        fiatCurrency: currency,
        fiatAmount,
        // On-ramp credita ~1:1 menos taxa; aqui só simulamos base units.
        amountRaw: String(BigInt(Math.round(Number(fiatAmount) * 10 ** decimals))),
        mint,
        // Modelo broker: carteira do CLIENTE, destino do SOL menos a taxa.
        walletAddress: process.env.CUSTOMER_WALLET ?? '11111111111111111111111111111112',
      },
    };

const body = JSON.stringify(payload);
const timestamp = Math.floor(Date.now() / 1000);
const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

async function main(): Promise<void> {
  console.log(`POST ${url}`);
  console.log(`body: ${body}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-spherepay-signature': `t=${timestamp},v1=${signature}`,
    },
    body,
  });

  console.log(`\n<- ${res.status} ${res.statusText}`);
  console.log(await res.text());
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
