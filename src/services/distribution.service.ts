import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { config, TOTAL_BPS } from '../config';
import {
  GatewayError,
  type DistributionBatchResult,
  type DistributionResult,
  type RecipientConfig,
  type SplitAllocation,
} from '../types';
import { logger } from '../utils/logger';
import { buildSignAndSend, getBalance, getVaultPublicKey } from './solana.service';
import { getSplitRecipients } from './settings.service';

/**
 * Split nativo por basis points, sem SDK de terceiros: aritmética inteira em
 * `bigint` + `SystemProgram.transfer`.
 *
 * Duas regras não-negociáveis:
 *  1. `sum(allocations) === totalLamports` — exatamente. Nenhum lamport é
 *     criado ou perdido no arredondamento; o resto da divisão inteira vai para
 *     o maior detentor de bps (regra determinística, auditável).
 *  2. Se tudo cabe numa transação, vai numa só — split atômico de verdade:
 *     ou todos os destinatários recebem, ou ninguém recebe.
 *
 * Os destinatários vêm do banco (editáveis no admin), não mais do .env.
 */

const log = logger.child({ scope: 'distribution' });

/** Overhead estimado de fee: 5000 lamports por assinatura, 1 sig por lote. */
const LAMPORTS_PER_SIGNATURE = 5_000n;

// ─────────────────────────── Cálculo do split ───────────────────────────

export function computeSplit(
  totalLamports: bigint,
  recipients: readonly RecipientConfig[],
): SplitAllocation[] {
  if (totalLamports <= 0n) {
    throw new GatewayError(
      `nada a distribuir (total=${totalLamports})`,
      'NOTHING_TO_DISTRIBUTE',
      false,
    );
  }
  if (recipients.length === 0) {
    throw new GatewayError('nenhum destinatário configurado', 'NO_RECIPIENTS', false);
  }

  const bpsSum = recipients.reduce((acc, r) => acc + r.bps, 0);
  if (bpsSum !== TOTAL_BPS) {
    throw new GatewayError(
      `soma de bps inválida: ${bpsSum} (esperado ${TOTAL_BPS})`,
      'INVALID_BPS_SUM',
      false,
    );
  }

  const total = BigInt(TOTAL_BPS);
  const allocations: SplitAllocation[] = recipients.map((r) => ({
    ...r,
    // Divisão inteira: sempre arredonda para baixo, nunca sobre-aloca.
    lamports: (totalLamports * BigInt(r.bps)) / total,
    absorbedRemainder: false,
  }));

  const allocated = allocations.reduce((acc, a) => acc + a.lamports, 0n);
  const remainder = totalLamports - allocated;

  if (remainder > 0n) {
    // Resto (< nº de destinatários lamports) para o maior bps; empate: o primeiro.
    let winner = 0;
    for (let i = 1; i < allocations.length; i += 1) {
      if (allocations[i]!.bps > allocations[winner]!.bps) winner = i;
    }
    const target = allocations[winner]!;
    target.lamports += remainder;
    target.absorbedRemainder = true;
  }

  const finalSum = allocations.reduce((acc, a) => acc + a.lamports, 0n);
  if (finalSum !== totalLamports) {
    // Invariante violada => bug. Melhor explodir do que enviar SOL errado.
    throw new GatewayError(
      `invariante do split violada: ${finalSum} != ${totalLamports}`,
      'SPLIT_INVARIANT_VIOLATED',
      false,
    );
  }

  const tooSmall = allocations.filter((a) => a.lamports < config.distribution.minTransferLamports);
  if (tooSmall.length > 0) {
    throw new GatewayError(
      `share abaixo do mínimo (${config.distribution.minTransferLamports} lamports) para: ` +
        tooSmall.map((a) => `${a.label}=${a.lamports}`).join(', '),
      'SHARE_BELOW_MINIMUM',
      false,
      { minTransferLamports: config.distribution.minTransferLamports.toString() },
    );
  }

  return allocations;
}

/** Split do lucro usando os destinatários ativos do banco. */
export async function computeProfitSplit(totalLamports: bigint): Promise<SplitAllocation[]> {
  return computeSplit(totalLamports, await getSplitRecipients());
}

/**
 * Teto do que o vault pode ceder sem furar a reserva de fee. Nunca
 * distribuímos o saldo inteiro — o vault precisa sobreviver para pagar as
 * fees das próximas ordens.
 */
export async function vaultHeadroomLamports(batches = 1): Promise<bigint> {
  const vaultBalance = await getBalance();
  const reserve = config.distribution.feeReserveLamports;
  const feeBudget = LAMPORTS_PER_SIGNATURE * BigInt(Math.max(batches, 1));
  return vaultBalance > reserve + feeBudget ? vaultBalance - reserve - feeBudget : 0n;
}

