/**
 * Gera uma keypair nova para o vault e imprime nos dois formatos aceitos
 * pelo config (base58 e array de 64 bytes).
 *
 *   npm run keygen
 *
 * A chave privada é impressa em stdout — não rode isto num terminal com log
 * persistido nem cole o output em ferramentas de terceiros.
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const kp = Keypair.generate();

console.log('\n  Public key (endereço do vault):');
console.log(`  ${kp.publicKey.toBase58()}\n`);
console.log('  VAULT_PRIVATE_KEY (base58, formato Phantom):');
console.log(`  ${bs58.encode(kp.secretKey)}\n`);
console.log('  VAULT_PRIVATE_KEY (array, formato solana-keygen):');
console.log(`  ${JSON.stringify(Array.from(kp.secretKey))}\n`);
console.log('  Financie este endereço com SOL para as fees antes de usar.\n');
