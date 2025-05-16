import * as anchor from "@coral-xyz/anchor";
import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
} from "@solana/web3.js";
import {
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    closeAccount
} from "@solana/spl-token";
import bs58 from "bs58";
import BN from "bn.js";
import "dotenv/config";
import { vaultIdl } from "../target/idl/vault_idl.js";

// --[ Setup ]-----------------------------------------------------------

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_FEE_PAYER_PK))
);
const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
});
anchor.setProvider(provider);

// --[ Constants ]-------------------------------------------------------

const programId = new PublicKey("GYVFfTi9v1cfhZvXg92LPhs65uWcRH8enWbKpSnrKNx3");
const mint = new PublicKey(process.env.USDC_SOL_ADDRESS); // e.g., Devnet USDC
const program = new anchor.Program(vaultIdl, programId, provider);
const user = provider.wallet;

// --[ Helpers ]---------------------------------------------------------

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// --[ Main Execution ]--------------------------------------------------

(async () => {
    console.log("User:", user.publicKey.toBase58());

    // Derive PDAs
    const [position] = PublicKey.findProgramAddressSync(
        [Buffer.from("vpos"), user.publicKey.toBuffer(), mint.toBuffer()],
        program.programId
    );
    const [programAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("auth")],
        program.programId
    );

    // Derive associated token accounts
    const userAta = await getAssociatedTokenAddress(mint, user.publicKey);
    const vaultAccount = await getAssociatedTokenAddress(mint, programAuthority, true);
    const posAccount = await getAssociatedTokenAddress(mint, position, true);

    // Create vault ATA if missing
    const vaultInfo = await connection.getAccountInfo(vaultAccount);
    if (!vaultInfo) {
        const ix = createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            vaultAccount,
            programAuthority,
            mint
        );
        await provider.sendAndConfirm(new Transaction().add(ix));
        console.log("✅ Vault ATA created:", vaultAccount.toBase58());
    }

    const posInfo = await connection.getAccountInfo(posAccount);
    if (!posInfo) {
        const ix = createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            posAccount,
            position,
            mint
        );
        await provider.sendAndConfirm(new Transaction().add(ix));
        console.log("✅ Position ATA created:", posAccount.toBase58());
    }

    console.log("Position PDA:        ", position.toBase58());
    console.log("Program Authority PDA:", programAuthority.toBase58());
    console.log("User ATA:            ", userAta.toBase58());
    console.log("Vault ATA:           ", vaultAccount.toBase58());


    // --[ Optional: Make deposit ]--------------------------------------

    // await program.methods
    //     .deposit(new BN(1_000)) // 0.001 USDC
    //     .accounts({
    //         position,
    //         owner: user.publicKey,
    //         src: userAta,
    //         vault: vaultAccount,
    //         programAuthority,
    //         mint,
    //         tokenProgram: TOKEN_PROGRAM_ID,
    //         systemProgram: SystemProgram.programId,
    //     })
    //     .rpc();
    // console.log("✅ Deposit made");


    // --[ Wait for yield accrual ]---------------------------------------
    // await sleep(10_000);

    // --[ Simulate get_balance() call ]----------------------------------
    // Simulate yield accrual
    const result = await program.methods
        .getBalance()
        .accounts({
            position,
            owner: user.publicKey,
            dst: userAta,
            vault: vaultAccount,
            programAuthority,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
        })
        .simulate();

    const encoded = result.raw.find(line => line.startsWith("Program return"));
    const base64 = encoded?.split(" ").pop(); // gets jAqIpX6NAwAAAAAAAAAAAA==

    const buffer = Buffer.from(base64, 'base64');
    const balanceU128 = buffer.readBigUInt64LE(0) + (buffer.readBigUInt64LE(8) << BigInt(64));
    console.log("💰 Balance (u128):", balanceU128.toString());
    const display = Number(balanceU128) / 1e18;
    console.log(display, "USDC");
    console.log("📈 getBalance logs:", result);
})();