/**
 * Quanto do lucro acumulado pode efetivamente sair agora: o menor entre o
 * lucro contabilizado e o headroom real do vault.
 */
export async function clampToVaultHeadroom(
  desiredLamports: bigint,
  recipientCount: number,
): Promise<bigint> {
  const batches = Math.ceil(recipientCount / config.distribution.maxTransfersPerTx);
  const headroom = await vaultHeadroomLamports(batches);
  const amount = desiredLamports < headroom ? desiredLamports : headroom;

  if (amount <= 0n) {
    throw new GatewayError(
      `sem saldo distribuível no vault (desejado=${desiredLamports}, headroom=${headroom})`,
      'INSUFFICIENT_VAULT_BALANCE',
      true,
      { desiredLamports: desiredLamports.toString(), headroom: headroom.toString() },
    );
  }

  log.debug(
    { desired: desiredLamports.toString(), headroom: headroom.toString(), amount: amount.toString() },
    'lucro distribuível calculado',
  );
  return amount;
}

// ─────────────────────────── Execução ───────────────────────────

function toTransferInstruction(address: string, lamports: bigint): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: getVaultPublicKey(),
    toPubkey: new PublicKey(address),
    // `lamports` aceita bigint no web3.js ≥1.87 (tipado como number|bigint).
    lamports,
  });
}

/** Transferência simples do vault para um endereço — usada na liquidação do cliente. */
export async function sendLamports(
  address: string,
  lamports: bigint,
  context: Record<string, unknown> = {},
): Promise<string> {
  if (lamports < config.distribution.minTransferLamports) {
    throw new GatewayError(
      `valor ${lamports} abaixo do mínimo transferível (${config.distribution.minTransferLamports})`,
      'AMOUNT_BELOW_MINIMUM',
      false,
    );
  }
  return buildSignAndSend([toTransferInstruction(address, lamports)], {
    computeUnitLimit: 2_000,
    context,
  });
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Envia o split. Com ≤ `MAX_TRANSFERS_PER_TX` destinatários é UMA transação
 * (atômica). Acima disso, lotes determinísticos — a ordem dos destinatários é
 * estável, então um retry recompõe exatamente os mesmos lotes e o callback
 * `onBatchConfirmed` permite retomar sem repagar quem já recebeu.
 */
export async function distribute(
  allocations: readonly SplitAllocation[],
  options: {
    context?: Record<string, unknown>;
    onBatchConfirmed?: (batch: DistributionBatchResult) => Promise<void>;
  } = {},
): Promise<DistributionResult> {
  const { context = {}, onBatchConfirmed } = options;
  const batches = chunk(allocations, config.distribution.maxTransfersPerTx);
  const results: DistributionBatchResult[] = [];

  log.info(
    {
      ...context,
      recipients: allocations.length,
      batches: batches.length,
      atomic: batches.length === 1,
      totalSol: Number(allocations.reduce((acc, a) => acc + a.lamports, 0n)) / 1e9,
    },
    'iniciando distribuição',
  );

  for (const [batchIndex, group] of batches.entries()) {
    const instructions = group.map((a) => toTransferInstruction(a.address, a.lamports));
    const batchLamports = group.reduce((acc, a) => acc + a.lamports, 0n);

    const signature = await buildSignAndSend(instructions, {
      // ~450 CU por transfer + folga.
      computeUnitLimit: 1_000 + group.length * 1_000,
      context: { ...context, step: 'distribute', batchIndex },
    });

    const result: DistributionBatchResult = {
      batchIndex,
      signature,
      addresses: group.map((a) => a.address),
      lamports: batchLamports,
    };
    results.push(result);

    // Persistir ANTES do próximo lote: se o processo morrer aqui, o retry
    // sabe que este lote já foi pago.
    if (onBatchConfirmed) await onBatchConfirmed(result);

    log.info(
      { ...context, batchIndex, signature, batchSol: Number(batchLamports) / 1e9 },
      'lote distribuído',
    );
  }

  return {
    totalDistributedLamports: results.reduce((acc, r) => acc + r.lamports, 0n),
    batches: results,
    allocations: [...allocations],
  };
}

/** Pré-visualização do split (sem tocar na rede) — usada pelo admin. */
export async function previewSplit(totalLamports: bigint): Promise<
  Array<{
    label: string;
    address: string;
    bps: number;
    percent: string;
    lamports: string;
    sol: number;
  }>
> {
  const allocations = await computeProfitSplit(totalLamports);
  return allocations.map((a) => ({
    label: a.label,
    address: a.address,
    bps: a.bps,
    percent: `${(a.bps / 100).toFixed(2)}%`,
    lamports: a.lamports.toString(),
    sol: Number(a.lamports) / 1e9,
  }));
}
