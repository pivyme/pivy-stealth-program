import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const L = BigInt('0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed');
const mod = (x, n) => ((x % n) + n) % n;
const to32u8 = raw =>
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
  const hex = bn.toString(16).padStart(64, '0');
  hex.match(/.{2}/g).forEach((byte, i) => {
    bytes[i] = parseInt(byte, 16);
  });
  return bytes;
}

// STEP 1 — Decrypt ephPriv from encrypted memo
export async function decryptEphemeralPrivKey(encodedPayload, metaViewPriv, ephPub) {
  // 1. Decode the payload
  const payload = bs58.decode(encodedPayload);

  // 2. Extract nonce and encrypted data
  const nonce = payload.slice(0, 24);
  const encrypted = payload.slice(24);

  // 3. Generate the shared secret using meta view private key and ephemeral public key
  const shared = await ed.getSharedSecret(
    to32u8(metaViewPriv),
    to32u8(ephPub)
  );

  // 4. Derive the same key used for encryption
  const keyBytes = sha256(shared);

  // 5. Decrypt the data
  const decrypted = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
  }

  // 6. Verify and return the ephemeral private key
  const ephPriv32 = decrypted.slice(0, 32);
  const receivedEphPub = decrypted.slice(32);
  const computedPub = await ed.getPublicKey(ephPriv32);

  // 7. Verify the decrypted ephemeral private key matches the expected public key
  let match = true;
  for (let i = 0; i < computedPub.length; i++) {
    if (computedPub[i] !== receivedEphPub[i]) {
      match = false;
      break;
    }
  }

  if (!match) {
    throw new Error("Decryption failed: public key mismatch");
  }

  return ephPriv32;
}


// STEP 2 — Derive stealth Keypair from metaSpendPriv + ephPriv + metaViewPub
async function deriveStealthKeypair(metaSpendPriv, metaViewPub, ephPriv) {
  // 1. First, derive the stealth public key exactly like in deriveStealthPub
  const spendPrivBytes = Buffer.from(metaSpendPriv, 'hex');
  const metaSpendPub = bs58.encode(await ed.getPublicKey(spendPrivBytes));
  
  // Use the exact same deriveStealthPub function for consistency
  const stealthPub = await deriveStealthPub(metaSpendPub, metaViewPub, ephPriv);
  console.log("✅ Stealth pubkey from point addition:", stealthPub.toBase58());
  
  // 2. Now compute the stealth private key
  // Compute shared secret exactly like in deriveStealthPub
  const shared = await ed.getSharedSecret(
    ephPriv,
    new PublicKey(metaViewPub).toBytes()
  );
  
  // Calculate tweak = H(shared) mod L
  const tweak = mod(
    BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')),
    L
  );
  
  // Calculate stealth private key: s = a + tweak (mod L)
  const a = BigInt('0x' + Buffer.from(spendPrivBytes).toString('hex'));
  const s = mod(a + tweak, L);
  
  // Convert scalar to bytes
  const seed = Uint8Array.from(
    s.toString(16)
      .padStart(64, '0')
      .match(/.{2}/g)
      .map((b) => parseInt(b, 16))
  );
  
  // 3. Create a proper keypair from scratch
  // First verify our private key actually derives to the expected public key
  const derivedPk = await ed.getPublicKey(seed);
  const derivedPubKey = new PublicKey(derivedPk).toBase58();
  console.log("✅ Private key derivation yields:", derivedPubKey);
  console.log("🔑 Keys match?:", derivedPubKey === stealthPub.toBase58());
  
  // Since we can't force Solana to use a mismatched keypair, return
  // just the info needed instead of a keypair
  return {
    // This is the key that matches what the frontend creates
    stealthPubkey: stealthPub.toBase58(),
    // This is the private key we calculated
    stealthPrivateKey: seed,
    // We can create a valid Solana keypair, but the public key won't match
    // what the frontend expects
    validKeypair: Keypair.fromSeed(seed)
  };
}

// For verification: Duplicate of the frontend's function
async function deriveStealthPub(metaSpend58, metaView58, ephPriv32) {
  /* 1. e ⨁ B  → shared */
  const shared = await ed.getSharedSecret(
    ephPriv32,
    new PublicKey(metaView58).toBytes()
  );

  /* 2. tweak = H(shared) mod L */
  const tweak = mod(
    BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')), L);

  /* 3. S = A + tweak·G */
  const Abytes = new PublicKey(metaSpend58).toBytes();

  let Sbytes;
  if (ed.utils.pointAddScalar) {
    // ↳ noble ≥ 1.8 path
    Sbytes = ed.utils.pointAddScalar(Abytes, tweak);
  } else {
    // ↳ universal fallback via @noble/curves
    const A = ed25519.ExtendedPoint.fromHex(Abytes);
    const S = A.add(ed25519.ExtendedPoint.BASE.multiply(tweak));
    Sbytes = S.toRawBytes();
  }

  return new PublicKey(Sbytes);
}

// MAIN
(async () => {
  const encryptedMemo = "KdLu5joVURjR2UDGTAnMEMMw9WUbLbKQwSxHNdJCGTA6Yue7cBmbXAuzA42dLEGmEHNUBWyNaQMQV7EYNdXfZKYkFJDDVL73P4tfkp1GxUZZFTtpGwPL2KMT";
  const metaViewPriv = "d832637c318096881cf63b39b52b9fb4002036e7284b48407d9525191c3b138a";
  const metaSpendPriv = "171fe0867a4b528e8401421672a319ef3597a95405ac2dbc71f52e3c3912d753";
  const ephPub58 = "6S1N3RZQXPN4yguUBHFNtKzP8tV2Y7M9U5yy121rTcmg";

  // Derive the view public key from the private key (base58 format)
  const viewPrivBytes = Buffer.from(metaViewPriv, "hex");
  const viewPubBytes = await ed.getPublicKey(viewPrivBytes);
  const metaViewPub = bs58.encode(viewPubBytes);
  
  // Decrypt the ephemeral private key
  const ephPriv32 = await decryptEphemeralPrivKey(encryptedMemo, metaViewPriv, ephPub58);
  console.log("ephPriv32", ephPriv32);
  
  // Create a stealth keypair
  const stealthKp = await deriveStealthKeypair(metaSpendPriv, metaViewPub, ephPriv32);

  console.log("✅ Stealth pubkey :", stealthKp.stealthPubkey);
  console.log("🔑 Stealth secret:", bs58.encode(stealthKp.stealthPrivateKey));

  // Also calculate the pubkey using just deriveStealthPub for comparison
  const spendPrivBytes = Buffer.from(metaSpendPriv, 'hex');
  const metaSpendPub = bs58.encode(await ed.getPublicKey(spendPrivBytes));
  const stealthPubKey = await deriveStealthPub(metaSpendPub, metaViewPub, ephPriv32);
  console.log("✓ Verification with deriveStealthPub:", stealthPubKey.toBase58());
  console.log("✓ Keys match?", stealthKp.stealthPubkey === stealthPubKey.toBase58());
})();
