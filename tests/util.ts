import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as client from "../client/";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeTransferFeeConfigInstruction,
  createInitializeMintInstruction as createTokenMintInstruction,
} from "@solana/spl-token";
import idl from "./curve-launchpad-idl.json";

// ---------------------------------------------------------------------------
// Typed Program client
//
// The Rust workspace's anchor-cli IDL emission is broken upstream
// (proc-macro2 panics during the `idl-build` feature compile). We hand-roll
// a minimal IDL in `./curve-launchpad-idl.json` so `new Program(idl, provider)`
// gives us the namespace shape the tests want without needing the regenerated
// `target/types/curve_launchpad.ts`. Anchor 0.30.1 takes the program address
// from `idl.address`.
// ---------------------------------------------------------------------------

export const loadProgram = (provider: anchor.AnchorProvider) => {
  // Cast through `unknown` — the imported JSON's `kind` literals widen to
  // `string`, but anchor's IDL types require precise discriminated unions.
  return new anchor.Program(idl as unknown as anchor.Idl, provider);
};

export const CURVE_LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "GLstzf6zSDdU44K1GUCPKy9NyZx7qyUpb9L8qrXCrADo",
);

// Event names from the IDL, normalised to camelCase the way anchor exposes them.
const validEventNames = [
  "completeEvent",
  "createEvent",
  "setParamsEvent",
  "tradeEvent",
  "flipEvent",
  "migrateEvent",
] as const;
type EventName = typeof validEventNames[number];

export const getTransactionEvents = (
  program: anchor.Program,
  txResponse: anchor.web3.VersionedTransactionResponse | null,
) => {
  if (!txResponse) {
    return [];
  }

  let [eventPDA] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    program.programId,
  );

  let indexOfEventPDA =
    txResponse.transaction.message.staticAccountKeys.findIndex((key) =>
      key.equals(eventPDA),
    );

  if (indexOfEventPDA === -1) {
    return [];
  }

  const matchingInstructions = txResponse.meta?.innerInstructions
    ?.flatMap((ix) => ix.instructions)
    .filter(
      (instruction) =>
        instruction.accounts.length === 1 &&
        instruction.accounts[0] === indexOfEventPDA,
    );

  if (matchingInstructions) {
    let events = matchingInstructions.map((instruction) => {
      const ixData = anchor.utils.bytes.bs58.decode(instruction.data);
      const eventData = anchor.utils.bytes.base64.encode(ixData.slice(8));
      const event = program.coder.events.decode(eventData);
      return event;
    });
    const isNotNull = <T>(value: T | null): value is T => value !== null;
    return events.filter(isNotNull);
  } else {
    return [];
  }
};

const isEventName = (eventName: string): eventName is EventName => {
  return (validEventNames as readonly string[]).includes(eventName);
};

export const toEvent = (eventName: EventName, event: any): any | null => {
  if (isEventName(eventName)) {
    return event?.data ?? null;
  }
  return null;
};

export const buildVersionedTx = async (
  connection: anchor.web3.Connection,
  payer: PublicKey,
  tx: Transaction,
) => {
  const blockHash = (await connection.getLatestBlockhash("processed"))
    .blockhash;

  let messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockHash,
    instructions: tx.instructions,
  }).compileToV0Message();

  return new VersionedTransaction(messageV0);
};

export const getTxDetails = async (
  connection: anchor.web3.Connection,
  sig: string,
) => {
  const latestBlockHash = await connection.getLatestBlockhash("processed");

  await connection.confirmTransaction(
    {
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: sig,
    },
    "confirmed",
  );

  return await connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
};

export const sendTransaction = async (
  program: anchor.Program,
  tx: Transaction,
  signers: anchor.web3.Signer[],
  payer: PublicKey,
) => {
  const versionedTx = await buildVersionedTx(
    program.provider.connection,
    payer,
    tx,
  );
  versionedTx.sign(signers);

  let sig = await program.provider.connection.sendTransaction(versionedTx, {});
  let response = await getTxDetails(program.provider.connection, sig);
  let events = getTransactionEvents(program, response);
  return {
    response,
    events,
  };
};

export const getAnchorError = (error: any) => {
  if (error instanceof anchor.AnchorError) {
    return error;
  } else if (error instanceof SendTransactionError) {
    return anchor.AnchorError.parse(error.logs || []);
  }
  return null;
};

export const fundAccountSOL = async (
  connection: anchor.web3.Connection,
  publicKey: anchor.web3.PublicKey,
  amount: number,
) => {
  let fundSig = await connection.requestAirdrop(publicKey, amount);

  return getTxDetails(connection, fundSig);
};

// ---------------------------------------------------------------------------
// AMM bridging
//
// The `client.AMM` class still uses the legacy SOL field names internally
// (virtualSolReserves / realSolReserves) because it's a port of the on-chain
// rust struct from before the rename. The on-chain field names are now
// `*_quote_*`. We adapt by reading the new names off the BondingCurve
// account and feeding them in positional order to the AMM constructor.
// ---------------------------------------------------------------------------

