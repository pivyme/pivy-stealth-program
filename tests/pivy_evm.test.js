// cctpStealthDeposit.js
// ================================================================
// Send USDC from Base → Solana directly into a PIVY stealth address
// ================================================================
// 1. Derives a stealth keypair & ATA on Solana (same math as PIVY)
// 2. Approves + depositForBurn() on Base using CCTP
// 3. Polls Circle IRIS API until attestation is ready
// ---------------------------------------------------------------

import 'dotenv/config';
import axios from 'axios';
import bs58 from 'bs58';
import { ethers, parseUnits, hexlify } from 'ethers';
import {
    Connection, Keypair, PublicKey, Transaction,
} from '@solana/web3.js';
import {
    getAssociatedTokenAddress, getAccount,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';

/*──────────────────────────────────────────────────────────────────*/
/*  ENV                                                            */
/*──────────────────────────────────────────────────────────────────*/
const {
    EVM_SENDER_PK,                 // pk of Base wallet (0x… hex)
    BASE_PROVIDER_URL,             // e.g. https://base-mainnet.g.alchemy.com/v2/<key>
    SOLANA_PROVIDER_URL = 'https://api.devnet.solana.com',
    DEST_DOMAIN = 5,               // Circle domain for Solana
    SRC_DOMAIN = 6,                // Circle domain for Base
    USDC_BASE_ADDRESS,             // 0xA0b86991… on Base
    USDC_SOL_ADDRESS,              // USDC mint on Solana
    BASE_TOKEN_MESSENGER,          // TokenMessenger on Base
    SOLANA_FEE_PAYER_PK,           // bs58 secret key for Sol fee payer
} = process.env;

if (!EVM_SENDER_PK || !BASE_PROVIDER_URL || !USDC_BASE_ADDRESS || !USDC_SOL_ADDRESS || !BASE_TOKEN_MESSENGER || !SOLANA_FEE_PAYER_PK) {
    throw new Error('Missing required env vars');
}

const AMOUNT = parseUnits('0.025', 6);          // 25 USDC

/*──────────────────────────────────────────────────────────────────*/
/*  EVM setup                                                      */
/*──────────────────────────────────────────────────────────────────*/
const evmProvider = new ethers.JsonRpcProvider(BASE_PROVIDER_URL);
const evmWallet = new ethers.Wallet(EVM_SENDER_PK, evmProvider);

/*──────────────────────────────────────────────────────────────────*/
/*  Solana setup                                                   */
/*──────────────────────────────────────────────────────────────────*/
const solConnection = new Connection(SOLANA_PROVIDER_URL, 'confirmed');
const feePayer = Keypair.fromSecretKey(bs58.decode(SOLANA_FEE_PAYER_PK));

/*──────────────────────────────────────────────────────────────────*/
/*  Stealth math (UNCHANGED)                                       */
/*──────────────────────────────────────────────────────────────────*/
const L = BigInt('0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed');
const bytesToNumberLE = (u8) => u8.reduceRight((p, c) => (p << 8n) + BigInt(c), 0n);
const mod = (x, n) => ((x % n) + n) % n;

async function deriveStealthKeypair(metaSpend, metaViewPk, ephPriv) {
    const shared = await ed.getSharedSecret(ephPriv, metaViewPk);
    const tweak = mod(BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')), L);
    const a = bytesToNumberLE(metaSpend.secretKey.subarray(0, 32));
    const s = mod(a + tweak, L);

    const seed = Uint8Array.from(
        s.toString(16).padStart(64, '0').match(/.{2}/g).map((b) => parseInt(b, 16))
    );
    const pk = await ed.getPublicKey(seed);
    const sk = new Uint8Array(64);
    sk.set(seed, 0); sk.set(pk, 32);
    return Keypair.fromSecretKey(sk);
}

/*──────────────────────────────────────────────────────────────────*/
/*  Helpers                                                        */
/*──────────────────────────────────────────────────────────────────*/
async function getOrCreateUsdcAta(connection, owner, payer) {
    const mint = new PublicKey(USDC_SOL_ADDRESS);
    const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    try {
        await getAccount(connection, ata);
        return ata;
    } catch (_) {
        const ix = createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint);
        const tx = new Transaction().add(ix);
        await connection.sendTransaction(tx, [payer]);
        return ata;
    }
}

function solanaAddressToHex(solanaAddress) {
    return hexlify(bs58.decode(solanaAddress));
}

async function approveUSDC(amount) {
    const ERC20_ABI = [
        'function approve(address,uint256) external returns (bool)',
        'function allowance(address owner,address spender) view returns (uint256)',
    ];
    const usdc = new ethers.Contract(USDC_BASE_ADDRESS, ERC20_ABI, evmWallet);
    const allowance = await usdc.allowance(await evmWallet.getAddress(), BASE_TOKEN_MESSENGER);
    if (allowance >= amount) {
        console.log('✓ allowance sufficient');
        return;
    }
    console.log('→ approving USDC…');
    const tx = await usdc.approve(BASE_TOKEN_MESSENGER, amount);
    await tx.wait();
    console.log('✓ approved:', tx.hash);
}

async function depositForBurn(amount, destDomain, recipientBytes32) {
    const TM_ABI = ['function depositForBurn(uint256,uint32,bytes32,address)'];
    const messenger = new ethers.Contract(BASE_TOKEN_MESSENGER, TM_ABI, evmWallet);
    const tx = await messenger.depositForBurn(amount, destDomain, recipientBytes32, USDC_BASE_ADDRESS);
    await tx.wait();
    console.log('✓ depositForBurn tx:', tx.hash);
    return tx.hash;
}

async function retrieveAttestation(srcDomain, burnTxHash, maxRetries = 12) {
    const url = `https://iris-api-sandbox.circle.com/v1/messages/${srcDomain}/${burnTxHash}`;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const { data } = await axios.get(url);
            const msg = data?.messages?.[0];
            if (msg && msg.attestation !== 'PENDING') {
                console.log('✓ attestation ready');
                return msg;
            }
            console.log('… awaiting attestation');
        } catch (e) {
            console.log('⚠️  iris error, retrying');
        }
        await new Promise(r => setTimeout(r, 15000));
    }
    throw new Error('attestation not ready after max retries');
}

