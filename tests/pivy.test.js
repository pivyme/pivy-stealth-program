// pivy.stealth.test.js
// ================================================================
// End-to-end test for PIVY Stealth program — with clear logging
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
  createAccount,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { PRIVY_STEALTH_IDL } from '../target/idl/IDL.js';

/*──────────────────────────────────────────────────────────────────*/
/*  ENV & provider                                                  */
/*──────────────────────────────────────────────────────────────────*/
const {
  TEST_WALLET_PK,
  PIVY_PROGRAM_ADDRESS,
  CHAIN = 'devnet',
} = process.env;
if (!TEST_WALLET_PK || !PIVY_PROGRAM_ADDRESS)
  throw new Error('Set TEST_WALLET_PK and PIVY_PROGRAM_ADDRESS in .env');

const RPC =
  CHAIN === 'mainnet-beta'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com';

const payerKP = (() => {
  try {
    return Keypair.fromSecretKey(bs58.decode(TEST_WALLET_PK));
  } catch {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(TEST_WALLET_PK)));
  }
})();
const connection = new Connection(RPC, 'confirmed');
const wallet = new anchor.Wallet(payerKP);
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: 'confirmed',
});
anchor.setProvider(provider);

const PROGRAM_ID = new PublicKey(PIVY_PROGRAM_ADDRESS);
const program = new anchor.Program(PRIVY_STEALTH_IDL, PROGRAM_ID, provider);

/*──────────────────────────────────────────────────────────────────*/
/*  Helper: derive stealth keypair (UNCHANGED math)                 */
/*──────────────────────────────────────────────────────────────────*/
const L = BigInt(
  '0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed',
);
const bytesToNumberLE = (u8) =>
  u8.reduceRight((p, c) => (p << 8n) + BigInt(c), 0n);
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
    s
      .toString(16)
      .padStart(64, '0')
      .match(/.{2}/g)
      .map((b) => parseInt(b, 16)),
  );
  const pk = await ed.getPublicKey(seed);
  const sk = new Uint8Array(64);
  sk.set(seed, 0);
  sk.set(pk, 32);
  return Keypair.fromSecretKey(sk);
}

