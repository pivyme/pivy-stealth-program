import { PublicKey, Connection, clusterApiUrl, Keypair } from "@solana/web3.js";
import {
    init,                     // boot-straps the SDK
    addLiquidity,             // helper that builds the ix
    loadKeypairFromFile,      // reads your payer keypair
    PRODUCTION_POOLS,         // pre-baked pool addresses
} from "@perena/numeraire-sdk";
import bs58 from 'bs58';
import 'dotenv/config';

const { SOLANA_FEE_PAYER_PK, TEST_WALLET_PK } = process.env;

(async () => {
    /* ------------------------------------------------------------------ */
    /*  1. Initialise SDK                                                 */
    /* ------------------------------------------------------------------ */
    console.log("Loading payer keypair from", SOLANA_FEE_PAYER_PK);
    const payer = Keypair.fromSecretKey(
        bs58.decode(SOLANA_FEE_PAYER_PK)
    );
    const connection = new Connection('https://api.mainnet-beta.solana.com', {
        commitment: "confirmed",
    });

    // applyD = false ➜ don’t overwrite provider; just give us helpers
    init({ payer, connection, applyD: false });

    /* ------------------------------------------------------------------ */
    /*  2. Build the add_liquidity call                                   */
    /*      –  amounts are in *raw* units (6-decimals for all USD stables)*/
    /* ------------------------------------------------------------------ */
    const MAX = 1_000_000;        //  = 1 USDC/USDT/PYUSD if decimals = 6
    console.log("Pool address:", PRODUCTION_POOLS.tripool);
    const { call } = await addLiquidity({
        pool: new PublicKey(PRODUCTION_POOLS.tripool), // USDC/USDT/PYUSD ➜ USD*
        maxAmountsIn: [15 * MAX, 10 * MAX, 10 * MAX],  // 15 USDC, 10 USDT, 10 PYUSD
        minLpTokenMintAmount: 1,    // mint at least 1 µUSD*
        takeSwaps: true,            // perform internal balancing swaps
    });
    /* ------------------------------------------------------------------ */
    /*  3. Simulate instead of RPC                                        */
    /* ------------------------------------------------------------------ */
    const sim = await call.simulate();     // <-- zero cost; no state change
    console.log("Simulation result:\n", sim);

    /* ------------------------------------------------------------------ */
    /*  4. Pretty-print the outcome                                       */
    /*      sim.events is already ABI-decoded by Anchor                   */
    /* ------------------------------------------------------------------ */
    const { events, logs, units } = sim;

    // Find the AddLiquidity event that tells you how many USD* got minted
    const liqEvt = events.find(e => e.name === "AddLiquidity");
    console.log("Simulation logs:\n", logs.join("\n"));
    console.log("\n--- AddLiquidity event --------------------------------");
    console.dir(liqEvt, { depth: 5 });

    /*  ( optional )                                                       
        If you want to know the cost of actually executing the tx, you
        can look at sim.units (consumed compute units) and decide the tip:
  
        const CU_PRICE = 5_000; // 5 nanosol / CU
        console.log(`Would need ≈ ${(units * CU_PRICE) / 1e9} SOL priority fee`);
    */
})();
