// pivy.stealth.test.js
// ================================================================
// End-to-end test for the PIVY Stealth program
// ================================================================

import 'dotenv/config';
import assert from 'assert';
import BN from 'bn.js';
import bs58 from 'bs58';
import * as anchor from '@coral-xyz/anchor';
import {
  Connection, Keypair, SystemProgram, Transaction, PublicKey,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  mintToChecked,
  createAccount,                    // 👈 regular token-account helper
  transferChecked,
} from '@solana/spl-token';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { PRIVY_STEALTH_IDL } from '../target/idl/IDL.js';

/*──────────────────────────────────────────────────────────────────*/
/*  ENV + provider                                                  */
/*──────────────────────────────────────────────────────────────────*/
const { TEST_WALLET_PK, PIVY_PROGRAM_ADDRESS, CHAIN = 'devnet' } = process.env;
if (!TEST_WALLET_PK || !PIVY_PROGRAM_ADDRESS)
  throw new Error('Provide TEST_WALLET_PK and PIVY_PROGRAM_ADDRESS');

const RPC = CHAIN === 'mainnet-beta'
  ? 'https://api.mainnet-beta.solana.com'
  : 'https://api.devnet.solana.com';

const payerKP = (() => {
  try { return Keypair.fromSecretKey(bs58.decode(TEST_WALLET_PK)); }
  catch { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(TEST_WALLET_PK))); }
})();

const connection = new Connection(RPC, 'confirmed');
const wallet = new anchor.Wallet(payerKP);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
anchor.setProvider(provider);

const PROGRAM_ID = new PublicKey(PIVY_PROGRAM_ADDRESS);
const program = new anchor.Program(PRIVY_STEALTH_IDL, PROGRAM_ID, provider);

/*──────────────────────────────────────────────────────────────────*/
/*  Helpers (⇢ kept identical crypto)                               */
/*──────────────────────────────────────────────────────────────────*/
const L = BigInt('0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed');
const bytesToNumberLE = (u8) => u8.reduceRight((p, c) => (p << 8n) + BigInt(c), 0n);
const mod = (x, n) => ((x % n) + n) % n;

async function deriveStealthKeypair(metaSpend, metaViewPk, ephPriv) {
  const shared = await ed.getSharedSecret(ephPriv, metaViewPk);
  const tweak = mod(
    BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')),
    L,
  );
  const a = bytesToNumberLE(metaSpend.secretKey.subarray(0, 32));
  const s = mod(a + tweak, L);
  const seed = Uint8Array.from(
    s.toString(16).padStart(64, '0').match(/.{2}/g).map((b) => parseInt(b, 16))
  );
  const pk = await ed.getPublicKey(seed);
  const sk = new Uint8Array(64); sk.set(seed, 0); sk.set(pk, 32);
  return Keypair.fromSecretKey(sk);
}

/*──────────────────────────────────────────────────────────────────*/
/*  Test flow                                                       */
/*──────────────────────────────────────────────────────────────────*/
(async () => {
  console.log(`\n🌐  RPC            : ${RPC}`);
  console.log(`👛  Test wallet    : ${payerKP.publicKey}`);
  console.log(`📦  Program        : ${PROGRAM_ID}\n`);

  /* 1️⃣ mint test-USDC and fund payer --------------------------------*/
  console.log('🚧 1. Creating test USDC mint');
  const mint = await createMint(connection, payerKP, payerKP.publicKey, null, 6);
  const payerAta = getAssociatedTokenAddressSync(mint, payerKP.publicKey);
  await provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payerKP.publicKey, payerAta, payerKP.publicKey, mint
      )
    ), [payerKP]
  );
  await mintToChecked(connection, payerKP, mint, payerAta, payerKP.publicKey, 1_000_000_000, 6);
  console.log('   ✓ minted & funded\n');

  /* 2️⃣ derive stealth keys ------------------------------------------*/
  console.log('🔐 2. Deriving stealth address');
  const metaSpend = Keypair.generate();
  const metaView = Keypair.generate();
  const eph = Keypair.generate();
  const stealthKP = await deriveStealthKeypair(
    metaSpend, metaView.publicKey.toBytes(), eph.secretKey.subarray(0, 32)
  );
  const stealthAta = getAssociatedTokenAddressSync(mint, stealthKP.publicKey);
  console.log('   Stealth owner  :', stealthKP.publicKey.toBase58());
  console.log('   Stealth ATA    :', stealthAta.toBase58(), '\n');

  /* 3️⃣ pay 25 USDC --------------------------------------------------*/
  console.log('💸 3. Paying 25 USDC into stealth');
  const labelBuf = Buffer.alloc(32); labelBuf.write('freelance');
  const payIx = await program.methods.pay({
    amount: new BN(25_000_000),
    label: [...labelBuf],
    ephPubkey: eph.publicKey,
  }).accounts({
    stealthOwner: stealthKP.publicKey,
    stealthAta,
    payer: payerKP.publicKey,
    payerAta,
    mint,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  }).instruction();
  await provider.sendAndConfirm(new Transaction().add(payIx), [payerKP]);
  console.log('   ✓ payment done\n');

  /* 4️⃣ withdraw 5 + sweep remainder --------------------------------*/
  console.log('🏦 4. Withdrawing via program');
  // create a *regular* token account owned by stealth key (not an ATA)
  const collectorTA = await createAccount(
    connection, payerKP, mint, stealthKP.publicKey
  );
  console.log('   Collector TA   :', collectorTA.toBase58());

  // 4-a withdraw 5
  await program.methods.withdraw({ amount: new BN(5_000_000) })
    .accounts({
      stealthOwner: stealthKP.publicKey, stealthAta, destinationAta: collectorTA,
      mint, tokenProgram: TOKEN_PROGRAM_ID
    })
    .signers([stealthKP]).rpc();
  console.log('   ✓ withdrew 5 USDC');

  // 4-b sweep rest
  const remaining = Number((await getAccount(connection, stealthAta)).amount);
  await program.methods.withdraw({ amount: new BN(remaining) })
    .accounts({
      stealthOwner: stealthKP.publicKey, stealthAta, destinationAta: collectorTA,
      mint, tokenProgram: TOKEN_PROGRAM_ID
    })
    .signers([stealthKP]).rpc();
  console.log('   ✓ withdrew remaining & program closed stealth ATA\n');

  /* 5️⃣ move funds to test wallet -----------------------------------*/
  console.log('➡️ 5. Moving funds to test wallet ATA');
  const finalWalletAta = getAssociatedTokenAddressSync(mint, payerKP.publicKey);
  await provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payerKP.publicKey, finalWalletAta, payerKP.publicKey, mint
      ),
      transferChecked({
        source: collectorTA,
        mint,
        decimals: 6,
        destination: finalWalletAta,
        owner: stealthKP.publicKey,
        amount: 25_000_000,
      })
    ), [stealthKP]
  );
  const endBal = Number((await getAccount(connection, finalWalletAta)).amount);
  assert.strictEqual(endBal, 25_000_000, 'final balance should be 25 USDC');
  console.log('   ✓ transferred – test wallet now holds 25 USDC');

  console.log('\n✅  All steps succeeded\n');
})();
