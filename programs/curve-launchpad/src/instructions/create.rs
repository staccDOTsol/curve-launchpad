use crate::{
    state::{BondingCurve, Global},
    CreateEvent, CurveLaunchpadError,
};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

/// Creates a bonding curve for an EXISTING mint against a given quote token.
///
/// The program never touches mint authority: the creator pre-mints the supply
/// to their own token account and this instruction pulls
/// `global.initial_token_supply` tokens into the curve's inventory. The
/// creator keeps mint authority until they choose to revoke it (the frontend
/// revokes it in the same bundle, after all curves are created).
#[event_cpi]
#[derive(Accounts)]
pub struct Create<'info> {
    #[account(mut)]
    creator: Signer<'info>,

    mint: Box<InterfaceAccount<'info, Mint>>,

    quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        seeds = [
            BondingCurve::SEED_PREFIX,
            mint.key().as_ref(),
            quote_mint.key().as_ref(),
        ],
        bump,
        space = 8 + BondingCurve::INIT_SPACE,
    )]
    bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = token_program,
    )]
    bonding_curve_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = quote_mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = quote_token_program,
    )]
    bonding_curve_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program,
    )]
    creator_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        seeds = [Global::SEED_PREFIX],
        bump,
    )]
    global: Box<Account<'info, Global>>,

    system_program: Program<'info, System>,

    token_program: Interface<'info, TokenInterface>,

    quote_token_program: Interface<'info, TokenInterface>,

    associated_token_program: Program<'info, AssociatedToken>,
}

pub fn create(
    ctx: Context<Create>,
    virtual_quote_reserves: u64,
    target_market_cap: u64,
) -> Result<()> {
    require!(
        ctx.accounts.global.initialized,
        CurveLaunchpadError::NotInitialized
    );

    require!(
        ctx.accounts.mint.key() != ctx.accounts.quote_mint.key(),
        CurveLaunchpadError::InvalidQuoteMint
    );

    require!(virtual_quote_reserves > 0, CurveLaunchpadError::InvalidCurveParams);

    // Fund the curve with the launch supply from the creator's pre-minted tokens.
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.creator_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.bonding_curve_token_account.to_account_info(),
                authority: ctx.accounts.creator.to_account_info(),
            },
        ),
        ctx.accounts.global.initial_token_supply,
        ctx.accounts.mint.decimals,
    )?;

    let bonding_curve = &mut ctx.accounts.bonding_curve;
    bonding_curve.mint = ctx.accounts.mint.key();
    bonding_curve.quote_mint = ctx.accounts.quote_mint.key();
    bonding_curve.creator = ctx.accounts.creator.key();
    bonding_curve.virtual_quote_reserves = virtual_quote_reserves;
    bonding_curve.virtual_token_reserves = ctx.accounts.global.initial_virtual_token_reserves;
    bonding_curve.real_quote_reserves = 0;
    bonding_curve.real_token_reserves = ctx.accounts.global.initial_real_token_reserves;
    bonding_curve.token_total_supply = ctx.accounts.global.initial_token_supply;
    bonding_curve.target_market_cap = target_market_cap;
    bonding_curve.complete = false;

    emit_cpi!(CreateEvent {
        mint: ctx.accounts.mint.key(),
        quote_mint: ctx.accounts.quote_mint.key(),
        bonding_curve: ctx.accounts.bonding_curve.key(),
        creator: ctx.accounts.creator.key(),
        virtual_quote_reserves,
        target_market_cap,
    });

    Ok(())
}
