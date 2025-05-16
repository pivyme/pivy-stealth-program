import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// Constants and utility functions
const L = BigInt('0x1000000000000000000000014def9dea2f79cd65812631a5cf5d3ed');
const mod = (x, n) => ((x % n) + n) % n;

const to32u8 = (raw: any): Uint8Array => 
  raw instanceof Uint8Array ? raw
    : /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex')
    : typeof raw === 'string' ? bs58.decode(raw)
    : raw.type === 'Buffer' ? Uint8Array.from(raw.data)
    : (() => { throw new Error('unsupported key') })();

function clamp(sk: Uint8Array): Uint8Array {
  const clamped = new Uint8Array(sk);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;
  return clamped;
}

function bnTo32BytesLE(bn: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let temp = bn;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return bytes;
}

// Stealth Address Derivation Utilities
export class StealthAddressDeriver {
  /**
   * Decrypt ephemeral private key from encrypted memo
   * @param encodedPayload Base58 encoded encrypted payload
   * @param metaViewPriv Hex-encoded view private key
   * @param ephPub Ephemeral public key in base58
   * @returns Decrypted ephemeral private key
   */
  static async decryptEphemeralPrivKey(
    encodedPayload: string, 
    metaViewPriv: string, 
    ephPub: string
  ): Promise<Uint8Array> {
    const payload = bs58.decode(encodedPayload);
    const encrypted = payload.slice(24); // Skip nonce

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

    // Verify ephemeral public key matches
    if (!receivedEphPub.every((b, i) => b === computedPub[i])) {
      throw new Error("Decryption failed: ephemeral public key mismatch");
    }

    return ephPriv32;
  }

  /**
   * Derive stealth public key
   * @param metaSpend58 Base58 encoded meta spend public key
   * @param metaView58 Base58 encoded meta view public key
   * @param ephPriv32 Ephemeral private key
   * @returns Stealth public key
   */
  static async deriveStealthPub(
    metaSpend58: string, 
    metaView58: string, 
    ephPriv32: Uint8Array
  ): Promise<PublicKey> {
    const shared = await ed.getSharedSecret(
      ephPriv32,
      new PublicKey(metaView58).toBytes()
    );

    const tweak = mod(
      BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')), 
      L
    );

    const Abytes = new PublicKey(metaSpend58).toBytes();

    let Sbytes: Uint8Array;
    if (ed.utils.pointAddScalar) {
      Sbytes = ed.utils.pointAddScalar(Abytes, tweak);
    } else {
      const A = ed25519.ExtendedPoint.fromHex(Abytes);
      const S = A.add(ed25519.ExtendedPoint.BASE.multiply(tweak));
      Sbytes = S.toRawBytes();
    }

    return new PublicKey(Sbytes);
  }

  /**
   * Derive stealth keypair
   * @param metaSpendPriv Hex-encoded meta spend private key
   * @param metaViewPub58 Base58 encoded meta view public key
   * @param ephPriv Ephemeral private key
   * @returns Stealth keypair details
   */
  static async deriveStealthKeypair(
    metaSpendPriv: string,
    metaViewPub58: string,
    ephPriv: Uint8Array
  ) {
    // Derive meta spend public key
    const spendPrivBytes = Buffer.from(metaSpendPriv, 'hex');
    const metaSpendPub = bs58.encode(await ed.getPublicKey(spendPrivBytes));

    // Derive stealth public key
    const stealthPub = await this.deriveStealthPub(
      metaSpendPub, 
      metaViewPub58, 
      ephPriv
    );

    // Compute shared secret and tweak
    const shared = await ed.getSharedSecret(
      ephPriv,
      new PublicKey(metaViewPub58).toBytes()
    );

    const tweak = mod(
      BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')), 
      L
    );

    // Calculate stealth private key
    const a = BigInt('0x' + spendPrivBytes.toString('hex'));
    const s = mod(a + tweak, L);

    // Convert to 32-byte little-endian seed
    const seed = bnTo32BytesLE(s);

    // Verify derived public key
    const derivedPk = await ed.getPublicKey(seed);
    const derivedPubKey = new PublicKey(derivedPk).toBase58();

    console.log("Stealth Pubkey Verification:");
    console.log("- Derived Pubkey:", derivedPubKey);
    console.log("- Expected Pubkey:", stealthPub.toBase58());
    console.log("- Keys Match:", derivedPubKey === stealthPub.toBase58());

    // Create Solana Keypair
    const keypair = Keypair.fromSeed(seed);

    return {
      stealthPubkey: stealthPub.toBase58(),
      stealthPrivateKey: seed,
      validKeypair: keypair
    };
  }

  /**
   * Complete stealth address derivation process
   * @param encryptedMemo Base58 encoded encrypted memo
   * @param metaViewPriv Hex-encoded view private key
   * @param metaSpendPriv Hex-encoded spend private key
   * @param ephPub58 Ephemeral public key in base58
   * @returns Derived stealth keypair
   */
  static async deriveStealthAddress(
    encryptedMemo: string,
    metaViewPriv: string,
    metaSpendPriv: string,
    ephPub58: string
  ) {
    // Decrypt ephemeral private key
    const ephPriv = await this.decryptEphemeralPrivKey(
      encryptedMemo, 
      metaViewPriv, 
      ephPub58
    );

    // Derive meta view and spend public keys
    const metaViewPub = bs58.encode(
      await ed.getPublicKey(to32u8(metaViewPriv))
    );

    // Clamp ephemeral private key
    const clampedEphPriv = clamp(ephPriv);

    // Derive stealth keypair
    return this.deriveStealthKeypair(
      metaSpendPriv, 
      metaViewPub, 
      clampedEphPriv
    );
  }
}

// Example usage
async function exampleUsage() {
  // Replace with actual values from your system
  const encryptedMemo = "your_encrypted_memo_here";
  const metaViewPriv = "your_meta_view_private_key_hex";
  const metaSpendPriv = "your_meta_spend_private_key_hex";
  const ephPub58 = "ephemeral_public_key_in_base58";

  try {
    const stealthKeypair = await StealthAddressDeriver.deriveStealthAddress(
      encryptedMemo,
      metaViewPriv,
      metaSpendPriv,
      ephPub58
    );

    console.log("Stealth Keypair Details:");
    console.log("- Public Address:", stealthKeypair.stealthPubkey);
    console.log("- Private Key (base58):", bs58.encode(stealthKeypair.validKeypair.secretKey));
  } catch (error) {
    console.error("Stealth Address Derivation Failed:", error);
  }
}

// Uncomment to run example
// exampleUsage();

export default StealthAddressDeriver;
