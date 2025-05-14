// pivy.test.js — final version
// ================================================================
import "dotenv/config";
import assert from "assert";
import BN from "bn.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { PRIVY_STEALTH_IDL } from "../target/idl/IDL.js";

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  mintToChecked,
  transferChecked,
  createSyncNativeInstruction,
  NATIVE_MINT,
  closeAccount,
} from "@solana/spl-token";
import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";

/*──────────────────────────────────────────────────────────────────*/
/* ENV                                                               */
/*──────────────────────────────────────────────────────────────────*/
const TEST_WALLET_PK        = process.env.TEST_WALLET_PK;
const CHAIN                 = process.env.CHAIN ?? "devnet";
const PIVY_PROGRAM_ADDRESS  = process.env.PIVY_PROGRAM_ADDRESS; // optional in anchor test

if (!TEST_WALLET_PK) throw new Error("TEST_WALLET_PK missing in .env");

/*──────────────────────────────────────────────────────────────────*/
const RPC = CHAIN === "mainnet-beta"
  ? "https://api.mainnet-beta.solana.com"
  : "https://api.devnet.solana.com";
/*──────────────────────────────────────────────────────────────────*/
const payerKP = (() => {
  try { return Keypair.fromSecretKey(bs58.decode(TEST_WALLET_PK)); }
  catch { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(TEST_WALLET_PK))); }
})();

const connection = new Connection(RPC, "confirmed");
const wallet     = new anchor.Wallet(payerKP);
const provider   = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
anchor.setProvider(provider);

/*──────────────────────────────────────────────────────────────────*/
/* Program loading logic (workspace → local IDL JSON fallback)      */
/*──────────────────────────────────────────────────────────────────*/
//------------------------------------------------------------------
//  Program loader (no workspace, no metadata.address needed)
//------------------------------------------------------------------
if (!process.env.PIVY_PROGRAM_ADDRESS)
  throw new Error("Set PIVY_PROGRAM_ADDRESS in .env");

const PROGRAM_ID = new PublicKey(process.env.PIVY_PROGRAM_ADDRESS);

// Use the imported IDL directly
const program = new anchor.Program(PRIVY_STEALTH_IDL, PROGRAM_ID, provider);

console.log({
  PROGRAM_ID
})

/*──────────────────────────────────────────────────────────────────*/
/* Stealth helpers                                                  */
/*──────────────────────────────────────────────────────────────────*/
const L = BigInt(
  "0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"
);
const bytesToNumberLE = (u8) =>
  u8.reduceRight((p, c) => (p << 8n) + BigInt(c), 0n);
const mod = (x, n) => ((x % n) + n) % n;

export async function deriveStealthKeypair(metaSpend, metaViewPk, ephPriv) {
  console.log("\n🔑 Deriving Stealth Keypair...");
  console.log("├─ Meta View Public Key:", metaViewPk.toString('hex'));
  console.log("├─ Ephemeral Private Key:", ephPriv.toString('hex').slice(0, 20) + "...");
  
  const shared = await ed.getSharedSecret(ephPriv, metaViewPk);
  console.log("├─ Shared Secret Generated:", shared.toString('hex').slice(0, 20) + "...");
  
  const hash = sha256(shared);
  const hashHex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
  console.log("├─ Hash Generated:", hashHex.slice(0, 20) + "...");
  
  const tweak = mod(BigInt(`0x${hashHex}`), L);
  const a = bytesToNumberLE(metaSpend.secretKey.subarray(0, 32));
  const s = mod(a + tweak, L);
  console.log("└─ Tweak Applied");

  const seed = Uint8Array.from(
    s.toString(16).padStart(64, "0").match(/.{2}/g).map((b)=>parseInt(b,16))
  );
  const pk = await ed.getPublicKey(seed);
  const sk = new Uint8Array(64);
  sk.set(seed, 0); sk.set(pk, 32);
  return Keypair.fromSecretKey(sk);
}

/*──────── SOL wrap / unwrap (client side) ────────*/
export async function wrapSol(payer, lamports) {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  const tx = new Transaction()
    .add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        ata,
        payer.publicKey,
        NATIVE_MINT
      )
    )
    .add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: ata,
        lamports,
      })
    )
    .add(createSyncNativeInstruction(ata));
  await provider.sendAndConfirm(tx, [payer]);
  return ata;
}
export async function unwrapSol(payer) {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  if (!(await connection.getAccountInfo(ata))) return;
  await provider.sendAndConfirm(
    new Transaction().add(
      closeAccount({ source: ata, destination: payer.publicKey, owner: payer.publicKey })
    ), [payer]
  );
}

