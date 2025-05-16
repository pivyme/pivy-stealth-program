// create-keypair.js

import fs from "fs";
import { Keypair } from "@solana/web3.js";
import 'dotenv/config';
import bs58 from 'bs58';

// const keypair = Keypair.fromSecretKey(
//     bs58.decode(process.env.SOLANA_FEE_PAYER_PK)
// );
const secretKey = Array.from(bs58.decode(process.env.SOLANA_FEE_PAYER_PK));

fs.writeFileSync("keypair.json", JSON.stringify(secretKey));

console.log("✅ Keypair saved to keypair.json");
// console.log("📌 Public Key:", keypair.publicKey.toBase58());