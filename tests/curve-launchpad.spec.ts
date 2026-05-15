// curve-launchpad.spec.ts — Stacc rewrite
//
// This suite exercises the rewritten LST-quote bonding curve program. The
// historical WSOL / lamports-based tests have been wholesale replaced. Key
// differences from the old suite:
//
//   - Quote token is now a Token-2022 mint with a TransferFee extension
//     (mock LST). The program reads `Global.quote_mint`, which we rotate via
//     `set_params` to our locally-minted mock instead of the mainnet stacSOL.
//   - State + event field names: `*_sol_*` -> `*_quote_*`. Ix args:
//     `max_sol_cost` -> `max_quote_cost`, `min_sol_output` -> `min_quote_output`.
//   - Buy / sell / withdraw account lists now carry both `token_program`
//     (legacy SPL, MEME side) and `quote_token_program` (Token-2022, LST side),
//     plus the curve / user / fee-recipient ATAs for the LST.
//   - `create` revokes BOTH the mint and freeze authority now.
//   - `migrate` initialises a Raydium CPMM pool with LST/MEME and retains the
//     LP token in a program-owned ATA (no burn).
//   - New `flip` instruction (Switchboard On-Demand VRF). Tests are wired
//     up but skipped pending a fixture randomness account — see the `flip`
//     describe block below.

