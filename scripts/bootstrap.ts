import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import * as os from "os";

// Mainnet program id (matches target/deploy/curve_launchpad-keypair.json).
const PROGRAM_ID = new PublicKey(
  "GLstzf6zSDdU44K1GUCPKy9NyZx7qyUpb9L8qrXCrADo"
);

// stacSOL LST quote mint (Token-2022 with TransferFee).
const QUOTE_MINT = new PublicKey(
  "6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f"
);

// Defaults from `initialize.rs` — kept identical so set_params re-asserts
// the same bonding-curve shape.
const INIT_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
const INIT_VIRTUAL_QUOTE_RESERVES = 30_000_000_000n;
const INIT_REAL_TOKEN_RESERVES = 1_000_000_000n * 1_000_000n; // 1B tokens at 6 decimals
const INIT_TOKEN_SUPPLY = INIT_REAL_TOKEN_RESERVES;
const FEE_BASIS_POINTS = 50n; // 0.5%

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

const RPC =
  process.env.RPC_URL ??
  "https://staccov-mainnet-ea06.mainnet.rpcpool.com/a44f86d9-7661-457d-b65b-fd66b26ee183";
const WALLET = process.env.WALLET ?? `${os.homedir()}/manager.json`;

const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  Buffer.from(JSON.parse(readFileSync(WALLET, "utf-8")))
);

const [globalPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("global")],
  PROGRAM_ID
);
const [eventAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from("__event_authority")],
  PROGRAM_ID
);

console.log("payer        :", payer.publicKey.toBase58());
console.log("program      :", PROGRAM_ID.toBase58());
console.log("global PDA   :", globalPda.toBase58());
console.log("event_auth   :", eventAuthority.toBase58());

async function maybeInitialize() {
  const info = await connection.getAccountInfo(globalPda);
  if (info && info.owner.equals(PROGRAM_ID)) {
    console.log("global already initialized — skipping initialize");
    return;
  }

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // authority
      { pubkey: globalPda, isSigner: false, isWritable: true }, // global
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("initialize"),
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ix
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log("✓ initialize  :", sig);
}

async function setParams() {
  // Args order matches `set_params.rs`:
  //   fee_recipient, withdraw_authority,
  //   initial_virtual_token_reserves, initial_virtual_quote_reserves,
  //   initial_real_token_reserves, initial_token_supply, fee_basis_points,
  //   quote_mint
  const data = Buffer.concat([
    disc("set_params"),
    payer.publicKey.toBuffer(), // fee_recipient = manager.json
    payer.publicKey.toBuffer(), // withdraw_authority = manager.json
    u64LE(INIT_VIRTUAL_TOKEN_RESERVES),
    u64LE(INIT_VIRTUAL_QUOTE_RESERVES),
    u64LE(INIT_REAL_TOKEN_RESERVES),
    u64LE(INIT_TOKEN_SUPPLY),
    u64LE(FEE_BASIS_POINTS),
    QUOTE_MINT.toBuffer(),
  ]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: globalPda, isSigner: false, isWritable: true }, // global (mut)
      { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // user (authority signer)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // #[event_cpi] trailing pair
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ix
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log("✓ set_params  :", sig);
}

(async () => {
  await maybeInitialize();
  await setParams();

  // Dump Global to confirm the on-chain state matches.
  const info = await connection.getAccountInfo(globalPda);
  if (!info) throw new Error("global vanished after init");
  console.log("global account:", info.data.length, "bytes,", info.lamports, "lamports");
})();
