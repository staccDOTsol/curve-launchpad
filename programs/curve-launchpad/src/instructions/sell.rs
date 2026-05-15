use crate::{
    amm, calculate_fee, state::{BondingCurve, Global}, CurveLaunchpadError, TradeEvent
};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

#[event_cpi]
#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    user: Signer<'info>,

    #[account(
        seeds = [Global::SEED_PREFIX],
        bump,
    )]
    global: Box<Account<'info, Global>>,

    /// CHECK: Using global state to validate fee_recipient account
    fee_recipient: AccountInfo<'info>,

    mint: Account<'info, Mint>,

    #[account(
        address = global.quote_mint @ CurveLaunchpadError::InvalidQuoteMint,
    )]
    quote_mint: Box<Account<'info, Mint>>,

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
    )]
    bonding_curve_quote_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    user_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = quote_mint,
        associated_token::authority = user,
    )]
    user_quote_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = quote_mint,
        associated_token::authority = fee_recipient,
    )]
    fee_recipient_quote_account: Box<Account<'info, TokenAccount>>,

    system_program: Program<'info, System>,

    token_program: Program<'info, Token>,

    associated_token_program: Program<'info, AssociatedToken>,
}

pub fn sell(ctx: Context<Sell>, token_amount: u64, min_quote_output: u64) -> Result<()> {
    require!(
        !ctx.accounts.bonding_curve.complete,
        CurveLaunchpadError::BondingCurveComplete,
    );

    require!(
        ctx.accounts.user_token_account.amount >= token_amount,
        CurveLaunchpadError::InsufficientTokens,
    );

    require!(
        ctx.accounts.fee_recipient.key == &ctx.accounts.global.fee_recipient,
        CurveLaunchpadError::InvalidFeeRecipient,
    );

    require!(
        ctx.accounts.bonding_curve_token_account.amount >= token_amount,
        CurveLaunchpadError::InsufficientTokens,
    );

    require!(token_amount > 0, CurveLaunchpadError::MinSell,);

    let mut amm = amm::amm::AMM::new(
        ctx.accounts.bonding_curve.virtual_quote_reserves as u128,
        ctx.accounts.bonding_curve.virtual_token_reserves as u128,
        ctx.accounts.bonding_curve.real_quote_reserves as u128,
        ctx.accounts.bonding_curve.real_token_reserves as u128,
        ctx.accounts.global.initial_virtual_token_reserves as u128,
    );

    let sell_result = amm.apply_sell(token_amount as u128).unwrap();
    let fee = calculate_fee(sell_result.quote_amount, ctx.accounts.global.fee_basis_points);

    let sell_amount_minus_fee = sell_result.quote_amount - fee;

    require!(
        sell_amount_minus_fee >= min_quote_output,
        CurveLaunchpadError::MinQuoteOutputExceeded,
    );

    require!(
        ctx.accounts.bonding_curve_quote_account.amount >= sell_result.quote_amount,
        CurveLaunchpadError::InsufficientQuote,
    );

    // transfer MEME from user → bonding curve
    let meme_to_curve = Transfer {
        from: ctx.accounts.user_token_account.to_account_info(),
        to: ctx.accounts.bonding_curve_token_account.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    token::transfer(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), meme_to_curve),
        sell_result.token_amount,
    )?;

    let signer: [&[&[u8]]; 1] = [&[
        BondingCurve::SEED_PREFIX,
        ctx.accounts.mint.to_account_info().key.as_ref(),
        &[ctx.bumps.bonding_curve],
    ]];

    // transfer LST from bonding curve → user
    let quote_to_user = Transfer {
        from: ctx.accounts.bonding_curve_quote_account.to_account_info(),
        to: ctx.accounts.user_quote_account.to_account_info(),
        authority: ctx.accounts.bonding_curve.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            quote_to_user,
            &signer,
        ),
        sell_amount_minus_fee,
    )?;

    // transfer LST fee from bonding curve → fee recipient
    let quote_to_fee_recipient = Transfer {
        from: ctx.accounts.bonding_curve_quote_account.to_account_info(),
        to: ctx.accounts.fee_recipient_quote_account.to_account_info(),
        authority: ctx.accounts.bonding_curve.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            quote_to_fee_recipient,
            &signer,
        ),
        fee,
    )?;

    let bonding_curve = &mut ctx.accounts.bonding_curve;
    bonding_curve.real_token_reserves = amm.real_token_reserves as u64;
    bonding_curve.real_quote_reserves = amm.real_quote_reserves as u64;
    bonding_curve.virtual_token_reserves = amm.virtual_token_reserves as u64;
    bonding_curve.virtual_quote_reserves = amm.virtual_quote_reserves as u64;

    emit_cpi!(TradeEvent {
        mint: *ctx.accounts.mint.to_account_info().key,
        quote_amount: sell_result.quote_amount,
        token_amount: sell_result.token_amount,
        is_buy: false,
        user: *ctx.accounts.user.to_account_info().key,
        timestamp: Clock::get()?.unix_timestamp,
        virtual_quote_reserves: bonding_curve.virtual_quote_reserves,
        virtual_token_reserves: bonding_curve.virtual_token_reserves,
        real_quote_reserves: bonding_curve.real_quote_reserves,
        real_token_reserves: bonding_curve.real_token_reserves,
    });

    Ok(())
}