/*──────── preparePayIx (frontend helper) ─────────*/
export async function preparePayIx({
  payer,
  mint,
  payerAta,
  stealthOwner,
  stealthAta,
  amount,
  label,
  ephPubkey,
}) {
  const labelBuf = Buffer.alloc(32);
  labelBuf.write(label);
  return await program.methods
    .pay({
      amount: new BN(amount),
      label: [...labelBuf],
      ephPubkey,
    })
    .accounts({
      stealthOwner,
      stealthAta,
      payer: payer.publicKey,
      payerAta,
      mint,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .instruction();
}

/*──────────────────────────────────────────────────────────────────*/
/*  End-to-end test                                                */
/*──────────────────────────────────────────────────────────────────*/
(async () => {
  console.log("\n🚀 Starting Pivy Stealth Payment Test");
  console.log("├─ RPC:", RPC);
  console.log("├─ Payer:", payerKP.publicKey.toBase58());
  console.log("└─ Program:", program.programId.toBase58(), "\n");

  /* 1️⃣ Mint 6-dec test USDC and fund payer */
  console.log("💰 Creating Test USDC Token");
  console.log("├─ Decimals: 6");
  const mint = await createMint(connection, payerKP, payerKP.publicKey, null, 6);
  console.log("├─ Mint Address:", mint.toBase58());
  
  const payerAta = getAssociatedTokenAddressSync(mint, payerKP.publicKey);
  console.log("└─ Payer ATA:", payerAta.toBase58());

  console.log("\n💳 Funding Payer Account");
  await provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payerKP.publicKey, payerAta, payerKP.publicKey, mint
      )
    ), [payerKP]
  );
  await mintToChecked(
    connection, payerKP, mint, payerAta, payerKP.publicKey, 1_000_000_000, 6
  );
  console.log("└─ Minted 1,000 USDC to payer");

  /* 2️⃣ Derive stealth address */
  console.log("\n🎭 Generating Stealth Payment Details");
  const metaSpend = Keypair.generate();
  const metaView = Keypair.generate();
  const eph = Keypair.generate();
  console.log("├─ Meta Spend Public Key:", metaSpend.publicKey.toBase58());
  console.log("├─ Meta View Public Key:", metaView.publicKey.toBase58());
  console.log("└─ Ephemeral Public Key:", eph.publicKey.toBase58());

  const stealthKP = await deriveStealthKeypair(
    metaSpend, metaView.publicKey.toBytes(), eph.secretKey.subarray(0,32)
  );
  const stealthOwner = stealthKP.publicKey;
  const stealthAta = getAssociatedTokenAddressSync(mint, stealthOwner);
  
  console.log("\n👻 Stealth Address Generated");
  console.log("├─ Stealth Owner:", stealthOwner.toBase58());
  console.log("└─ Stealth ATA:", stealthAta.toBase58());

  /* 3️⃣ Pay 25 USDC */
  console.log("\n💸 Sending Stealth Payment");
  console.log("├─ Amount: 25 USDC");
  console.log("├─ Label: freelance");
  const payIx = await preparePayIx({
    payer: payerKP, mint, payerAta, stealthOwner, stealthAta,
    amount: 25_000_000, label: "freelance", ephPubkey: eph.publicKey
  });
  await provider.sendAndConfirm(new Transaction().add(payIx), [payerKP]);
  console.log("└─ Payment Sent Successfully");

  const stealthBalance = Number((await getAccount(connection, stealthAta)).amount);
  console.log("\n💎 Stealth Balance:", stealthBalance / 1_000_000, "USDC");

  /* 4️⃣ Withdraw all (auto-close) */
  console.log("\n🏦 Withdrawing from Stealth Address");
  const destAta = getAssociatedTokenAddressSync(mint, stealthOwner);
  await provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payerKP.publicKey, destAta, stealthOwner, mint
      )
    ), [payerKP]
  );

  // First, transfer the exact amount
  await program.methods
    .withdraw({ amount: new BN(stealthBalance) })
    .accounts({
      stealthOwner,
      stealthAta,
      destinationAta: destAta,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([stealthKP])
    .rpc();
  console.log("├─ Transferred funds to destination");

  // Then, close the empty account
  await program.methods
    .withdraw({ amount: new BN(0) })
    .accounts({
      stealthOwner,
      stealthAta,
      destinationAta: destAta,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([stealthKP])
    .rpc();
  console.log("├─ Closed stealth ATA");

  const finalBalance = Number((await getAccount(connection, destAta)).amount);
  console.log("├─ Withdrawn to:", destAta.toBase58());
  console.log("└─ Final Balance:", finalBalance / 1_000_000, "USDC");

  console.log("\n✅ All tests passed (pay + withdraw w/ ATA auto-close)\n");
})();
