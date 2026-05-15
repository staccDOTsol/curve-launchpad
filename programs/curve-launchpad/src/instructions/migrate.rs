use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_interface,
};

use crate::{
    state::{BondingCurve, Global},
    CurveLaunchpadError,
};

// Raydium CPMM `initialize` ix discriminator.
const INITIALIZE_DISCRIMINANT: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];

#[derive(borsh::BorshSerialize, borsh::BorshDeserialize)]
pub struct InitializePayload {
    init_amount_0: u64,
    init_amount_1: u64,
    open_time: u64,
}

/// Emitted on successful Raydium CPMM migration. Defined inline because
/// `events.rs` is owned by a separate workstream.
#[event]
pub struct MigrateEvent {
    pub mint: Pubkey,
    pub bonding_curve: Pubkey,
    pub pool_state: Pubkey,
    pub lp_mint: Pubkey,
    pub quote_deposited: u64,
    pub meme_deposited: u64,
    pub lp_received: u64,
    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct Migrate<'info> {
    /// Pays the Raydium pool-state rent (~1.1 SOL) and ATA rent for the
    /// program-owned LP token account. Does NOT fund the pool reserves —
    /// those come from the bonding curve's own LST/MEME balances.
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        seeds = [Global::SEED_PREFIX],
        bump,
    )]
    pub global: Box<Account<'info, Global>>,

    /// MEME mint (Token v1). The curve's own token.
    pub mint: Box<Account<'info, Mint>>,

    /// LST quote mint (Token-2022 with TransferFee). Must match `global.quote_mint`.
    /// Historical Raydium constraint: "Token mint, the key must grater then
    /// token_0 mint" — i.e. token_1 (MEME) > token_0 (LST/quote). Caller is
    /// responsible for selecting a MEME mint that satisfies this ordering, as
    /// the original WSOL-paired flow did.
    #[account(
        address = global.quote_mint @ CurveLaunchpadError::InvalidQuoteMint,
    )]
    pub quote_mint: Box<InterfaceAccount<'info, token_interface::Mint>>,

    /// The bonding curve PDA. Acts as authority for both the LST and MEME
    /// source ATAs as well as the retained LP token account.
    #[account(
        mut,
        seeds = [BondingCurve::SEED_PREFIX, mint.to_account_info().key.as_ref()],
        bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,

    /// Bonding curve's LST ATA. Source of `init_amount_0` (token_0 / LST side).
    /// The PDA-signed debit happens inside Raydium's `initialize` CPI, which we
    /// call via `invoke_signed` with the bonding_curve's PDA seeds below.
    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = token_program_2022,
    )]
    pub bonding_curve_quote_account: Box<InterfaceAccount<'info, token_interface::TokenAccount>>,

    /// Bonding curve's MEME ATA. Source of `init_amount_1` (token_1 / MEME side).
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
    )]
    pub bonding_curve_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Which config the pool belongs to. Validated by Raydium CPMM.
    pub amm_config: UncheckedAccount<'info>,

    /// CHECK: Pool vault & lp mint authority PDA. Validated by Raydium CPMM.
    pub authority: UncheckedAccount<'info>,

    /// CHECK: Pool state account, init by cp-swap.
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,

    /// CHECK: LP mint, init by cp-swap.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,

    /// LP token account owned by the bonding_curve PDA. Created lazily by the
    /// associated token program. We retain LP custody (no burn) so the
    /// program can later CPI `withdraw` on Raydium for the flip post-mig
    /// LP-drain path (see SPEC.md §4).
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = lp_mint,
        associated_token::authority = bonding_curve,
    )]
    pub program_lp_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: token_0 vault for the pool (LST side), init by cp-swap.
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,

    /// CHECK: token_1 vault for the pool (MEME side), init by cp-swap.
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,

    /// CHECK: Raydium create-pool fee receiver. Validated by Raydium CPMM.
    #[account(mut)]
    pub create_pool_fee: UncheckedAccount<'info>,

    /// CHECK: Oracle observations account, init by cp-swap.
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    /// CHECK: Raydium CPMM program id. Trusted only as a CPI target — the
    /// real validation comes from the discriminator + Raydium's own checks.
    pub cp_swap_program: UncheckedAccount<'info>,

    /// Legacy SPL Token program — token_program_1 slot (MEME side) and
    /// token_program_2_0 slot (create-pool fee, traditionally WSOL).
    pub token_program: Program<'info, Token>,

    /// CHECK: Token-2022 program — token_program_0 slot (LST side). Checked
    /// against the canonical token-2022 program id via address constraint.
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_program_2022: UncheckedAccount<'info>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn process(ctx: Context<Migrate>) -> Result<()> {
    require!(
        ctx.accounts.global.initialized,
        CurveLaunchpadError::NotInitialized
    );

    // The curve must have sold out before it can migrate.
    require!(
        ctx.accounts.bonding_curve.complete,
        CurveLaunchpadError::BondingCurveNotComplete,
    );

    // Refresh source balances in case anything else mutated them earlier in
    // the same tx.
    ctx.accounts.bonding_curve_quote_account.reload()?;
    ctx.accounts.bonding_curve_token_account.reload()?;

    let init_amount_0: u64 = ctx.accounts.bonding_curve_quote_account.amount;
    let init_amount_1: u64 = ctx.accounts.bonding_curve_token_account.amount;
    let open_time: u64 = 0;

    // Account ordering preserved verbatim from the original WSOL-paired flow.
    // Only token_0 mint (was WSOL, now LST) and token_program_0 (was legacy
    // Token, now Token-2022) change. The trailing bonding_curve PDA is passed
    // through so its signer seeds satisfy the source-ATA authority check
    // inside Raydium's CPI for the LST and MEME debits.
    let account_metas = vec![
        AccountMeta::new(ctx.accounts.creator.key(), true),
        AccountMeta::new_readonly(ctx.accounts.amm_config.key(), false),
        AccountMeta::new_readonly(ctx.accounts.authority.key(), false),
        AccountMeta::new(ctx.accounts.pool_state.key(), false),
        AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
        AccountMeta::new_readonly(ctx.accounts.mint.key(), false),
        AccountMeta::new(ctx.accounts.lp_mint.key(), false),
        AccountMeta::new(ctx.accounts.bonding_curve_quote_account.key(), false),
        AccountMeta::new(ctx.accounts.bonding_curve_token_account.key(), false),
        AccountMeta::new(ctx.accounts.program_lp_token.key(), false),
        AccountMeta::new(ctx.accounts.token_0_vault.key(), false),
        AccountMeta::new(ctx.accounts.token_1_vault.key(), false),
        AccountMeta::new(ctx.accounts.create_pool_fee.key(), false),
        AccountMeta::new(ctx.accounts.observation_state.key(), false),
        // token_program_0 slot = Token-2022 (LST side).
        AccountMeta::new_readonly(ctx.accounts.token_program_2022.key(), false),
        // token_program_1 slot = legacy SPL Token (MEME side).
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        // token_program_2_0 slot = legacy SPL Token (create-pool fee account).
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
        // Extra: bonding_curve PDA signs the source-ATA debits.
        AccountMeta::new_readonly(ctx.accounts.bonding_curve.key(), true),
    ];

    let payload = InitializePayload {
        init_amount_0,
        init_amount_1,
        open_time,
    };
    let mut serialized_data = Vec::new();
    payload.serialize(&mut serialized_data)?;
    let mut data = INITIALIZE_DISCRIMINANT.to_vec();
    data.append(&mut serialized_data);

    let initialize_ix =
        Instruction::new_with_bytes(ctx.accounts.cp_swap_program.key(), &data, account_metas);

    let mint_key = ctx.accounts.mint.key();
    let bonding_curve_signer: &[&[&[u8]]] = &[&[
        BondingCurve::SEED_PREFIX,
        mint_key.as_ref(),
        &[ctx.bumps.bonding_curve],
    ]];

    invoke_signed(
        &initialize_ix,
        &[
            ctx.accounts.creator.to_account_info(),
            ctx.accounts.amm_config.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.pool_state.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.lp_mint.to_account_info(),
            ctx.accounts.bonding_curve_quote_account.to_account_info(),
            ctx.accounts.bonding_curve_token_account.to_account_info(),
            ctx.accounts.program_lp_token.to_account_info(),
            ctx.accounts.token_0_vault.to_account_info(),
            ctx.accounts.token_1_vault.to_account_info(),
            ctx.accounts.create_pool_fee.to_account_info(),
            ctx.accounts.observation_state.to_account_info(),
            ctx.accounts.token_program_2022.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
            ctx.accounts.bonding_curve.to_account_info(),
        ],
        bonding_curve_signer,
    )?;

    // Read the LP balance that landed in our retained ATA so we can surface
    // it in the event. Raydium's `initialize` mints LP straight into
    // program_lp_token (we never burn it).
    ctx.accounts.program_lp_token.reload()?;
    let lp_received: u64 = ctx.accounts.program_lp_token.amount;

    emit!(MigrateEvent {
        mint: ctx.accounts.mint.key(),
        bonding_curve: ctx.accounts.bonding_curve.key(),
        pool_state: ctx.accounts.pool_state.key(),
        lp_mint: ctx.accounts.lp_mint.key(),
        quote_deposited: init_amount_0,
        meme_deposited: init_amount_1,
        lp_received,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