import * as anchor from "@coral-xyz/anchor";
import {
  AccountInfo,
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { assert } from "chai";
import { Metaplex } from "@metaplex-foundation/js";
import { AMM, calculateFee } from "../client";
import {
  ammProgramId,
  createPoolFee,
  getAmmConfigAddress,
  getAuthAddress,
  getOrcleAccountAddress,
  getPoolAddress,
  getPoolLpMintAddress,
  getPoolVaultAddress,
} from "../client";
import {
  ammFromBondingCurve,
  createMockLst,
  CURVE_LAUNCHPAD_PROGRAM_ID,
  fundAccountSOL,
  getAnchorError,
  getLstBalance,
  getSPLBalance,
  loadProgram,
  mintMockLst,
  sendTransaction,
  toEvent,
} from "./util";

const GLOBAL_SEED = "global";
const BONDING_CURVE_SEED = "bonding-curve";
const EVENT_AUTHORITY_SEED = "__event_authority";

describe("curve-launchpad", () => {
  // ---------------------------------------------------------------------
  // Test constants. Decimals stay at 6 for MEME; LST decimals = 9 to match
  // the real stacSOL. Reserve values keep their order-of-magnitude from the
  // old suite — the program math is the same, just denominated in LST.
  // ---------------------------------------------------------------------
  const DEFAULT_DECIMALS = 6n;
  const DEFAULT_TOKEN_BALANCE =
    1_000_000_000n * BigInt(10 ** Number(DEFAULT_DECIMALS));
  const DEFAULT_INITIAL_TOKEN_RESERVES = 793_100_000_000_000n;
  const DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVE = 30_000_000_000n;
  const DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVE = 1_073_000_000_000_000n;
  const DEFAULT_FEE_BASIS_POINTS = 50n;

  // Mock LST is Token-2022 with 50 bps transfer fee. We size LST balances
  // generously above the largest single transfer (the "complete the curve"
  // buy can be ~120 SOL worth of LST plus fees).
  const LST_TRANSFER_FEE_BPS = 50;
  const LST_DECIMALS = 9;
  const LST_MAX_SUPPLY = 10_000n * 10n ** BigInt(LST_DECIMALS);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Hand-rolled program client (see tests/util.ts for the rationale —
  // anchor-cli IDL emission is broken upstream).
  const program = loadProgram(provider);
  const connection = provider.connection;

  // Players. `authority` owns the program globals; `tokenCreator` mints +
  // trades the curve; `feeRecipient` collects LST fees; `withdrawAuthority`
  // is the recipient of curve drains.
  const authority = Keypair.generate();
  const tokenCreator = Keypair.generate();
  const feeRecipient = Keypair.generate();
  const withdrawAuthority = Keypair.generate();

  // Two MEME mints — `mint` is the main subject under test, `flipTargetMint`
  // is a second curve we set up so the flip tests can pick a target.
  const mint = Keypair.generate();
  const flipTargetMint = Keypair.generate();

  // Mock LST mint. Populated in `before()` then immediately wired into
  // `Global.quote_mint` via set_params.
  let lstMint: Keypair;
  // The mock LST's mint authority — held by `authority` for convenience so
  // we can topping up balances from any test without juggling more keypairs.
  let lstMintAuthority: Keypair;

  const [globalPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from(GLOBAL_SEED)],
    program.programId,
  );
  const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), mint.publicKey.toBuffer()],
    program.programId,
  );
  const [eventAuthorityPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from(EVENT_AUTHORITY_SEED)],
    program.programId,
  );

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  const deriveBondingCurve = (memeMint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(BONDING_CURVE_SEED), memeMint.toBuffer()],
      program.programId,
    )[0];

  /** Read the curve's reserves into the off-chain AMM model. */
  const getAmmFromBondingCurve = async (memeMint: PublicKey = mint.publicKey) => {
    let bc = await (program.account as any).bondingCurve.fetch(
      deriveBondingCurve(memeMint),
    );
    return ammFromBondingCurve(bc, DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVE);
  };

  /** Assert the on-chain BondingCurve matches the off-chain AMM model. */
  const assertBondingCurve = (
    amm: AMM,
    bondingCurveAccount: any,
    complete: boolean = false,
  ) => {
    assert.equal(
      bondingCurveAccount.virtualTokenReserves.toString(),
      amm.virtualTokenReserves.toString(),
    );
    assert.equal(
      bondingCurveAccount.virtualQuoteReserves.toString(),
      amm.virtualSolReserves.toString(),
    );
    assert.equal(
      bondingCurveAccount.realTokenReserves.toString(),
      amm.realTokenReserves.toString(),
    );
    assert.equal(
      bondingCurveAccount.realQuoteReserves.toString(),
      amm.realSolReserves.toString(),
    );
    assert.equal(
      bondingCurveAccount.tokenTotalSupply.toString(),
      DEFAULT_TOKEN_BALANCE.toString(),
    );
    assert.equal(bondingCurveAccount.complete, complete);
  };

  /**
   * Issue a buy. The account list mirrors what the on-chain `Buy` struct
   * requires (see `programs/curve-launchpad/src/instructions/buy.rs`). The
   * `bonding_curve_quote_account` and `fee_recipient_quote_account` are
   * init_if_needed inside the program, so we only need to pre-mint the
   * user's LST balance.
   */
  const simpleBuy = async (
    user: Keypair,
    tokenAmount: bigint,
    maxQuoteAmount: bigint,
    innerFeeRecipient: Keypair = feeRecipient,
    memeMint: PublicKey = mint.publicKey,
  ) => {
    const bc = deriveBondingCurve(memeMint);
    const bondingCurveTokenAccount = getAssociatedTokenAddressSync(
      memeMint,
      bc,
      true,
      TOKEN_PROGRAM_ID,
    );
    const userTokenAccount = getAssociatedTokenAddressSync(
      memeMint,
      user.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );

    let tx = await (program.methods as any)
      .buy(new BN(tokenAmount.toString()), new BN(maxQuoteAmount.toString()))
      .accounts({
        user: user.publicKey,
        global: globalPDA,
        feeRecipient: innerFeeRecipient.publicKey,
        mint: memeMint,
        quoteMint: lstMint.publicKey,
        bondingCurve: bc,
        bondingCurveTokenAccount,
        bondingCurveQuoteAccount: getAssociatedTokenAddressSync(
          lstMint.publicKey,
          bc,
          true,
          TOKEN_2022_PROGRAM_ID,
        ),
        userTokenAccount,
        userQuoteAccount: getAssociatedTokenAddressSync(
          lstMint.publicKey,
          user.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        ),
        feeRecipientQuoteAccount: getAssociatedTokenAddressSync(
          lstMint.publicKey,
          innerFeeRecipient.publicKey,
          true,
          TOKEN_2022_PROGRAM_ID,
        ),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        eventAuthority: eventAuthorityPDA,
        program: program.programId,
      })
      .transaction();

    // Ensure the user's MEME ATA exists. The program doesn't create it — the
    // legacy SPL Token program doesn't have `init_if_needed` for the user
    // side of MEME (only the bonding_curve_token_account is the curve's own
    // ATA, created at `create` time).
    tx.instructions.unshift(
      createAssociatedTokenAccountIdempotentInstruction(
        user.publicKey,
        userTokenAccount,
        user.publicKey,
        memeMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );

    let txResults = await sendTransaction(program, tx, [user], user.publicKey);
    return {
      tx: txResults,
      userTokenAccount,
      bondingCurveTokenAccount,
      bondingCurvePDA: bc,
    };
  };

  /** Mirror of `simpleBuy`. Same account-list shape, but with min quote out. */
  const simpleSell = async (
    user: Keypair,
    tokenAmount: bigint,
    minQuoteAmount: bigint,
    innerFeeRecipient: Keypair = feeRecipient,
    memeMint: PublicKey = mint.publicKey,
  ) => {
    const bc = deriveBondingCurve(memeMint);
    const bondingCurveTokenAccount = getAssociatedTokenAddressSync(
      memeMint,
      bc,
      true,
      TOKEN_PROGRAM_ID,
    );
    const userTokenAccount = getAssociatedTokenAddressSync(
      memeMint,
      user.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );

    let tx = await (program.methods as any)
      .sell(new BN(tokenAmount.toString()), new BN(minQuoteAmount.toString()))
      .accounts({
        user: user.publicKey,
        global: globalPDA,
        feeRecipient: innerFeeRecipient.publicKey,
        mint: memeMint,
        quoteMint: lstMint.publicKey,
        bondingCurve: bc,
        bondingCurveTokenAccount,
        bondingCurveQuoteAccount: getAssociatedTokenAddressSync(
          lstMint.publicKey,
          bc,
          true,
          TOKEN_2022_PROGRAM_ID,
        ),
        userTokenAccount,
        userQuoteAccount: getAssociatedTokenAddressSync(
          lstMint.publicKey,
          user.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        ),
        feeRecipientQuoteAccount: getAssociatedTokenAddressSync(
          lstMint.publicKey,
          innerFeeRecipient.publicKey,
          true,
          TOKEN_2022_PROGRAM_ID,
        ),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        eventAuthority: eventAuthorityPDA,
        program: program.programId,
      })
      .transaction();

    let txResults = await sendTransaction(program, tx, [user], user.publicKey);
    return {
      tx: txResults,
      userTokenAccount,
      bondingCurveTokenAccount,
      bondingCurvePDA: bc,
    };
  };

  // ---------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------

  before(async () => {
    await fundAccountSOL(connection, authority.publicKey, 50 * LAMPORTS_PER_SOL);
    await fundAccountSOL(
      connection,
      tokenCreator.publicKey,
      200 * LAMPORTS_PER_SOL,
    );
    await fundAccountSOL(
      connection,
      withdrawAuthority.publicKey,
      5 * LAMPORTS_PER_SOL,
    );

    // Mint authority for the mock LST is `authority`. Saves a keypair —
    // anything that wants to top up an LST balance during a test can re-use
    // the program's authority.
    lstMintAuthority = authority;
    lstMint = await createMockLst(provider, authority, {
      decimals: LST_DECIMALS,
      transferFeeBps: LST_TRANSFER_FEE_BPS,
      // pick a very high maxFee so the BPS rate dominates for our small txns
      maximumFee: 10n ** 18n,
    });
  });

  // ---------------------------------------------------------------------
  // 1. initialize + set_params
  //
  // Initialize seeds Global.quote_mint with the on-chain constant
  // STACC_QUOTE_MINT. We rotate it to our mock LST via set_params so the
  // rest of the suite can transact in LST we actually own.
  // ---------------------------------------------------------------------

  it("Is initialized!", async () => {
    await (program.methods as any)
      .initialize()
      .accounts({
        authority: authority.publicKey,
        global: globalPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    let global = await (program.account as any).global.fetch(globalPDA);
    assert.equal(global.authority.toBase58(), authority.publicKey.toBase58());
    assert.equal(global.initialized, true);

    await (program.methods as any)
      .setParams(
        feeRecipient.publicKey,
        withdrawAuthority.publicKey,
        new BN(DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVE.toString()),
        new BN(DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVE.toString()),
        new BN(DEFAULT_INITIAL_TOKEN_RESERVES.toString()),
        new BN(DEFAULT_TOKEN_BALANCE.toString()),
        new BN(DEFAULT_FEE_BASIS_POINTS.toString()),
        lstMint.publicKey,
      )
      .accounts({
        global: globalPDA,
        user: authority.publicKey,
        systemProgram: SystemProgram.programId,
        eventAuthority: eventAuthorityPDA,
        program: program.programId,
      })
      .signers([authority])
      .rpc();

    let globalAfter = await (program.account as any).global.fetch(globalPDA);
    assert.equal(
      globalAfter.quoteMint.toBase58(),
      lstMint.publicKey.toBase58(),
    );
    assert.equal(
      globalAfter.feeRecipient.toBase58(),
      feeRecipient.publicKey.toBase58(),
    );
    assert.equal(
      globalAfter.withdrawAuthority.toBase58(),
      withdrawAuthority.publicKey.toBase58(),
    );
  });

  // ---------------------------------------------------------------------
  // 2. create — also asserts freeze authority is revoked (SPEC.md §2)
  // ---------------------------------------------------------------------

  it("can mint a token", async () => {
    const bondingCurveTokenAccount = getAssociatedTokenAddressSync(
      mint.publicKey,
      bondingCurvePDA,
      true,
      TOKEN_PROGRAM_ID,
    );

    let name = "test";
    let symbol = "tst";
    let uri = "https://www.test.com";

    const [mintAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint-authority")],
      program.programId,
    );
    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s").toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
    );

    const tx = await (program.methods as any)
      .create(name, symbol, uri)
      .accounts({
        mint: mint.publicKey,
        creator: tokenCreator.publicKey,
        mintAuthority: mintAuthorityPDA,
        bondingCurve: bondingCurvePDA,
        bondingCurveTokenAccount,
        global: globalPDA,
        metadata: metadataPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenMetadataProgram: new PublicKey(
          "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
        ),
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        eventAuthority: eventAuthorityPDA,
        program: program.programId,
      })
      .transaction();

    let txResult = await sendTransaction(
      program,
      tx,
      [mint, tokenCreator],
      tokenCreator.publicKey,
    );

    let createEvents = txResult.events.filter(
      (e: any) => e.name === "createEvent",
    );
    assert.equal(createEvents.length, 1);

    let createEvent = toEvent("createEvent", createEvents[0]);
    assert.notEqual(createEvent, null);
    if (createEvent != null) {
      assert.equal(createEvent.name, name);
      assert.equal(createEvent.symbol, symbol);
      assert.equal(createEvent.uri, uri);
      assert.equal(createEvent.mint.toBase58(), mint.publicKey.toBase58());
      assert.equal(
        createEvent.bondingCurve.toBase58(),
        bondingCurvePDA.toBase58(),
      );
      assert.equal(
        createEvent.creator.toBase58(),
        tokenCreator.publicKey.toBase58(),
      );
    }

    // Curve's MEME ATA holds the full initial supply.
    const tokenAmount = await connection.getTokenAccountBalance(
      bondingCurveTokenAccount,
    );
    assert.equal(tokenAmount.value.amount, DEFAULT_TOKEN_BALANCE.toString());

    // PR-1 invariant: BOTH mint authority and freeze authority are revoked.
    const createdMint = await getMint(connection, mint.publicKey);
    assert.equal(createdMint.isInitialized, true);
    assert.equal(createdMint.decimals, Number(DEFAULT_DECIMALS));
    assert.equal(createdMint.supply, DEFAULT_TOKEN_BALANCE);
    assert.equal(createdMint.mintAuthority, null, "mint authority not revoked");
    assert.equal(
      createdMint.freezeAuthority,
      null,
      "freeze authority not revoked",
    );

    const metaplex = Metaplex.make(connection);
    const tokenMeta = await metaplex
      .nfts()
      .findByMint({ mintAddress: mint.publicKey });
    assert.equal(tokenMeta.name, name);
    assert.equal(tokenMeta.symbol, symbol);
    assert.equal(tokenMeta.uri, uri);

    let bondingCurveAccount = await (program.account as any).bondingCurve.fetch(
      bondingCurvePDA,
    );

    // Renamed fields: virtualQuoteReserves / realQuoteReserves replace the
    // legacy *SolReserves names.
    assert.equal(
      bondingCurveAccount.virtualTokenReserves.toString(),
      DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVE.toString(),
    );
    assert.equal(
      bondingCurveAccount.virtualQuoteReserves.toString(),
      DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVE.toString(),
    );
    assert.equal(
      bondingCurveAccount.realTokenReserves.toString(),
      DEFAULT_INITIAL_TOKEN_RESERVES.toString(),
    );
    assert.equal(bondingCurveAccount.realQuoteReserves.toString(), "0");
    assert.equal(
      bondingCurveAccount.tokenTotalSupply.toString(),
      DEFAULT_TOKEN_BALANCE.toString(),
    );
    assert.equal(bondingCurveAccount.complete, false);
  });

  // ---------------------------------------------------------------------
  // 3. buy — full LST flow incl. transfer-fee gross-up
  // ---------------------------------------------------------------------

  it("can buy a token", async () => {
    // Top up the buyer with LST. We size this well above any single trade
    // in the suite so we don't have to re-mint.
    await mintMockLst(
      provider,
      lstMint.publicKey,
      lstMintAuthority,
      tokenCreator.publicKey,
      LST_MAX_SUPPLY,
    );

    let currentAMM = await getAmmFromBondingCurve();

    let buyTokenAmount = DEFAULT_TOKEN_BALANCE / 100n;
    // AMM math is denominated in LST atomic units now, but the off-chain
    // `client.AMM` class internally still uses "SOL" naming. `getBuyPrice`
    // returns the LST amount required.
    let basePrice = currentAMM.getBuyPrice(buyTokenAmount);
    let fee = calculateFee(basePrice, Number(DEFAULT_FEE_BASIS_POINTS));
    let buyMaxQuoteAmount = basePrice + fee;

    let buyResult = currentAMM.applyBuy(buyTokenAmount);

    const feeRecipientAta = getAssociatedTokenAddressSync(
      lstMint.publicKey,
      feeRecipient.publicKey,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const bondingCurveQuoteAta = getAssociatedTokenAddressSync(
      lstMint.publicKey,
      bondingCurvePDA,
      true,
      TOKEN_2022_PROGRAM_ID,
    );

    const userLstPre = BigInt(
      await getLstBalance(connection, lstMint.publicKey, tokenCreator.publicKey),
    );
    const curveLstPre = BigInt(
      await getLstBalance(
        connection,
        lstMint.publicKey,
        bondingCurvePDA,
        true,
      ),
    );
    const feeRecipientLstPre = BigInt(
      await getLstBalance(
        connection,
        lstMint.publicKey,
        feeRecipient.publicKey,
        true,
      ),
    );

    let txResult = await simpleBuy(
      tokenCreator,
      buyTokenAmount,
      // give a generous max so the transfer-fee gross-up has room
      buyMaxQuoteAmount * 2n,
    );

    // Curve nets exactly `quote_amount` (program grosses up to absorb the
    // TransferFee). Same goes for fee_recipient netting `fee`. The buyer is
    // debited the gross total.
    const curveLstPost = BigInt(
      await connection
        .getTokenAccountBalance(bondingCurveQuoteAta)
        .then((b) => b.value.amount),
    );
    const feeRecipientLstPost = BigInt(
      await connection
        .getTokenAccountBalance(feeRecipientAta)
        .then((b) => b.value.amount),
    );
    const userLstPost = BigInt(
      await getLstBalance(connection, lstMint.publicKey, tokenCreator.publicKey),
    );

    assert.equal(
      (curveLstPost - curveLstPre).toString(),
      basePrice.toString(),
      "curve LST delta != quote_amount",
    );
    assert.equal(
      (feeRecipientLstPost - feeRecipientLstPre).toString(),
      fee.toString(),
      "fee recipient LST delta != fee",
    );
    // User debit equals curve+fee plus the TransferFee on both legs. We
    // bound it conservatively (off-by-one rounding on the fee calculator is
    // acceptable for the inverse-fee gross-up).
    const userDebit = userLstPre - userLstPost;
    assert.isAtLeast(
      Number(userDebit),
      Number(basePrice + fee),
      "user paid less than the net post-fee LST",
    );

    let tradeEvents = txResult.tx.events.filter(
      (e: any) => e.name === "tradeEvent",
    );
    assert.equal(tradeEvents.length, 1);

    let tradeEvent = toEvent("tradeEvent", tradeEvents[0]);
    assert.notEqual(tradeEvent, null);
    if (tradeEvent != null) {
      assert.equal(tradeEvent.tokenAmount.toString(), buyTokenAmount.toString());
      assert.equal(tradeEvent.isBuy, true);
      // Renamed: solAmount -> quoteAmount.
      assert.equal(
        tradeEvent.quoteAmount.toString(),
        buyResult.sol_amount.toString(),
      );
    }

    // MEME movement.
    const userMemeBalance = await connection.getTokenAccountBalance(
      txResult.userTokenAccount,
    );
    assert.equal(userMemeBalance.value.amount, buyTokenAmount.toString());

    const curveMemeBalance = await connection.getTokenAccountBalance(
      txResult.bondingCurveTokenAccount,
    );
    assert.equal(
      curveMemeBalance.value.amount,
      (DEFAULT_TOKEN_BALANCE - buyTokenAmount).toString(),
    );

    let bondingCurveAccount = await (program.account as any).bondingCurve.fetch(
      bondingCurvePDA,
    );
    assertBondingCurve(currentAMM, bondingCurveAccount);
  });

  // ---------------------------------------------------------------------
  // 4. sell — mirror of buy. The user sends MEME in and gets LST out
  // (minus fee, with the program absorbing the TransferFee deduction).
  // ---------------------------------------------------------------------

  it("can sell a token", async () => {
    let currentAMM = await getAmmFromBondingCurve();

    let tokenAmount = 10_000_000n;
    let basePrice = currentAMM.getSellPrice(tokenAmount);
    let fee = calculateFee(basePrice, Number(DEFAULT_FEE_BASIS_POINTS));
    let minQuoteAmount = basePrice - fee;

    let sellResults = currentAMM.applySell(tokenAmount);

    const memePre = BigInt(
      await getSPLBalance(connection, mint.publicKey, tokenCreator.publicKey),
    );
    const curveMemePre = BigInt(
      await getSPLBalance(connection, mint.publicKey, bondingCurvePDA, true),
    );

    const userLstPre = BigInt(
      await getLstBalance(connection, lstMint.publicKey, tokenCreator.publicKey),
    );
    const feeRecipientLstPre = BigInt(
      await getLstBalance(
        connection,
        lstMint.publicKey,
        feeRecipient.publicKey,
        true,
      ),
    );

    let txResult = await simpleSell(tokenCreator, tokenAmount, 0n);

    const userLstPost = BigInt(
      await getLstBalance(connection, lstMint.publicKey, tokenCreator.publicKey),
    );
    const feeRecipientLstPost = BigInt(
      await getLstBalance(
        connection,
        lstMint.publicKey,
        feeRecipient.publicKey,
        true,
      ),
    );

    // The program transfers `sell_amount - fee` to the user (post-fee from
    // the perspective of the AMM result). With a TransferFee mint, the
    // amount actually credited to the user can be slightly less, since the
    // program grosses-up so the user nets exactly `sell_amount - fee`.
    const userCredit = userLstPost - userLstPre;
    assert.isAtLeast(
      Number(userCredit),
      Number(minQuoteAmount),
      "user received less than min_quote_output",
    );
    const feeCredit = feeRecipientLstPost - feeRecipientLstPre;
    assert.isAtLeast(
      Number(feeCredit),
      Number(fee),
      "fee recipient credit < fee",
    );

    let tradeEvents = txResult.tx.events.filter(
      (e: any) => e.name === "tradeEvent",
    );
    assert.equal(tradeEvents.length, 1);

    let tradeEvent = toEvent("tradeEvent", tradeEvents[0]);
    assert.notEqual(tradeEvent, null);
    if (tradeEvent != null) {
      assert.equal(tradeEvent.tokenAmount.toString(), tokenAmount.toString());
      assert.equal(tradeEvent.isBuy, false);
      assert.equal(
        tradeEvent.quoteAmount.toString(),
        sellResults.sol_amount.toString(),
      );
    }

    // MEME movement: user down by tokenAmount, curve up by the same.
    const memePost = BigInt(
      await getSPLBalance(connection, mint.publicKey, tokenCreator.publicKey),
    );
    const curveMemePost = BigInt(
      await getSPLBalance(connection, mint.publicKey, bondingCurvePDA, true),
    );
    assert.equal((memePre - memePost).toString(), tokenAmount.toString());
    assert.equal(
      (curveMemePost - curveMemePre).toString(),
      tokenAmount.toString(),
    );

    let bondingCurveAccount = await (program.account as any).bondingCurve.fetch(
      bondingCurvePDA,
    );
    assertBondingCurve(currentAMM, bondingCurveAccount);
  });

  // ---------------------------------------------------------------------
  // 5. Exception paths — same shape as old suite, error codes renamed.
  // ---------------------------------------------------------------------

  it("can't withdraw as curve is incomplete", async () => {
    let errorCode = "";
    try {
      const userMemeAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        withdrawAuthority.publicKey,
        false,
        TOKEN_PROGRAM_ID,
      );
      const userLstAta = getAssociatedTokenAddressSync(
        lstMint.publicKey,
        withdrawAuthority.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
      const [lastWithdrawPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("last-withdraw")],
        program.programId,
      );

      let tx = await (program.methods as any)
        .withdraw()
        .accounts({
          user: withdrawAuthority.publicKey,
          global: globalPDA,
          mint: mint.publicKey,
          quoteMint: lstMint.publicKey,
          lastWithdraw: lastWithdrawPDA,
          bondingCurve: bondingCurvePDA,
          bondingCurveTokenAccount: getAssociatedTokenAddressSync(
            mint.publicKey,
            bondingCurvePDA,
            true,
            TOKEN_PROGRAM_ID,
          ),
          bondingCurveQuoteAccount: getAssociatedTokenAddressSync(
            lstMint.publicKey,
            bondingCurvePDA,
            true,
            TOKEN_2022_PROGRAM_ID,
          ),
          userTokenAccount: userMemeAta,
          userQuoteAccount: userLstAta,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .transaction();

      await sendTransaction(
        program,
        tx,
        [withdrawAuthority],
        withdrawAuthority.publicKey,
      );
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "BondingCurveNotComplete");
  });

  it("can't buy a token, not enough LST", async () => {
    const notEnoughLstUser = Keypair.generate();

    // Fund SOL only — the LST ATA will be empty.
    await fundAccountSOL(
      connection,
      notEnoughLstUser.publicKey,
      0.5 * LAMPORTS_PER_SOL,
    );
    // Create a zero-balance LST ATA for the buyer so we don't hit "ATA
    // doesn't exist" before reaching the InsufficientQuote check.
    await mintMockLst(
      provider,
      lstMint.publicKey,
      lstMintAuthority,
      notEnoughLstUser.publicKey,
      0n,
    );

    let errorCode = "";
    try {
      await simpleBuy(
        notEnoughLstUser,
        5_000_000_000_000n,
        BigInt(5 * LAMPORTS_PER_SOL),
      );
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "InsufficientQuote");
  });

  it("can't buy a token, exceed max quote cost", async () => {
    let errorCode = "";
    try {
      await simpleBuy(tokenCreator, DEFAULT_TOKEN_BALANCE / 100n, 1n);
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "MaxQuoteCostExceeded");
  });

  it("can't buy 0 tokens", async () => {
    let errorCode = "";
    try {
      await simpleBuy(tokenCreator, 0n, 1n);
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "MinBuy");
  });

  it("can't sell a token, not enough tokens", async () => {
    let errorCode = "";
    try {
      await simpleSell(tokenCreator, DEFAULT_TOKEN_BALANCE, 0n);
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "InsufficientTokens");
  });

  it("can't sell 0 tokens", async () => {
    let errorCode = "";
    try {
      await simpleSell(tokenCreator, 0n, 0n);
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "MinSell");
  });

  it("can't sell a token, exceed min quote out", async () => {
    let errorCode = "";
    try {
      await simpleSell(tokenCreator, 1n, DEFAULT_TOKEN_BALANCE);
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "MinQuoteOutputExceeded");
  });

  // ---------------------------------------------------------------------
  // 6. Curve completion — buy out the rest of the supply, then assert
  // the `complete` flag flipped.
  // ---------------------------------------------------------------------

  it("can complete the curve", async () => {
    let currentAMM = await getAmmFromBondingCurve();
    let buyTokenAmount = currentAMM.realTokenReserves;
    let basePrice = currentAMM.getBuyPrice(buyTokenAmount);
    let fee = calculateFee(basePrice, Number(DEFAULT_FEE_BASIS_POINTS));
    let maxQuoteAmount = basePrice + fee;

    let buyResult = currentAMM.applyBuy(buyTokenAmount);

    let userMemePre = BigInt(
      await getSPLBalance(connection, mint.publicKey, tokenCreator.publicKey),
    );

    let txResult = await simpleBuy(
      tokenCreator,
      buyTokenAmount,
      maxQuoteAmount * 2n,
    );

    let tradeEvents = txResult.tx.events.filter(
      (e: any) => e.name === "tradeEvent",
    );
    assert.equal(tradeEvents.length, 1);

    let tradeEvent = toEvent("tradeEvent", tradeEvents[0]);
    assert.notEqual(tradeEvent, null);
    if (tradeEvent != null) {
      assert.equal(tradeEvent.isBuy, true);
      assert.equal(
        tradeEvent.quoteAmount.toString(),
        buyResult.sol_amount.toString(),
      );
    }

    let userMemePost = BigInt(
      await getSPLBalance(connection, mint.publicKey, tokenCreator.publicKey),
    );
    assert.equal(
      (userMemePost - userMemePre).toString(),
      buyTokenAmount.toString(),
    );

    let bondingCurveAccount = await (program.account as any).bondingCurve.fetch(
      bondingCurvePDA,
    );
    assertBondingCurve(currentAMM, bondingCurveAccount, true);

    // CompleteEvent emitted by the buy that crossed the line.
    let completeEvents = txResult.tx.events.filter(
      (e: any) => e.name === "completeEvent",
    );
    assert.equal(completeEvents.length, 1);
  });

  it("can't buy a token, curve complete", async () => {
    let currentAMM = await getAmmFromBondingCurve();
    let buyTokenAmount = 100n;
    let maxQuoteAmount = currentAMM.getBuyPrice(buyTokenAmount) || 1n;

    let errorCode = "";
    try {
      await simpleBuy(tokenCreator, buyTokenAmount, maxQuoteAmount * 2n);
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "BondingCurveComplete");
  });

  it("can't sell a token, curve complete", async () => {
    let errorCode = "";
    try {
      await simpleSell(tokenCreator, 100n, 0n);
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "BondingCurveComplete");
  });

  it("can't withdraw as incorrect authority", async () => {
    let errorCode = "";
    try {
      const userMemeAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        tokenCreator.publicKey,
        false,
        TOKEN_PROGRAM_ID,
      );
      const userLstAta = getAssociatedTokenAddressSync(
        lstMint.publicKey,
        tokenCreator.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
      const [lastWithdrawPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("last-withdraw")],
        program.programId,
      );

      let tx = await (program.methods as any)
        .withdraw()
        .accounts({
          user: tokenCreator.publicKey,
          global: globalPDA,
          mint: mint.publicKey,
          quoteMint: lstMint.publicKey,
          lastWithdraw: lastWithdrawPDA,
          bondingCurve: bondingCurvePDA,
          bondingCurveTokenAccount: getAssociatedTokenAddressSync(
            mint.publicKey,
            bondingCurvePDA,
            true,
            TOKEN_PROGRAM_ID,
          ),
          bondingCurveQuoteAccount: getAssociatedTokenAddressSync(
            lstMint.publicKey,
            bondingCurvePDA,
            true,
            TOKEN_2022_PROGRAM_ID,
          ),
          userTokenAccount: userMemeAta,
          userQuoteAccount: userLstAta,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .transaction();

      await sendTransaction(program, tx, [tokenCreator], tokenCreator.publicKey);
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "InvalidWithdrawAuthority");
  });

  // ---------------------------------------------------------------------
  // 7. withdraw — drains BOTH the curve's MEME ATA and its LST ATA into
  // the withdraw authority's matching ATAs. Replaces the old "drain
  // lamports" path entirely.
  // ---------------------------------------------------------------------

  it("can withdraw", async () => {
    const memeAta = getAssociatedTokenAddressSync(
      mint.publicKey,
      bondingCurvePDA,
      true,
      TOKEN_PROGRAM_ID,
    );
    const lstAta = getAssociatedTokenAddressSync(
      lstMint.publicKey,
      bondingCurvePDA,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const userMemeAta = getAssociatedTokenAddressSync(
      mint.publicKey,
      withdrawAuthority.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );
    const userLstAta = getAssociatedTokenAddressSync(
      lstMint.publicKey,
      withdrawAuthority.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const curveMemePre = BigInt(
      await getSPLBalance(connection, mint.publicKey, bondingCurvePDA, true),
    );
    const curveLstPre = BigInt(
      await getLstBalance(connection, lstMint.publicKey, bondingCurvePDA, true),
    );

    // Withdraw authority probably has no MEME/LST ATA yet. Withdraw will
    // create both with `init_if_needed`.
    const [lastWithdrawPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("last-withdraw")],
      program.programId,
    );

    let tx = await (program.methods as any)
      .withdraw()
      .accounts({
        user: withdrawAuthority.publicKey,
        global: globalPDA,
        mint: mint.publicKey,
        quoteMint: lstMint.publicKey,
        lastWithdraw: lastWithdrawPDA,
        bondingCurve: bondingCurvePDA,
        bondingCurveTokenAccount: memeAta,
        bondingCurveQuoteAccount: lstAta,
        userTokenAccount: userMemeAta,
        userQuoteAccount: userLstAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .transaction();

    await sendTransaction(
      program,
      tx,
      [withdrawAuthority],
      withdrawAuthority.publicKey,
    );

    // Curve's MEME + LST ATAs both drained.
    const curveMemePost = BigInt(
      await getSPLBalance(connection, mint.publicKey, bondingCurvePDA, true),
    );
    const curveLstPost = BigInt(
      await getLstBalance(connection, lstMint.publicKey, bondingCurvePDA, true),
    );
    assert.equal(curveMemePost, 0n);
    assert.equal(curveLstPost, 0n);

    // Withdraw authority received the MEME exactly. The LST credit can be
    // slightly less than the curve debit because the TransferFee is taken
    // on the wire and the program drains the gross balance (the spec says
    // "any TransferFee is borne by the destination implicitly").
    const userMemePost = BigInt(
      await getSPLBalance(
        connection,
        mint.publicKey,
        withdrawAuthority.publicKey,
      ),
    );
    const userLstPost = BigInt(
      await getLstBalance(
        connection,
        lstMint.publicKey,
        withdrawAuthority.publicKey,
      ),
    );
    assert.equal(userMemePost.toString(), curveMemePre.toString());
    // LST: user received curveLstPre minus the wire-time fee.
    assert.isAbove(Number(userLstPost), 0);
    assert.isAtMost(Number(userLstPost), Number(curveLstPre));

    // last_withdraw timestamp got written.
    const lastWithdraw = await (program.account as any).lastWithdraw.fetch(
      lastWithdrawPDA,
    );
    assert.isAbove(Number(lastWithdraw.lastWithdrawTimestamp), 0);
  });

  // ---------------------------------------------------------------------
  // 8. set_params — sanity check.
  // ---------------------------------------------------------------------

  it("can set params", async () => {
    const randomFeeRecipient = Keypair.generate();
    const randomWithdrawAuthority = Keypair.generate();
    // Rotating the quote_mint mid-run would break subsequent tests that
    // assume our mock LST is current — so set it back to lstMint here.

    let tx = await (program.methods as any)
      .setParams(
        randomFeeRecipient.publicKey,
        randomWithdrawAuthority.publicKey,
        new BN(1000),
        new BN(2000),
        new BN(3000),
        new BN(4000),
        new BN(100),
        lstMint.publicKey,
      )
      .accounts({
        global: globalPDA,
        user: authority.publicKey,
        systemProgram: SystemProgram.programId,
        eventAuthority: eventAuthorityPDA,
        program: program.programId,
      })
      .transaction();

    let txResult = await sendTransaction(
      program,
      tx,
      [authority],
      authority.publicKey,
    );

    let global = await (program.account as any).global.fetch(globalPDA);

    let setParamsEvents = txResult.events.filter(
      (e: any) => e.name === "setParamsEvent",
    );
    assert.equal(setParamsEvents.length, 1);

    let setParamsEvent = toEvent("setParamsEvent", setParamsEvents[0]);
    assert.notEqual(setParamsEvent, null);
    if (setParamsEvent != null) {
      assert.equal(
        setParamsEvent.feeRecipient.toBase58(),
        randomFeeRecipient.publicKey.toBase58(),
      );
      assert.equal(
        setParamsEvent.withdrawAuthority.toBase58(),
        randomWithdrawAuthority.publicKey.toBase58(),
      );
      assert.equal(setParamsEvent.initialVirtualTokenReserves.toString(), "1000");
      // Renamed field: initialVirtualQuoteReserves.
      assert.equal(setParamsEvent.initialVirtualQuoteReserves.toString(), "2000");
      assert.equal(setParamsEvent.initialRealTokenReserves.toString(), "3000");
      assert.equal(setParamsEvent.initialTokenSupply.toString(), "4000");
      assert.equal(setParamsEvent.feeBasisPoints.toString(), "100");
      assert.equal(setParamsEvent.quoteMint.toBase58(), lstMint.publicKey.toBase58());
    }

    assert.equal(
      global.feeRecipient.toBase58(),
      randomFeeRecipient.publicKey.toBase58(),
    );
    assert.equal(
      global.withdrawAuthority.toBase58(),
      randomWithdrawAuthority.publicKey.toBase58(),
    );
    assert.equal(global.initialVirtualTokenReserves.toString(), "1000");
    assert.equal(global.initialVirtualQuoteReserves.toString(), "2000");
    assert.equal(global.initialRealTokenReserves.toString(), "3000");
    assert.equal(global.initialTokenSupply.toString(), "4000");
    assert.equal(global.feeBasisPoints.toString(), "100");
    assert.equal(global.quoteMint.toBase58(), lstMint.publicKey.toBase58());
  });

  it("can't set params as non-authority", async () => {
    let errorCode = "";
    try {
      const randomFeeRecipient = Keypair.generate();
      const randomWithdrawAuthority = Keypair.generate();

      await (program.methods as any)
        .setParams(
          randomFeeRecipient.publicKey,
          randomWithdrawAuthority.publicKey,
          new BN(1000),
          new BN(2000),
          new BN(3000),
          new BN(4000),
          new BN(100),
          lstMint.publicKey,
        )
        .accounts({
          global: globalPDA,
          user: tokenCreator.publicKey,
          systemProgram: SystemProgram.programId,
          eventAuthority: eventAuthorityPDA,
          program: program.programId,
        })
        .signers([tokenCreator])
        .rpc();
    } catch (err) {
      let anchorError = getAnchorError(err);
      if (anchorError) {
        errorCode = anchorError.error.errorCode.code;
      }
    }
    assert.equal(errorCode, "InvalidAuthority");
  });

  // ---------------------------------------------------------------------
  // 9. migrate — LST/MEME pool init, LP retained
  //
  // The "creator" is the bonding curve PDA semantically (it holds source
  // ATAs and is the LP recipient via `authority = bonding_curve`). The
  // `creator` Signer slot is whoever pays for pool-state rent and the
  // program_lp_token ATA. We let `withdrawAuthority` pay that since they
  // already have ~5 SOL.
  //
  // NOTE: the test "can withdraw" above already drains the BC's MEME +
  // LST ATAs. For the migrate test to have something to migrate, we'd
  // need a fresh curve. The simplest way is to skip migrate after the
  // drain — but the spec wants us to test it. So we use `flipTargetMint`
  // as a fresh curve, complete it, and migrate THAT one.
  // ---------------------------------------------------------------------

  it("migrate raydium", async () => {
    // Create a fresh curve for the migrate test (the main `mint` has been
    // drained by withdraw above).
    let name = "mig";
    let symbol = "MIG";
    let uri = "https://example.com/mig.json";

    const [mintAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint-authority")],
      program.programId,
    );
    const [migMetaPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s").toBuffer(),
        flipTargetMint.publicKey.toBuffer(),
      ],
      new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
    );
    const migBc = deriveBondingCurve(flipTargetMint.publicKey);
    const migBcMemeAta = getAssociatedTokenAddressSync(
      flipTargetMint.publicKey,
      migBc,
      true,
      TOKEN_PROGRAM_ID,
    );

    // We need params back to the realistic reserves before creating the
    // curve, because the previous test overwrote them with tiny values.
    let resetTx = await (program.methods as any)
      .setParams(
        feeRecipient.publicKey,
        withdrawAuthority.publicKey,
        new BN(DEFAULT_INITIAL_VIRTUAL_TOKEN_RESERVE.toString()),
        new BN(DEFAULT_INITIAL_VIRTUAL_QUOTE_RESERVE.toString()),
        new BN(DEFAULT_INITIAL_TOKEN_RESERVES.toString()),
        new BN(DEFAULT_TOKEN_BALANCE.toString()),
        new BN(DEFAULT_FEE_BASIS_POINTS.toString()),
        lstMint.publicKey,
      )
      .accounts({
        global: globalPDA,
        user: authority.publicKey,
        systemProgram: SystemProgram.programId,
        eventAuthority: eventAuthorityPDA,
        program: program.programId,
      })
      .signers([authority])
      .rpc();

    const tx = await (program.methods as any)
      .create(name, symbol, uri)
      .accounts({
        mint: flipTargetMint.publicKey,
        creator: tokenCreator.publicKey,
        mintAuthority: mintAuthorityPDA,
        bondingCurve: migBc,
        bondingCurveTokenAccount: migBcMemeAta,
        global: globalPDA,
        metadata: migMetaPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenMetadataProgram: new PublicKey(
          "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
        ),
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        eventAuthority: eventAuthorityPDA,
        program: program.programId,
      })
      .transaction();
    await sendTransaction(
      program,
      tx,
      [flipTargetMint, tokenCreator],
      tokenCreator.publicKey,
    );

    // Top up buyer LST then buy out the curve.
    await mintMockLst(
      provider,
      lstMint.publicKey,
      lstMintAuthority,
      tokenCreator.publicKey,
      LST_MAX_SUPPLY,
    );
    let migAmm = await getAmmFromBondingCurve(flipTargetMint.publicKey);
    let buyTok = migAmm.realTokenReserves;
    let basePrice = migAmm.getBuyPrice(buyTok);
    let fee = calculateFee(basePrice, Number(DEFAULT_FEE_BASIS_POINTS));
    await simpleBuy(
      tokenCreator,
      buyTok,
      (basePrice + fee) * 2n,
      feeRecipient,
      flipTargetMint.publicKey,
    );

    // Verify the curve is complete and has LST + MEME to migrate.
    let migCurve = await (program.account as any).bondingCurve.fetch(migBc);
    assert.equal(migCurve.complete, true);

    // Pool keys. Raydium CPMM picks token_0/token_1 at runtime by raw
    // mint-key comparison. We mirror that here.
    const ammConfig = getAmmConfigAddress(0, ammProgramId)[0];
    const memeKey = flipTargetMint.publicKey;
    const lstKey = lstMint.publicKey;
    const lstIsToken0 = lstKey.toBuffer().compare(memeKey.toBuffer()) < 0;
    const token0Mint = lstIsToken0 ? lstKey : memeKey;
    const token1Mint = lstIsToken0 ? memeKey : lstKey;

    const poolState = getPoolAddress(ammConfig, token0Mint, token1Mint, ammProgramId)[0];
    const ammAuthority = getAuthAddress(ammProgramId)[0];
    const token0Vault = getPoolVaultAddress(poolState, token0Mint, ammProgramId)[0];
    const token1Vault = getPoolVaultAddress(poolState, token1Mint, ammProgramId)[0];
    const observationState = getOrcleAccountAddress(poolState, ammProgramId)[0];
    const lpMint = getPoolLpMintAddress(poolState, ammProgramId)[0];

    const bondingCurveQuoteAta = getAssociatedTokenAddressSync(
      lstKey,
      migBc,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const programLpTokenAta = getAssociatedTokenAddressSync(
      lpMint,
      migBc,
      true,
      TOKEN_PROGRAM_ID,
    );

    const migTx = await (program.methods as any)
      .migrate()
      .accounts({
        creator: withdrawAuthority.publicKey,
        global: globalPDA,
        mint: memeKey,
        quoteMint: lstKey,
        bondingCurve: migBc,
        bondingCurveQuoteAccount: bondingCurveQuoteAta,
        bondingCurveTokenAccount: migBcMemeAta,
        ammConfig,
        authority: ammAuthority,
        poolState,
        lpMint,
        programLpToken: programLpTokenAta,
        token0Vault,
        token1Vault,
        createPoolFee,
        observationState,
        cpSwapProgram: ammProgramId,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([withdrawAuthority])
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      ])
      .rpc({
        commitment: "confirmed",
        preflightCommitment: "confirmed",
        skipPreflight: true,
      });

    // Pool exists & is owned by the CPMM program.
    const poolStateAccount = (await connection.getAccountInfo(
      poolState,
    )) as AccountInfo<Buffer>;
    assert.equal(poolStateAccount.owner.toBase58(), ammProgramId.toBase58());

    // Vault balances should match what the BC contributed.
    const vault0 = await connection.getTokenAccountBalance(token0Vault);
    const vault1 = await connection.getTokenAccountBalance(token1Vault);
    assert.isAbove(Number(vault0.value.amount), 0);
    assert.isAbove(Number(vault1.value.amount), 0);

    // LP TOKENS RETAINED — not burned. The program-owned ATA holds them.
    const lpBalance = await connection.getTokenAccountBalance(programLpTokenAta);
    assert.isAbove(
      Number(lpBalance.value.amount),
      0,
      "program_lp_token should be non-zero (LP retained, not burned)",
    );
  });

  // ---------------------------------------------------------------------
  // 10. flip
  //
  // The flip instruction takes a Switchboard On-Demand `randomness_account_data`
  // AccountInfo and calls `RandomnessAccountData::parse(...)?.get_value(...)?`
  // on it. The serialized layout is part of switchboard-on-demand's internal
  // ABI — neither @solana/spl-token nor anchor provides a way to mint a
  // synthetic one from TS. Three real options:
  //
  //   1. Clone a real Switchboard randomness account from mainnet via
  //      `[[test.validator.clone]]` in Anchor.toml. This needs a known live
  //      randomness account address that has already been revealed at a slot
  //      <= the localnet slot at test time. We don't have one.
  //   2. Install the `@switchboard-xyz/on-demand` JS SDK and use its mock
  //      randomness helpers. The SDK isn't currently a dep of this project
  //      and pulling it in is out of scope for this PR.
  //   3. Feature-flag a "fake_randomness" path in the program behind an env
  //      / build feature. Out of scope per the task: "Files allowed... DON'T
  //      touch the program source."
  //
  // Per the task instructions: "If neither is workable, add the flip tests
  // as `it.skip(...)` with a clear TODO comment explaining what fixture is
  // needed — the user prefers stubs over fake passes."
  //
  // We do that. The describe block is wired up enough that wiring in a
  // randomness fixture later only requires populating `mockRandomness`.
  // ---------------------------------------------------------------------

  describe("flip", () => {
    // TODO: replace with either:
    //   (a) a real mainnet Switchboard randomness account cloned via
    //       Anchor.toml's `[[test.validator.clone]]`, OR
    //   (b) raw bytes assembled from `@switchboard-xyz/on-demand`'s
    //       `RandomnessAccountData` layout (see
    //       https://github.com/switchboard-xyz/switchboard-v2/blob/main/javascript/sdk
    //       — the layout is documented but not exported as a TS helper).
    // The flip instruction parses this account with
    // `RandomnessAccountData::parse(data)?.get_value(clock)?` and uses
    // `revealed[0] & 1 == 0` for WIN, `== 1` for LOSS. To stub determi-
    // nistically, the test needs both a `revealed` byte (parsed from the
    // serialized RandomnessAccountData) and a `seed_slot` that has already
    // passed in the local validator's clock.

    it.skip("WIN path: attacker burns wager, target loses LST", async () => {
      // Setup outline (left as documentation for the next implementer):
      //   1. Create curves A (attacker) and B (target).
      //   2. Buy some MEME on A. Buy some MEME on B so target has LST in
      //      `real_quote_reserves`.
      //   3. Stub randomness so `revealed[0] & 1 == 0` (WIN).
      //   4. Snapshot pre-balances: A.tokenTotalSupply, A.realQuoteReserves,
      //      B.realQuoteReserves, treasury LST ATA.
      //   5. Call flip(wager).
      //   6. Assert: A.tokenTotalSupply -= wager (burn). A.realQuoteReserves
      //      += 95% of stolen_lst. B.realQuoteReserves -= stolen_lst.
      //      treasury_quote_account += 5% of stolen_lst (net of TransferFee).
      assert.fail("flip WIN test pending randomness fixture");
    });

    it.skip("LOSS path: attacker sells wager, target gains LST", async () => {
      // Setup outline:
      //   1. Same A/B as WIN.
      //   2. Stub randomness so `revealed[0] & 1 == 1` (LOSS).
      //   3. Snapshot A.realTokenReserves, A.realQuoteReserves,
      //      B.realQuoteReserves.
      //   4. Call flip(wager).
      //   5. Assert: A.realTokenReserves += wager (user's MEME got sold
      //      INTO A's reserves). A.realQuoteReserves -= loss_lst.
      //      B.realQuoteReserves += loss_lst. Treasury unchanged.
      assert.fail("flip LOSS test pending randomness fixture");
    });
  });
});
