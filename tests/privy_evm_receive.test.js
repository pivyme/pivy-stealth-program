// receiveMessage.js

import 'dotenv/config';
import fs from 'fs';
import bs58 from 'bs58';
import axios from 'axios';
import { PublicKey, Keypair, SystemProgram, Connection, sendAndConfirmTransaction } from '@solana/web3.js';
import {
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { hexlify } from 'ethers';
import * as anchor from '@coral-xyz/anchor';

const { Program, AnchorProvider, setProvider } = anchor;
const { BN } = anchor.default;


// ============ Load IDLs ============
const messageTransmitterIdl = JSON.parse(
    fs.readFileSync('./target/idl/message_transmitter.json', 'utf8')
);
const tokenMessengerMinterIdl = JSON.parse(
    fs.readFileSync('./target/idl/token_messenger_minter.json', 'utf8')
);

// ============ Config ============
const SOLANA_RPC = process.env.SOLANA_PROVIDER_URL;
const SRC_DOMAIN = parseInt(process.env.SRC_DOMAIN);
const DEST_DOMAIN = parseInt(process.env.DEST_DOMAIN);
const USDC_BASE_ADDRESS = process.env.USDC_BASE_ADDRESS;
const USDC_SOL_ADDRESS = new PublicKey(process.env.USDC_SOL_ADDRESS);
const RECIPIENT_ADDRESS = new PublicKey('BKzXfofPKUcsj7tyZQxEJL24rAUasDJzQPiHvGz8rSLA'); // Should change to recipient's Solana address
const txHash = '0x8fce937516d561cbde8f04d2fc444bbe7f1d8dfd594557edfb5d631a400336cf';

const SOLANA_FEE_PAYER = Keypair.fromSecretKey(
    bs58.decode(process.env.SOLANA_FEE_PAYER_PK)
);
const connection = new Connection(SOLANA_RPC, {
    commitment: 'confirmed',
});

// 🎯 Replace with your actual deployed program IDs
const MESSAGE_TRANSMITTER_PROGRAM_ID = new PublicKey('CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd');
const TOKEN_MESSENGER_MINTER_PROGRAM_ID = new PublicKey('CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3');

// ============ Initialize Anchor Provider ============
const provider = new AnchorProvider(
    connection,
    {
        publicKey: SOLANA_FEE_PAYER.publicKey,
        signTransaction: async (tx) => {
            tx.partialSign(SOLANA_FEE_PAYER);
            return tx;
        },
        signAllTransactions: async (txs) =>
            txs.map((tx) => {
                tx.partialSign(SOLANA_FEE_PAYER);
                return tx;
            }),
    },
    { commitment: 'confirmed' }
);
setProvider(provider);

// ============ Load Programs ============

const messageTransmitterProgram = new Program(
    messageTransmitterIdl,
    MESSAGE_TRANSMITTER_PROGRAM_ID,
    provider
);

const tokenMessengerMinterProgram = new Program(
    tokenMessengerMinterIdl,
    TOKEN_MESSENGER_MINTER_PROGRAM_ID,
    provider
);

// ============ Utilities ============
const hexToBytes = (hex) => Buffer.from(hex.replace(/^0x/, ''), 'hex');

const findProgramAddress = (label, programId, extraSeeds = []) => {
    const seeds = [Buffer.from(label)];
    extraSeeds.forEach((seed) => {
        if (typeof seed === 'string') seeds.push(Buffer.from(seed));
        else if (Array.isArray(seed)) seeds.push(Buffer.from(seed));
        else if (Buffer.isBuffer(seed)) seeds.push(seed);
        else if (seed instanceof PublicKey) seeds.push(seed.toBuffer());
    });
    const [pubkey, bump] = PublicKey.findProgramAddressSync(seeds, programId);
    return { publicKey: pubkey, bump };
};

export const decodeEventNonceFromMessage = (messageHex) => {
    const nonceIndex = 12;
    const nonceBytesLength = 8;
    const message = hexToBytes(messageHex);
    const eventNonceBytes = message.subarray(nonceIndex, nonceIndex + nonceBytesLength);
    const eventNonceHex = hexlify(eventNonceBytes);
    return BigInt(eventNonceHex).toString();
};

export async function getReceiveMessagePdas(
    messageTransmitterProgram,
    tokenMessengerMinterProgram,
    solUsdcAddress,
    remoteUsdcAddressHex,
    remoteDomain,
    nonce
) {
    const tokenMessengerAccount = findProgramAddress('token_messenger', tokenMessengerMinterProgram.programId);
    const messageTransmitterAccount = findProgramAddress('message_transmitter', messageTransmitterProgram.programId);
    const tokenMinterAccount = findProgramAddress('token_minter', tokenMessengerMinterProgram.programId);
    const localToken = findProgramAddress('local_token', tokenMessengerMinterProgram.programId, [solUsdcAddress]);
    const remoteTokenMessengerKey = findProgramAddress('remote_token_messenger', tokenMessengerMinterProgram.programId, [remoteDomain]);
    const remoteTokenKey = new PublicKey(hexToBytes(remoteUsdcAddressHex));
    const tokenPair = findProgramAddress('token_pair', tokenMessengerMinterProgram.programId, [remoteDomain, remoteTokenKey]);
    const custodyTokenAccount = findProgramAddress('custody', tokenMessengerMinterProgram.programId, [solUsdcAddress]);
    const authorityPda = findProgramAddress('message_transmitter_authority', messageTransmitterProgram.programId, [tokenMessengerMinterProgram.programId]).publicKey;
    const tokenMessengerEventAuthority = findProgramAddress('__event_authority', tokenMessengerMinterProgram.programId);
    const usedNonces = await messageTransmitterProgram.methods
        .getNoncePda({
            nonce: new BN(nonce),
            sourceDomain: Number(remoteDomain)
        })
        .accounts({
            messageTransmitter: messageTransmitterAccount.publicKey,
        }).view();

    console.log("🔍 Used Nonces PDA:", usedNonces);

    return {
        messageTransmitterAccount,
        tokenMessengerAccount,
        tokenMinterAccount,
        localToken,
        remoteTokenMessengerKey,
        remoteTokenKey,
        tokenPair,
        custodyTokenAccount,
        authorityPda,
        tokenMessengerEventAuthority,
        usedNonces
    };
}

// ============ Retrieve Attestation ============
async function retrieveAttestation(txHash) {
    const url = `https://iris-api-sandbox.circle.com/v1/messages/${SRC_DOMAIN}/${txHash}`;
    console.log("URL:", url);
    let attempts = 0;
    while (true) {
        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Accept': 'application/json',
                },
            });
            if (response.data?.messages?.[0]?.attestation !== "PENDING") {
                console.log("✅ Attestation retrieved");
                return response.data.messages[0];
            }
            console.log("⏳ Waiting for attestation...");
        } catch (err) {
            console.log(`⚠️ Error fetching attestation: ${err}. Retrying...`);
        }
        await new Promise((res) => setTimeout(res, 15000));
        attempts++;
        if (attempts > 10) {
            console.log("❌ Max attempts reached. Exiting...");
            break;
        }
    }
}

