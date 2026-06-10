use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    amm, calculate_fee,
    state::{BondingCurve, Global},
    CompleteEvent, CurveLaunchpadError, TradeEvent,
};

#[event_cpi]
#[derive(Accounts)]
pub struct Buy<'info> {
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
        mut,
        associated_token::mint = mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = user,
        associated_token::token_program = quote_token_program,
    )]
    user_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Platform's half of the trade fee, paid in quote token.
    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = global.fee_recipient,
        associated_token::token_program = quote_token_program,
    )]
    fee_recipient_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Creator's half of the trade fee, paid in quote token.
    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = bonding_curve.creator,
        associated_token::token_program = quote_token_program,
    )]
    creator_quote_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    system_program: Program<'info, System>,

    token_program: Interface<'info, TokenInterface>,

    quote_token_program: Interface<'info, TokenInterface>,
}

pub fn buy(ctx: Context<Buy>, token_amount: u64, max_quote_cost: u64) -> Result<()> {
    require!(
        ctx.accounts.global.initialized,
        CurveLaunchpadError::NotInitialized
    );

    require!(
        !ctx.accounts.bonding_curve.complete,
        CurveLaunchpadError::BondingCurveComplete,
    );

    require!(
        ctx.accounts.bonding_curve.real_token_reserves > 0,
        CurveLaunchpadError::InsufficientTokens,
    );

    require!(token_amount > 0, CurveLaunchpadError::MinBuy,);

    let target_token_amount = token_amount
        .min(ctx.accounts.bonding_curve_token_account.amount)
        .min(ctx.accounts.bonding_curve.real_token_reserves);

    let mut amm = amm::amm::AMM::new(
        ctx.accounts.bonding_curve.virtual_quote_reserves as u128,
        ctx.accounts.bonding_curve.virtual_token_reserves as u128,
        ctx.accounts.bonding_curve.real_quote_reserves as u128,
        ctx.accounts.bonding_curve.real_token_reserves as u128,
        ctx.accounts.global.initial_virtual_token_reserves as u128,
    );

    let buy_result = amm
        .apply_buy(target_token_amount as u128)
        .ok_or(CurveLaunchpadError::InvalidCurveParams)?;
    let fee = calculate_fee(buy_result.sol_amount, ctx.accounts.global.fee_basis_points);
    // 50/50 split between platform and creator.
    let platform_fee = fee / 2;
    let creator_fee = fee - platform_fee;
    let buy_amount_with_fee = buy_result.sol_amount + fee;

    require!(
        buy_amount_with_fee <= max_quote_cost,
        CurveLaunchpadError::MaxQuoteCostExceeded,
    );

    require!(
        ctx.accounts.user_quote_token_account.amount >= buy_amount_with_fee,
        CurveLaunchpadError::InsufficientQuote,
    );

    let quote_decimals = ctx.accounts.quote_mint.decimals;

    // quote into the curve vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.quote_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_quote_token_account.to_account_info(),
                mint: ctx.accounts.quote_mint.to_account_info(),
                to: ctx
                    .accounts
                    .bonding_curve_quote_token_account
                    .to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        buy_result.sol_amount,
        quote_decimals,
    )?;

    if platform_fee > 0 {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.quote_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_quote_token_account.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx
                        .accounts
                        .fee_recipient_quote_token_account
                        .to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            platform_fee,
            quote_decimals,
        )?;
    }

    if creator_fee > 0 {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.quote_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_quote_token_account.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.creator_quote_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            creator_fee,
            quote_decimals,
        )?;
    }

    // tokens out of curve inventory to the user
    let mint_key = ctx.accounts.mint.key();
    let quote_mint_key = ctx.accounts.quote_mint.key();
    let signer: [&[&[u8]]; 1] = [&[
        BondingCurve::SEED_PREFIX,
        mint_key.as_ref(),
        quote_mint_key.as_ref(),
        &[ctx.bumps.bonding_curve],
    ]];

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
        buy_result.token_amount,
        ctx.accounts.mint.decimals,
    )?;

    let bonding_curve = &mut ctx.accounts.bonding_curve;
    bonding_curve.real_token_reserves = amm.real_token_reserves as u64;
    bonding_curve.real_quote_reserves = amm.real_sol_reserves as u64;
    bonding_curve.virtual_token_reserves = amm.virtual_token_reserves as u64;
    bonding_curve.virtual_quote_reserves = amm.virtual_sol_reserves as u64;

    emit_cpi!(TradeEvent {
        mint: ctx.accounts.mint.key(),
        quote_mint: ctx.accounts.quote_mint.key(),
        quote_amount: buy_result.sol_amount,
        token_amount: buy_result.token_amount,
        is_buy: true,
        user: ctx.accounts.user.key(),
        timestamp: Clock::get()?.unix_timestamp,
        virtual_quote_reserves: bonding_curve.virtual_quote_reserves,
        virtual_token_reserves: bonding_curve.virtual_token_reserves,
        real_quote_reserves: bonding_curve.real_quote_reserves,
        real_token_reserves: bonding_curve.real_token_reserves,
    });

    if bonding_curve.real_token_reserves == 0 {
        bonding_curve.complete = true;

        emit_cpi!(CompleteEvent {
            user: ctx.accounts.user.key(),
            mint: ctx.accounts.mint.key(),
            quote_mint: ctx.accounts.quote_mint.key(),
            bonding_curve: bonding_curve.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
    }

    Ok(())
}
