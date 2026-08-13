import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
import { config, LAMPORTS_PER_SOL } from '../config';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';

/**
 * Camada de acesso à Solana: conexão, leitura de saldos e envio confiável de
 * transações.
 *
 * O envio NÃO usa `sendAndConfirmTransaction` do web3.js porque ele desiste
 * cedo demais em rede congestionada. Aqui rebroadcastamos a mesma tx assinada
 * (mesma assinatura, portanto sem risco de duplicar o efeito) até o blockhash
 * expirar — que é o único ponto em que se pode afirmar com segurança que a tx
 * não vai mais entrar.
 */

const CONFIRM_POLL_INTERVAL_MS = 1_000;
const REBROADCAST_INTERVAL_MS = 2_000;

export const connection = new Connection(config.solana.rpcEndpoint, {
  commitment: 'confirmed',
  disableRetryOnRateLimit: false,
});

/** Conexão dedicada ao broadcast (permite RPC com staked connections). */
export const sendConnection =
  config.solana.sendEndpoint === config.solana.rpcEndpoint
    ? connection
    : new Connection(config.solana.sendEndpoint, { commitment: 'confirmed' });

const vault: Keypair = config.solana.vaultKeypair;

export function getVaultPublicKey(): PublicKey {
  return config.solana.vaultPublicKey;
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────── Leituras ───────────────────────────────

/** Saldo nativo (lamports) de uma conta; default: o vault. */
export async function getBalance(owner: PublicKey = getVaultPublicKey()): Promise<bigint> {
  const lamports = await connection.getBalance(owner, 'confirmed');
  return BigInt(lamports);
}

/**
 * Saldo de um SPL token em base units. Retorna 0n quando a ATA ainda não
 * existe — situação normal antes do primeiro settlement do on-ramp.
 */
export async function getTokenBalanceRaw(
  mint: string,
  owner: PublicKey = getVaultPublicKey(),
): Promise<bigint> {
  const ata = await getAssociatedTokenAddress(new PublicKey(mint), owner, true);
  try {
    const account = await getAccount(connection, ata, 'confirmed');
    return account.amount;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TokenAccountNotFoundError' || name === 'TokenInvalidAccountOwnerError') {
      return 0n;
    }
    throw err;
  }
}

/**
 * Espera até o vault ter `minAmountRaw` do mint. O on-ramp confirma o
 * pagamento fiat por webhook antes de o settlement on-chain aterrar, então
 * a pipeline precisa deste ponto de sincronização.
 */
export async function waitForTokenBalance(
  mint: string,
  minAmountRaw: bigint,
  timeoutMs: number = config.runtime.depositWaitTimeoutMs,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let observed = 0n;
  let attempt = 0;

  do {
    observed = await getTokenBalanceRaw(mint);
    if (observed >= minAmountRaw) return observed;

    attempt += 1;
    // Backoff: 1s, 2s, 3s… teto de 5s.
    await sleep(Math.min(1_000 * attempt, 5_000));
  } while (Date.now() < deadline);

  throw new GatewayError(
    `depósito não aterrou no vault dentro de ${timeoutMs}ms ` +
      `(esperado >= ${minAmountRaw}, observado ${observed})`,
    'DEPOSIT_TIMEOUT',
    true,
    { mint, minAmountRaw: minAmountRaw.toString(), observed: observed.toString() },
  );
}

// ─────────────────────────────── Envio ───────────────────────────────

/**
 * Broadcast + confirmação de uma tx JÁ assinada.
 *
 * Reenviar a mesma tx assinada é idempotente na Solana: a rede desduplica por
 * assinatura, então rebroadcast agressivo é seguro e é a forma correta de
 * sobreviver a congestionamento.
 */
export async function sendSignedTransaction(
  transaction: VersionedTransaction,
  lastValidBlockHeight: number,
  context: Record<string, unknown> = {},
): Promise<string> {
  const raw = transaction.serialize();
  const log = logger.child({ scope: 'solana.send', ...context });

  const signature = await sendConnection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 0, // nós controlamos o rebroadcast
  });

  log.debug({ signature, lastValidBlockHeight }, 'tx enviada, aguardando confirmação');

  let lastRebroadcast = Date.now();

  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];

    if (status) {
      if (status.err) {
        throw new GatewayError(
          `transação falhou on-chain: ${JSON.stringify(status.err)}`,
          'TX_FAILED_ONCHAIN',
          false, // já executou e falhou: reenviar não muda o resultado
          { signature, err: status.err },
        );
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        log.info({ signature, slot: status.slot }, 'tx confirmada');
        return signature;
      }
    }

    const blockHeight = await connection.getBlockHeight('confirmed');
    if (blockHeight > lastValidBlockHeight) {
      // Blockhash expirou sem inclusão: a tx nunca será executada.
      throw new TransactionExpiredBlockheightExceededError(signature);
    }

    if (Date.now() - lastRebroadcast >= REBROADCAST_INTERVAL_MS) {
      lastRebroadcast = Date.now();
      await sendConnection
        .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
        .catch((err: unknown) => log.debug({ err }, 'rebroadcast falhou (ignorado)'));
    }

    await sleep(CONFIRM_POLL_INTERVAL_MS);
  }
}

/**
 * Monta uma tx v0 a partir de instruções, assina com o vault e envia.
 * Usado pela distribuição (o swap vem pré-montado pelo Jupiter).
 */
export async function buildSignAndSend(
  instructions: TransactionInstruction[],
  options: {
    priorityFeeMicroLamports?: number;
    computeUnitLimit?: number;
    context?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const {
    priorityFeeMicroLamports = config.swap.priorityFeeMicroLamports,
    computeUnitLimit,
    context = {},
  } = options;

  const preamble: TransactionInstruction[] = [];
  if (priorityFeeMicroLamports > 0) {
    preamble.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    );
  }
  if (computeUnitLimit !== undefined) {
    preamble.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const message = new TransactionMessage({
    payerKey: vault.publicKey,
    recentBlockhash: blockhash,
    instructions: [...preamble, ...instructions],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  transaction.sign([vault]);

  return sendSignedTransaction(transaction, lastValidBlockHeight, context);
}

/** Assina (com o vault) uma tx que veio pronta de fora — ex.: Jupiter. */
export function signWithVault(transaction: VersionedTransaction): VersionedTransaction {
  transaction.sign([vault]);
  return transaction;
}

/** Sanity check de boot: RPC alcançável e saldo do vault para fees. */
export async function assertSolanaReachable(): Promise<{ slot: number; vaultLamports: bigint }> {
  const [slot, vaultLamports] = await Promise.all([connection.getSlot('confirmed'), getBalance()]);
  if (vaultLamports < config.distribution.feeReserveLamports) {
    logger.warn(
      {
        vaultSol: lamportsToSol(vaultLamports),
        reserveSol: lamportsToSol(config.distribution.feeReserveLamports),
      },
      'saldo do vault abaixo da reserva de fee — swaps podem falhar',
    );
  }
  return { slot, vaultLamports };
}