// ============ Receive Message ============
async function receiveMessage(messageHex, attestationHex, remoteUsdcHex, nonce) {
    const userTokenAccount = await getAssociatedTokenAddress(USDC_SOL_ADDRESS, RECIPIENT_ADDRESS);
    console.log("🔍 User Token Account:", userTokenAccount.toString());

    const pdas = await getReceiveMessagePdas(
        messageTransmitterProgram,
        tokenMessengerMinterProgram,
        USDC_SOL_ADDRESS,
        remoteUsdcHex,
        SRC_DOMAIN.toString(),
        nonce.toString()
    );

    console.log("🔍 PDAs Retrieved");


    const accountMetas = [
        { pubkey: pdas.tokenMessengerAccount.publicKey, isWritable: false, isSigner: false },
        { pubkey: pdas.remoteTokenMessengerKey.publicKey, isWritable: false, isSigner: false },
        { pubkey: pdas.tokenMinterAccount.publicKey, isWritable: true, isSigner: false },
        { pubkey: pdas.localToken.publicKey, isWritable: true, isSigner: false },
        { pubkey: pdas.tokenPair.publicKey, isWritable: false, isSigner: false },
        { pubkey: userTokenAccount, isWritable: true, isSigner: false },
        { pubkey: pdas.custodyTokenAccount.publicKey, isWritable: true, isSigner: false },
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: pdas.tokenMessengerEventAuthority.publicKey, isWritable: false, isSigner: false },
        { pubkey: tokenMessengerMinterProgram.programId, isWritable: false, isSigner: false },
    ];

    console.log("✅ Account Metas Prepared");

    console.log("🔍 Message:", messageHex.replace(/^0x/, ''),);
    const tx = await messageTransmitterProgram.methods
        .receiveMessage({
            message: Buffer.from(messageHex.replace(/^0x/, ''), 'hex'),
            attestation: Buffer.from(attestationHex.replace('0x', ''), 'hex'),
        })
        .accounts({
            payer: SOLANA_FEE_PAYER.publicKey,
            caller: SOLANA_FEE_PAYER.publicKey,
            authorityPda: pdas.authorityPda,
            messageTransmitter: pdas.messageTransmitterAccount.publicKey,
            usedNonces: pdas.usedNonces,
            receiver: tokenMessengerMinterProgram.programId,
            systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(accountMetas)
        .signers([SOLANA_FEE_PAYER])
        .transaction();
    console.log("🔍 Transaction prepared");

    // Send transaction
    try {
        const txid = await provider.sendAndConfirm(tx);
        console.log("✅ Transaction hash:", txid);
    }
    catch (error) {
        console.error("❌ Transaction failed:", error);
        return;
    }
}

// ============ Main Flow ============
(async () => {
    const attestation = await retrieveAttestation(txHash);

    const messageHex = attestation.message;
    const attestationHex = attestation.attestation;
    console.log("🔍 Message Hex:", messageHex)
    console.log("🔍 Attestation Hex:", attestationHex);

    const remoteUsdcHex = USDC_BASE_ADDRESS;
    const nonce = decodeEventNonceFromMessage(messageHex);
    console.log("🔍 Nonce:", nonce);

    await receiveMessage(messageHex, attestationHex, remoteUsdcHex, nonce);
})();