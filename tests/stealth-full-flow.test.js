import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';

/*──────────────────────────────────────────────────────────────────*/
/*  Constants & helpers                                             */
/*──────────────────────────────────────────────────────────────────*/
const L = BigInt(
  '0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed',
);
const mod = (x, n) => ((x % n) + n) % n;

const to32u8 = (raw) =>
  raw instanceof Uint8Array
    ? raw
    : /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : typeof raw === 'string'
    ? bs58.decode(raw)
    : raw.type === 'Buffer'
    ? Uint8Array.from(raw.data)
    : (() => {
        throw new Error('unsupported key');
      })();

function clamp(sk) {
  const clamped = new Uint8Array(sk);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;
  return clamped;
}

const bytesToNumberLE = (u8) =>
  u8.reduceRight((p, c) => (p << 8n) + BigInt(c), 0n);

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

/*──────────────────────────────────────────────────────────────────*/
/*  Encryption helpers (memo ↔︎ ephPriv32)                          */
/*──────────────────────────────────────────────────────────────────*/
export async function encryptEphemeralPrivKey(ephPriv32, metaViewPub58) {
  // 1. shared secret between (ephPriv, metaViewPub)
  const shared = await ed.getSharedSecret(
    ephPriv32,
    new PublicKey(metaViewPub58).toBytes(),
  );
  const keyBytes = sha256(shared); // 32-byte stream key

  // 2. plaintext = ephPriv32 || ephPub
  const ephPub = await ed.getPublicKey(ephPriv32);
  const plain = new Uint8Array([...ephPriv32, ...ephPub]);

  // 3. XOR-encrypt
  const enc = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) enc[i] = plain[i] ^ keyBytes[i % keyBytes.length];

  // 4. prepend 24-byte random nonce (compat with old layout)
  const nonce = randomBytes(24);
  const payload = new Uint8Array([...nonce, ...enc]);

  return bs58.encode(payload);
}

export async function decryptEphemeralPrivKey(encodedPayload, metaViewPrivHex, ephPub58) {
  const payload = bs58.decode(encodedPayload);
  const nonce = payload.slice(0, 24); // ignored but kept for layout compatibility
  const encrypted = payload.slice(24);

  // shared secret between (metaViewPriv, ephPub)
  const shared = await ed.getSharedSecret(
    to32u8(metaViewPrivHex),
    to32u8(ephPub58),
  );
  const keyBytes = sha256(shared);

  const decrypted = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];

  const ephPriv32 = decrypted.slice(0, 32);
  const receivedEphPub = decrypted.slice(32);
  const computedPub = await ed.getPublicKey(ephPriv32);

  if (!computedPub.every((b, i) => b === receivedEphPub[i]))
    throw new Error('Decryption failed: ephPub mismatch');

  return ephPriv32;
}

/*──────────────────────────────────────────────────────────────────*/
/*  Stealth math                                                   */
/*──────────────────────────────────────────────────────────────────*/
export async function deriveStealthPub(metaSpend58, metaView58, ephPriv32) {
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

  // 4. sanity check
  const ok = stealthPub.equals(new PublicKey(Sbytes));
  if (!ok) throw new Error('Math mismatch: derived pub ≠ point-add pub');

  return new StealthSigner(sBytes);
}

/*──────────────────────────────────────────────────────────────────*/
/*  StealthSigner: custom signer that works from scalar            */
/*──────────────────────────────────────────────────────────────────*/
class StealthSigner {
  constructor(sBytes) {
    this.scalarBytes = sBytes; // Uint8Array(32) little-endian scalar s
    this.scalar = bytesToNumberLE(sBytes);
    this.publicKey = new PublicKey(ed25519.ExtendedPoint.BASE.multiply(this.scalar).toRawBytes());
  }