/*──────────────────────────────────────────────────────────────────*/
/*  Main flow                                                      */
/*──────────────────────────────────────────────────────────────────*/
(async () => {
    console.log('\n🚀 Starting cross‑chain stealth transfer…');

    // 1 — derive stealth owner & its ATA on Solana
    console.log('🔐 deriving stealth keys');
    const metaSpend = Keypair.generate();
    const metaView = Keypair.generate();
    const eph = Keypair.generate();
    const stealthKP = await deriveStealthKeypair(metaSpend, metaView.publicKey.toBytes(), eph.secretKey.subarray(0, 32));
    const stealthAta = await getOrCreateUsdcAta(solConnection, stealthKP.publicKey, feePayer);
    console.log('   stealth owner :', stealthKP.publicKey.toBase58());
    console.log('   stealth ATA   :', stealthAta.toBase58());

    // 2 — approve USDC on Base
    await approveUSDC(AMOUNT);

    // 3 — burn & bridge via CCTP
    const recipientBytes32 = solanaAddressToHex(stealthAta.toBase58());
    console.log('   recipient bytes32:', recipientBytes32);
    const burnTxHash = await depositForBurn(AMOUNT, Number(DEST_DOMAIN), recipientBytes32);

    // 4 — poll Circle for attestation (optional until Sol side redemption)
    const attestation = await retrieveAttestation(Number(SRC_DOMAIN), burnTxHash);
    console.log('Attestation payload:', attestation);

    console.log('\n🎉 done — funds are en‑route to stealth ATA');
})();
