use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
    token_interface::{
        transfer_checked, Mint as MintInterface, TokenAccount as TokenAccountInterface,
        TokenInterface, TransferChecked,
    },
};

#[path = "util_token22.rs"]
#[allow(dead_code)]
mod util_token22;

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

    mint: Account<'info, Mint>,

    #[account(
        address = global.quote_mint @ CurveLaunchpadError::InvalidQuoteMint,
    )]
    quote_mint: Box<InterfaceAccount<'info, MintInterface>>,

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
        seeds = [BondingCurve::SEED_PREFIX, mint.to_account_info().key.as_ref()],
        bump,
    )]
    bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
    )]
    bonding_curve_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = bonding_curve,
        associated_token::token_program = quote_token_program,
    )]
    bonding_curve_quote_account: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = quote_mint,
        associated_token::authority = user,
        associated_token::token_program = quote_token_program,
    )]
    user_quote_account: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    associated_token_program: Program<'info, AssociatedToken>,

    system_program: Program<'info, System>,

    token_program: Program<'info, Token>,

    quote_token_program: Interface<'info, TokenInterface>,
}

pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
    require!(
        ctx.accounts.global.initialized,
        CurveLaunchpadError::NotInitialized
    );

    require!(
        ctx.accounts.bonding_curve.complete == true,
        CurveLaunchpadError::BondingCurveNotComplete,
    );

    require!(
        ctx.accounts.user.key() == ctx.accounts.global.withdraw_authority,
        CurveLaunchpadError::InvalidWithdrawAuthority,
    );

    let signer: [&[&[u8]]; 1] = [&[
        BondingCurve::SEED_PREFIX,
        ctx.accounts.mint.to_account_info().key.as_ref(),
        &[ctx.bumps.bonding_curve],
    ]];

    // drain remaining MEME → withdraw authority (legacy Token v1)
    let meme_drain = Transfer {
        from: ctx.accounts.bonding_curve_token_account.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: ctx.accounts.bonding_curve.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            meme_drain,
            &signer,
        ),
        ctx.accounts.bonding_curve_token_account.amount,
    )?;

    // drain LST quote reserves → withdraw authority. We send the entire balance;
    // any TransferFee is borne by the destination implicitly (this is a full drain,
    // not a "user must net X" guarantee).
    let quote_drain_amount = ctx.accounts.bonding_curve_quote_account.amount;
    let quote_decimals = ctx.accounts.quote_mint.decimals;
    let quote_drain = TransferChecked {
        from: ctx.accounts.bonding_curve_quote_account.to_account_info(),
        mint: ctx.accounts.quote_mint.to_account_info(),
        to: ctx.accounts.user_quote_account.to_account_info(),
        authority: ctx.accounts.bonding_curve.to_account_info(),
    };
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.quote_token_program.to_account_info(),
            quote_drain,
            &signer,
        ),
        quote_drain_amount,
        quote_decimals,
    )?;

    let last_withdraw = &mut ctx.accounts.last_withdraw;
    last_withdraw.last_withdraw_timestamp = Clock::get()?.unix_timestamp;

    Ok(())
}