  async signMessage(message) {
    const msg = typeof message === 'string' ? Buffer.from(message) : new Uint8Array(message);

    const prefix = sha512(this.scalarBytes).slice(32); // 32-byte prefix

    const concat = (...arrays) => {
      const total = arrays.reduce((n, a) => n + a.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const a of arrays) {
        out.set(a, off);
        off += a.length;
      }
      return out;
    };

    const r = mod(bytesToNumberLE(sha512(concat(prefix, msg))), L);
    const Rbytes = ed25519.ExtendedPoint.BASE.multiply(r).toRawBytes();

    const k = mod(bytesToNumberLE(sha512(concat(Rbytes, this.publicKey.toBytes(), msg))), L);
    const S = mod(r + k * this.scalar, L);
    const Sbytes = bnTo32BytesLE(S);

    return new Uint8Array([...Rbytes, ...Sbytes]);
  }

  /* Helper so we can call tx.addSignature(pk, sig) later if needed */
  async signTransaction(tx) {
    const sig = await this.signMessage(tx.serializeMessage());
    tx.addSignature(this.publicKey, sig);
    return tx;
  }
}

/*──────────────────────────────────────────────────────────────────*/
/*  Demo flow                                                      */
/*──────────────────────────────────────────────────────────────────*/
(async () => {
  console.log('\n🚀  PIVY stealth address full crypto flow demo');

  /* Step A — meta keys (user-specific, stored privately) */
  const metaSpend = Keypair.generate();
  const metaView = Keypair.generate();
  const metaSpendPrivHex = Buffer.from(metaSpend.secretKey.slice(0, 32)).toString('hex');
  const metaViewPrivHex = Buffer.from(metaView.secretKey.slice(0, 32)).toString('hex');
  const metaSpendPub58 = metaSpend.publicKey.toBase58();
  const metaViewPub58 = metaView.publicKey.toBase58();

  console.log('\n🔐  Meta keys generated');
  console.log('   metaSpendPriv (hex):', metaSpendPrivHex);
  console.log('   metaViewPriv  (hex):', metaViewPrivHex);
  console.log('   metaSpendPub  (b58):', metaSpendPub58);
  console.log('   metaViewPub   (b58):', metaViewPub58);

  /* Step B — payer side builds stealth payment */
  const eph = Keypair.generate();
  const ephPriv32 = eph.secretKey.slice(0, 32);

  const stealthOwner = await deriveStealthPub(metaSpendPub58, metaViewPub58, ephPriv32);
  const encryptedMemo = await encryptEphemeralPrivKey(ephPriv32, metaViewPub58);

  console.log('\n💸  Build pay-tx (off-chain cryptography)');
  console.log('   ephPub        (b58):', eph.publicKey.toBase58());
  console.log('   stealthOwner  (b58):', stealthOwner.toBase58());
  console.log('   memo payload  (b58):', encryptedMemo);

  /* --- payment would hit the chain here --- */

  /* Step C — receiver side decrypts & derives keypair */
  const decryptedEphPriv = await decryptEphemeralPrivKey(
    encryptedMemo,
    metaViewPrivHex,
    eph.publicKey.toBase58(),
  );
  console.log('\n📥  Decrypted ephPriv32 matches?:',
    bs58.encode(decryptedEphPriv) === bs58.encode(ephPriv32));
  console.log("decryptedEphPriv", decryptedEphPriv);
  console.log("ephPriv32", bs58.encode(ephPriv32));

  const stealthKP = await deriveStealthKeypair(
    metaSpendPrivHex,
    metaViewPub58,
    decryptedEphPriv,
  );

  console.log('\n🏦  Stealth owner signer derived');
  console.log('   stealth pubkey (b58):', stealthKP.publicKey.toBase58());
  console.log('   expected pubkey (b58):', stealthOwner.toBase58());
  console.log('   scalar (hex)         :', Buffer.from(stealthKP.scalarBytes).toString('hex'));

  // quick self-test: sign & verify
  const msg = Buffer.from('hello stealth');
  const sig = await stealthKP.signMessage(msg);
  const verified = await ed.verify(sig, msg, stealthKP.publicKey.toBytes());
  console.log('   signature verifies?  :', verified);

  console.log('\n✅  Flow complete — signer ready to addSignature() to transactions');
})(); 