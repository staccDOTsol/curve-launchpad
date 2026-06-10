use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    state::{BondingCurve, Global, LastWithdraw},
    CurveLaunchpadError,
};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    user: Signer<'info>,

    #[account(
        seeds = [Global::SEED_PREFIX],
        bump,
    )]
    global: Box<Account<'info, Global>>,

    mint: Box<InterfaceAccount<'info, Mint>>,

    quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        space = 8 + LastWithdraw::INIT_SPACE,
        seeds = [LastWithdraw::SEED_PREFIX],
        bump,
        payer = user,
    )]
    last_withdraw: Box<Account<'info, LastWithdraw>>,

    #[account(
        mut,
        seeds = [
            BondingCurve::SEED_PREFIX,
            mint.key().as_ref(),
            quote_mint.key().as_ref(),
        ],
        bump,
    )]
    bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = token_program,
    )]
    bonding_curve_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = quote_token_program,
    )]
    bonding_curve_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = quote_mint,
        associated_token::authority = user,
        associated_token::token_program = quote_token_program,
    )]
    user_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    associated_token_program: Program<'info, AssociatedToken>,

    system_program: Program<'info, System>,

    token_program: Interface<'info, TokenInterface>,

    quote_token_program: Interface<'info, TokenInterface>,
}

pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
    require!(
        ctx.accounts.global.initialized,
        CurveLaunchpadError::NotInitialized
    );

    require!(
        ctx.accounts.bonding_curve.complete,
        CurveLaunchpadError::BondingCurveNotComplete,
    );

    require!(
        ctx.accounts.user.key() == ctx.accounts.global.withdraw_authority,
        CurveLaunchpadError::InvalidWithdrawAuthority,
    );

    let mint_key = ctx.accounts.mint.key();
    let quote_mint_key = ctx.accounts.quote_mint.key();
    let signer: [&[&[u8]]; 1] = [&[
        BondingCurve::SEED_PREFIX,
        mint_key.as_ref(),
        quote_mint_key.as_ref(),
        &[ctx.bumps.bonding_curve],
    ]];

    // remaining token inventory to the withdraw authority
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.bonding_curve_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.bonding_curve.to_account_info(),
            },
            &signer,
        ),
        ctx.accounts.bonding_curve_token_account.amount,
        ctx.accounts.mint.decimals,
    )?;

    // raised quote to the withdraw authority
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.quote_token_program.to_account_info(),
            TransferChecked {
                from: ctx
                    .accounts
                    .bonding_curve_quote_token_account
                    .to_account_info(),
                mint: ctx.accounts.quote_mint.to_account_info(),
                to: ctx.accounts.user_quote_token_account.to_account_info(),
                authority: ctx.accounts.bonding_curve.to_account_info(),
            },
            &signer,
        ),
        ctx.accounts.bonding_curve_quote_token_account.amount,
        ctx.accounts.quote_mint.decimals,
    )?;

    let last_withdraw = &mut ctx.accounts.last_withdraw;
    last_withdraw.last_withdraw_timestamp = Clock::get()?.unix_timestamp;

    Ok(())
}
