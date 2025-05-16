import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha512 } from '@noble/hashes/sha512';

const L = BigInt('0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed');
const mod = (x, n) => ((x % n) + n) % n;

const to32u8 = (raw) =>
  raw instanceof Uint8Array ? raw
    : /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex')
      : typeof raw === 'string' ? bs58.decode(raw)
        : raw.type === 'Buffer' ? Uint8Array.from(raw.data)
          : (() => { throw new Error('unsupported key') })();

function clamp(sk) {
  const clamped = new Uint8Array(sk);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;
  return clamped;
}

function bnTo32BytesLE(bn) {
  const bytes = new Uint8Array(32);
  let temp = bn;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return bytes;
}

function scalarFromSeed(seed32) {
  // Ed25519 secret scalar derivation (RFC 8032 §5.1.5)
  const h = sha512(seed32);
  return bytesToNumberLE(clamp(h.slice(0, 32)));
}


const bytesToNumberLE = (u8) => u8.reduceRight((p, c) => (p << 8n) + BigInt(c), 0n);

// STEP 1 — Decrypt ephPriv from encrypted memo
export async function decryptEphemeralPrivKey(
  encodedPayload,
  metaViewPriv,
  ephPub
) {
  const payload = bs58.decode(encodedPayload);
  const nonce = payload.slice(0, 24);
  const encrypted = payload.slice(24);

  const shared = await ed.getSharedSecret(
    to32u8(metaViewPriv),
    to32u8(ephPub)
  );

  const keyBytes = sha256(shared);

  const decrypted = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
  }

  // ephemeral private key + ephemeral public key concatenated
  const ephPriv32 = decrypted.slice(0, 32);
  const receivedEphPub = decrypted.slice(32);
  const computedPub = await ed.getPublicKey(ephPriv32);

  let match = true;
  for (let i = 0; i < computedPub.length; i++) {
    if (computedPub[i] !== receivedEphPub[i]) {
      match = false;
      break;
    }
  }

  if (!match) {
    throw new Error("Decryption failed: ephemeral public key mismatch");
  }

  return ephPriv32;
}

// Derives stealth pubkey from metaSpendPub, metaViewPub, ephPriv
async function deriveStealthPub(metaSpend58, metaView58, ephPriv32) {
  // 1. tweak = H(e ⨁ B) mod L
  const shared = await ed.getSharedSecret(
    ephPriv32,
    new PublicKey(metaView58).toBytes(),
  );
  const tweak = mod(BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')), L);

  // 2. S = A + tweak·G
  const Abytes = new PublicKey(metaSpend58).toBytes();
  let Sbytes;
  if (ed.utils.pointAddScalar) {
    Sbytes = ed.utils.pointAddScalar(Abytes, tweak);
  } else {
    const A = ed25519.ExtendedPoint.fromHex(Abytes);
    const S = A.add(ed25519.ExtendedPoint.BASE.multiply(tweak));
    Sbytes = S.toRawBytes();
  }
  return new PublicKey(Sbytes);
}

// STEP 2 — Derive stealth Keypair from metaSpendPriv + ephPriv + metaViewPub
export async function deriveStealthKeypair(metaSpendPrivHex, metaViewPub58, ephPriv32) {
  // 1. expected pubkey via point addition ——
  const metaSpendPub58 = bs58.encode(
    await ed.getPublicKey(Buffer.from(metaSpendPrivHex, 'hex')),
  );
  const stealthPub = await deriveStealthPub(metaSpendPub58, metaViewPub58, ephPriv32);

  // 2. tweak & stealth scalar ——
  const shared = await ed.getSharedSecret(
    ephPriv32,
    new PublicKey(metaViewPub58).toBytes(),
  );
  const tweak = mod(BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')), L);

  const a = scalarFromSeed(Buffer.from(metaSpendPrivHex, 'hex'));
  const s = mod(a + tweak, L);

  const sBytes = bnTo32BytesLE(s);
  // Derive public key directly from scalar (avoid hashing/clamp again)
  const Sbytes = ed25519.ExtendedPoint.BASE.multiply(s).toRawBytes();

  // 3. 64-byte secret key = [scalar || pub]
  const secret = new Uint8Array(64);
  secret.set(sBytes, 0);
  secret.set(Sbytes, 32);

  // 4. sanity check
  const ok = stealthPub.equals(new PublicKey(Sbytes));
  if (!ok) throw new Error('Math mismatch: derived pub ≠ point-add pub');

  return Keypair.fromSecretKey(secret, { skipValidation: true });
}


// Example usage
(async () => {
  // example data (replace with your real encrypted memo, keys etc)
  const encryptedMemo = "2mipLpdKK8pB4VJRhZkHSwapjEF8HK3dqyEqrGL7rC6Z3zhNX37rT4Ppfx6hEvuKZZPE9tKTGc3AqBBaKvc6AGQgZAZGS5hcfvjHbqwQNyGZFjtaW5Le72VEf";
  const metaViewPriv = "c3a2139ccf33c946d1874137670b369e63a4ddcab4783d155366660d95b85c96";
  const metaSpendPriv = "2655570c8102d3a7bbc04d97b730a3ce8dcd1be3fa6751a05880b242bf406fc1";
  const ephPub58 = "6S1N3RZQXPN4yguUBHFNtKzP8tV2Y7M9U5yy121rTcmg";

  const unclampedMetaSpendPub = bs58.encode(await ed.getPublicKey(to32u8(metaSpendPriv)));
  const clampedMetaSpendPub = bs58.encode(await ed.getPublicKey(clamp(to32u8(metaSpendPriv))));
  console.log("🔍 metaSpendPub (raw/unclamped):   ", unclampedMetaSpendPub);
  console.log("🔍 metaSpendPub (clamped):         ", clampedMetaSpendPub);

  // Choose unclamped to match original usage; adjust if needed
  const metaSpendPub = unclampedMetaSpendPub;
  const metaViewPub = bs58.encode(await ed.getPublicKey(to32u8(metaViewPriv)));

  console.log("🏁 Expected stealth owner address hint:", "CdCQUJ5tYNjJLiGWeq6yaYrNMwCzbVM2Ly4XGb2PPb56");

  // Decrypt ephPriv from memo (step 1)
  const ephPriv = await decryptEphemeralPrivKey(encryptedMemo, metaViewPriv, ephPub58);

  console.log("🗝 Decrypted ephemeral priv key (before clamp):", bs58.encode(ephPriv));

  // Clamp ephemeral private key (important per ed25519 spec)
  const clampedEphPriv = clamp(ephPriv);

  // Derive stealth keypair (step 2)
  const stealthKeypair = await deriveStealthKeypair(metaSpendPriv, metaViewPub, clampedEphPriv);

  console.log("🦸‍♂️ Stealth keypair info:");
  console.log("Address (pubkey):", stealthKeypair.stealthPubkey);
  console.log("SecretKey (base58):", bs58.encode(stealthKeypair.validKeypair.secretKey));
})();