/*──────────────────────────────────────────────────────────────────*/
/*  Test flow                                                       */
/*──────────────────────────────────────────────────────────────────*/
(async () => {
  console.log('\n🌐 RPC            :', RPC);
  console.log('👛 Test wallet    :', payerKP.publicKey.toBase58());
  console.log('📦 Program        :', PROGRAM_ID.toBase58(), '\n');

  /* 1 — Mint test USDC & fund payer ------------------------------*/
  console.log('🔧 1. Minting test USDC and funding wallet …');
  const mint = await createMint(
    connection,
    payerKP,
    payerKP.publicKey,
    null,
    6,
  );
  const payerAta = getAssociatedTokenAddressSync(mint, payerKP.publicKey);
  await provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payerKP.publicKey,
        payerAta,
        payerKP.publicKey,
        mint,
      ),
    ),
    [payerKP],
  );
  await mintToChecked(
    connection,
    payerKP,
    mint,
    payerAta,
    payerKP.publicKey,
    1_000_000_000,
    6,
  );
  console.log('   ✓ wallet funded with 1 000 USDC\n');

  /* 2 — Derive stealth keys -------------------------------------*/
  console.log('🔐 2. Deriving stealth keypair …');
  const metaSpend = Keypair.generate();
  const metaView = Keypair.generate();
  const eph = Keypair.generate();
  const stealthKP = await deriveStealthKeypair(
    metaSpend,
    metaView.publicKey.toBytes(),
    eph.secretKey.subarray(0, 32),
  );
  const stealthAta = getAssociatedTokenAddressSync(mint, stealthKP.publicKey);
  console.log('   Stealth owner  :', stealthKP.publicKey.toBase58());
  console.log('   Stealth ATA    :', stealthAta.toBase58(), '\n');

  /* 3 — Pay 25 USDC ---------------------------------------------*/
  console.log('💸 3. Paying 25 USDC into stealth ATA …');
  const lblPay = Buffer.alloc(32);
  lblPay.write('freelance');
  const payTx = await provider.sendAndConfirm(
    new Transaction().add(
      await program.methods
        .pay({
          amount: new BN(25_000_000),
          label: [...lblPay],
          ephPubkey: eph.publicKey,
        })
        .accounts({
          stealthOwner: stealthKP.publicKey,
          stealthAta,
          payer: payerKP.publicKey,
          payerAta,
          mint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .instruction(),
    ),
    [payerKP],
  );
  console.log('   ✓ payment confirmed');
  console.log('   📝 tx:', payTx, '\n');

  /* 4 — Withdraw (5 then 20) ------------------------------------*/
  console.log('🏦 4. Withdrawing via program …');
  const collectorKp = Keypair.generate();
  const collectorAta = await createAccount(
    connection,
    payerKP,
    mint,
    stealthKP.publicKey,
    collectorKp,
  );
  console.log('   Collector TA   :', collectorAta.toBase58());

  const withdraw1Tx = await program.methods
    .withdraw({ amount: new BN(5_000_000) })
    .accounts({
      stealthOwner: stealthKP.publicKey,
      stealthAta,
      destinationAta: collectorAta,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([stealthKP])
    .rpc();
  console.log('   ✓ withdrew 5 USDC');
  console.log('   📝 tx:', withdraw1Tx);

  const rest = Number((await getAccount(connection, stealthAta)).amount);
  const withdraw2Tx = await program.methods
    .withdraw({ amount: new BN(rest) })
    .accounts({
      stealthOwner: stealthKP.publicKey,
      stealthAta,
      destinationAta: collectorAta,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([stealthKP])
    .rpc();
  console.log('   ✓ withdrew remaining 20 USDC & closed stealth ATA');
  console.log('   📝 tx:', withdraw2Tx, '\n');

  /* 5 — Send to test wallet ATA ---------------------------------*/
  console.log('➡️ 5. Moving 25 USDC into test wallet ATA …');
  const finalAta = getAssociatedTokenAddressSync(mint, payerKP.publicKey);
  const transferTx = await provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payerKP.publicKey,
        finalAta,
        payerKP.publicKey,
        mint,
      ),
      createTransferCheckedInstruction(
        collectorAta,
        mint,
        finalAta,
        stealthKP.publicKey,
        25_000_000,
        6,
      ),
    ),
    [payerKP, stealthKP],
  );

  const end = Number((await getAccount(connection, finalAta)).amount);
  assert.strictEqual(
    end,
    1_000_000_000,
    'wallet balance should be 1 000 USDC',
  );
  console.log('   ✓ transfer complete — balance verified');
  console.log('   📝 tx:', transferTx, '\n');

  /* 6 — Announce 10 USDC (no transfer) ---------------------------*/
  console.log('📣 6. Announcing 10 USDC (log-only, no transfer) …');
  const lblAnn = Buffer.alloc(32);
  lblAnn.write('announce');
  const announceTx = await provider.sendAndConfirm(
    new Transaction().add(
      await program.methods
        .announce({
          amount: new BN(10_000_000),
          label: [...lblAnn],
          ephPubkey: eph.publicKey,
        })
        .accounts({
          stealthOwner: stealthKP.publicKey,
          payer: payerKP.publicKey,
          mint,
        })
        .instruction(),
    ),
    [payerKP],
  );

  const stealthInfo = await connection.getAccountInfo(stealthAta);
  assert.strictEqual(stealthInfo, null, 'stealth ATA should remain closed');
  console.log('   ✓ announce succeeded; no token account recreated');
  console.log('   📝 tx:', announceTx);

  console.log(
    '\n🎉  SUCCESS: pay, withdraw, and announce flows fully validated\n',
  );
})().catch((e) => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