export const ammFromBondingCurve = (
  bondingCurveAccount: any | null,
  initialVirtualTokenReserves: bigint,
) => {
  if (!bondingCurveAccount) throw new Error("Bonding curve account not found");
  return new client.AMM(
    BigInt(bondingCurveAccount.virtualQuoteReserves.toString()),
    BigInt(bondingCurveAccount.virtualTokenReserves.toString()),
    BigInt(bondingCurveAccount.realQuoteReserves.toString()),
    BigInt(bondingCurveAccount.realTokenReserves.toString()),
    initialVirtualTokenReserves,
  );
};

export const bigIntToSOL = (amount: bigint) => {
  return amount / BigInt(LAMPORTS_PER_SOL);
};

export const getSPLBalance = async (
  connection: Connection,
  mintAddress: PublicKey,
  pubKey: PublicKey,
  allowOffCurve: boolean = false,
  programId: PublicKey = TOKEN_PROGRAM_ID,
) => {
  try {
    let ata = getAssociatedTokenAddressSync(
      mintAddress,
      pubKey,
      allowOffCurve,
      programId,
    );
    const balance = await connection.getTokenAccountBalance(ata, "processed");
    return balance.value.amount;
  } catch (e) {
    // intentionally swallow — caller is checking "did this account exist with
    // this balance" semantics and treats 0 / missing the same way.
  }
  return "0";
};

// ---------------------------------------------------------------------------
// Mock LST (Token-2022 with TransferFee extension)
//
// The real STACC_QUOTE_MINT lives on mainnet and we don't depend on cloning
// it via Anchor.toml because (a) it forces network in localnet, (b) we want
// deterministic supply we can mint to test accounts. Instead, `set_params`
// after `initialize` rotates `Global.quote_mint` to this mock mint, and the
// program's `address = global.quote_mint` constraint accepts it.
// ---------------------------------------------------------------------------

export interface CreateMockLstArgs {
  decimals?: number;
  transferFeeBps?: number;
  maximumFee?: bigint;
}

/**
 * Create a Token-2022 mint with the TransferFee extension enabled.
 *
 * - `transferFeeBps` defaults to 50 (0.5%), matching the spec note that the
 *   real LST has a non-zero on-chain fee that the program must gross up for.
 * - `payer` funds both rent and the mint init tx.
 * - The mint authority is `payer` so the caller can `mintMockLst` post-init.
 */
export async function createMockLst(
  provider: anchor.AnchorProvider,
  payer: Keypair,
  args: CreateMockLstArgs = {},
): Promise<Keypair> {
  const decimals = args.decimals ?? 9;
  const transferFeeBps = args.transferFeeBps ?? 50;
  const maximumFee = args.maximumFee ?? BigInt(1_000_000_000_000); // arbitrary, much higher than any test transfer

  const mint = Keypair.generate();
  const extensions = [ExtensionType.TransferFeeConfig];
  const mintLen = getMintLen(extensions);
  const lamports = await provider.connection.getMinimumBalanceForRentExemption(
    mintLen,
  );

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // Configure transfer fee BEFORE InitializeMint, per Token-2022 ABI.
    createInitializeTransferFeeConfigInstruction(
      mint.publicKey,
      payer.publicKey, // transferFeeConfigAuthority — kept by payer for test override
      payer.publicKey, // withdrawWithheldAuthority — same
      transferFeeBps,
      maximumFee,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      payer.publicKey, // mintAuthority
      payer.publicKey, // freezeAuthority — irrelevant for our usage
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  await provider.sendAndConfirm(tx, [payer, mint]);
  return mint;
}

/**
 * Mint LST tokens to an arbitrary owner. Creates the ATA idempotently.
 * Returns the ATA address so callers can subsequently fetch the balance.
 */
export async function mintMockLst(
  provider: anchor.AnchorProvider,
  mint: PublicKey,
  mintAuthority: Keypair,
  destOwner: PublicKey,
  amount: bigint,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(
    mint,
    destOwner,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      mintAuthority.publicKey,
      ata,
      destOwner,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createMintToInstruction(
      mint,
      ata,
      mintAuthority.publicKey,
      amount,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  await provider.sendAndConfirm(tx, [mintAuthority]);
  return ata;
}

/**
 * Read a Token-2022 balance for an arbitrary ATA. Returns "0" if the account
 * doesn't exist — same semantics as `getSPLBalance` for parity.
 */
export async function getLstBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  allowOffCurve: boolean = false,
): Promise<string> {
  return getSPLBalance(
    connection,
    mint,
    owner,
    allowOffCurve,
    TOKEN_2022_PROGRAM_ID,
  );
}
