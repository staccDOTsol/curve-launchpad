use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, Token, TokenAccount, Transfer},
    token_interface::{
        self, Mint as MintInterface, TokenAccount as TokenAccountInterface, TokenInterface,
        TransferChecked,
    },
};
use spl_token_2022::extension::{
    transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions,
};
use switchboard_on_demand::RandomnessAccountData;

use crate::{
    amm,
    state::{BondingCurve, Global},
    CurveLaunchpadError, FlipEvent,
};

#[event_cpi]
#[derive(Accounts)]
pub struct Flip<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [Global::SEED_PREFIX],
        bump,
    )]
    pub global: Box<Account<'info, Global>>,

    /// CHECK: validated against `global.fee_recipient`
    pub fee_recipient: AccountInfo<'info>,

    pub attacker_mint: Account<'info, Mint>,

    pub target_mint: Account<'info, Mint>,

    #[account(
        address = global.quote_mint @ CurveLaunchpadError::InvalidQuoteMint,
    )]
    pub quote_mint: Box<InterfaceAccount<'info, MintInterface>>,

    #[account(
        mut,
        seeds = [BondingCurve::SEED_PREFIX, attacker_mint.to_account_info().key.as_ref()],
        bump,
    )]
    pub attacker_bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        seeds = [BondingCurve::SEED_PREFIX, target_mint.to_account_info().key.as_ref()],
        bump,
    )]
    pub target_bonding_curve: Box<Account<'info, BondingCurve>>,

    #[account(
        mut,
        associated_token::mint = attacker_mint,
        associated_token::authority = attacker_bonding_curve,
    )]
    pub attacker_bonding_curve_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = attacker_bonding_curve,
        associated_token::token_program = quote_token_program,
    )]
    pub attacker_bonding_curve_quote_account: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = target_bonding_curve,
        associated_token::token_program = quote_token_program,
    )]
    pub target_bonding_curve_quote_account: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    #[account(
        mut,
        associated_token::mint = attacker_mint,
        associated_token::authority = user,
    )]
    pub user_attacker_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = quote_mint,
        associated_token::authority = fee_recipient,
        associated_token::token_program = quote_token_program,
    )]
    pub fee_recipient_quote_account: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// CHECK: parsed and validated by `RandomnessAccountData::parse`
    pub randomness_account_data: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

pub fn flip(ctx: Context<Flip>, wager_meme_amount: u64) -> Result<()> {
    require!(
        ctx.accounts.global.initialized,
        CurveLaunchpadError::NotInitialized
    );

    require!(
        ctx.accounts.fee_recipient.key == &ctx.accounts.global.fee_recipient,
        CurveLaunchpadError::InvalidFeeRecipient,
    );

    require!(
        ctx.accounts.attacker_mint.key() != ctx.accounts.target_mint.key(),
        CurveLaunchpadError::FlipSameCurve,
    );

    require!(
        wager_meme_amount > 0,
        CurveLaunchpadError::FlipInsufficientWager,
    );

    require!(
        ctx.accounts.user_attacker_token_account.amount >= wager_meme_amount,
        CurveLaunchpadError::FlipInsufficientWager,
    );

    // ------------------------------------------------------------------
    // 1) Read Switchboard On-Demand VRF (single-tx settlement).
    // ------------------------------------------------------------------
    let clock = Clock::get()?;
    let randomness_data = RandomnessAccountData::parse(
        ctx.accounts.randomness_account_data.data.borrow(),
    )
    .map_err(|_| error!(CurveLaunchpadError::FlipBadRandomness))?;
    let revealed = randomness_data
        .get_value(&clock)
        .map_err(|_| error!(CurveLaunchpadError::FlipBadRandomness))?;
    let outcome_win = (revealed[0] & 1) == 0;

    // Decimals of the LST mint (needed for transfer_checked + fee gross-up).
    let quote_decimals = ctx.accounts.quote_mint.decimals;
    let epoch = clock.epoch;

    // Bump caches for PDA signing.
    let attacker_bump = ctx.bumps.attacker_bonding_curve;
    let target_bump = ctx.bumps.target_bonding_curve;
    let attacker_mint_key = ctx.accounts.attacker_mint.key();
    let target_mint_key = ctx.accounts.target_mint.key();

    // Captured event payload (filled in per-branch).
    let stolen_lst_out: u64;
    let treasury_cut_out: u64;

    if outcome_win {
        // -------------------- WIN PATH --------------------
        require!(
            ctx.accounts.target_bonding_curve.real_quote_reserves > 0,
            CurveLaunchpadError::FlipTargetEmpty,
        );

        // Price the wager under the attacker curve.
        let attacker_amm = amm::amm::AMM::new(
            ctx.accounts.attacker_bonding_curve.virtual_quote_reserves as u128,
            ctx.accounts.attacker_bonding_curve.virtual_token_reserves as u128,
            ctx.accounts.attacker_bonding_curve.real_quote_reserves as u128,
            ctx.accounts.attacker_bonding_curve.real_token_reserves as u128,
            ctx.accounts.global.initial_virtual_token_reserves as u128,
        );
        let priced = attacker_amm
            .get_buy_price(wager_meme_amount as u128)
            .ok_or(error!(CurveLaunchpadError::FlipBadRandomness))?;

        let priced_u64: u64 = u64::try_from(priced)
            .map_err(|_| error!(CurveLaunchpadError::FlipBadRandomness))?;
        let target_available = ctx.accounts.target_bonding_curve.real_quote_reserves;
        let stolen_lst: u64 = priced_u64.min(target_available);

        // 95% attacker, 5% treasury (rounding to treasury).
        let to_attacker: u64 = (stolen_lst as u128)
            .checked_mul(95)
            .and_then(|v| v.checked_div(100))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(error!(CurveLaunchpadError::FlipBadRandomness))?;
        let to_treasury: u64 = stolen_lst
            .checked_sub(to_attacker)
            .ok_or(error!(CurveLaunchpadError::FlipBadRandomness))?;

        // Burn wagered MEME (authority = user). Legacy Token v1.
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.attacker_mint.to_account_info(),
                    from: ctx.accounts.user_attacker_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            wager_meme_amount,
        )?;

        // Signer seeds for target BC PDA (paying out stolen LST).
        let target_signer_seeds: [&[&[u8]]; 1] = [&[
            BondingCurve::SEED_PREFIX,
            target_mint_key.as_ref(),
            &[target_bump],
        ]];

        // Transfer to attacker — gross up to absorb fee so attacker receives `to_attacker`.
        if to_attacker > 0 {
            let gross_attacker = gross_up_for_transfer_fee(
                &ctx.accounts.quote_mint.to_account_info(),
                to_attacker,
                epoch,
            )?;
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.quote_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx
                            .accounts
                            .target_bonding_curve_quote_account
                            .to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: ctx
                            .accounts
                            .attacker_bonding_curve_quote_account
                            .to_account_info(),
                        authority: ctx.accounts.target_bonding_curve.to_account_info(),
                    },
                    &target_signer_seeds,
                ),
                gross_attacker,
                quote_decimals,
            )?;
        }

        // Transfer to treasury — same authority, same gross-up.
        if to_treasury > 0 {
            let gross_treasury = gross_up_for_transfer_fee(
                &ctx.accounts.quote_mint.to_account_info(),
                to_treasury,
                epoch,
            )?;
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.quote_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx
                            .accounts
                            .target_bonding_curve_quote_account
                            .to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: ctx
                            .accounts
                            .fee_recipient_quote_account
                            .to_account_info(),
                        authority: ctx.accounts.target_bonding_curve.to_account_info(),
                    },
                    &target_signer_seeds,
                ),
                gross_treasury,
                quote_decimals,
            )?;
        }

        // Update on-chain reserves and supply.
        let attacker = &mut ctx.accounts.attacker_bonding_curve;
        attacker.real_quote_reserves = attacker
            .real_quote_reserves
            .checked_add(to_attacker)
            .ok_or(error!(CurveLaunchpadError::FlipBadRandomness))?;
        attacker.token_total_supply = attacker
            .token_total_supply
            .checked_sub(wager_meme_amount)
            .ok_or(error!(CurveLaunchpadError::FlipBadRandomness))?;

        let target = &mut ctx.accounts.target_bonding_curve;
        target.real_quote_reserves = target
            .real_quote_reserves
            .checked_sub(stolen_lst)
            .ok_or(error!(CurveLaunchpadError::FlipBadRandomness))?;

        stolen_lst_out = stolen_lst;
        treasury_cut_out = to_treasury;
    } else {
        // -------------------- LOSS PATH --------------------
        // User sends MEME → attacker BC.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_attacker_token_account.to_account_info(),
                    to: ctx
                        .accounts
                        .attacker_bonding_curve_token_account
                        .to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            wager_meme_amount,
        )?;

        // Apply sell on attacker AMM to compute loss.
        let mut attacker_amm = amm::amm::AMM::new(
            ctx.accounts.attacker_bonding_curve.virtual_quote_reserves as u128,
            ctx.accounts.attacker_bonding_curve.virtual_token_reserves as u128,
            ctx.accounts.attacker_bonding_curve.real_quote_reserves as u128,
            ctx.accounts.attacker_bonding_curve.real_token_reserves as u128,
            ctx.accounts.global.initial_virtual_token_reserves as u128,
        );

        let sell_result = attacker_amm
            .apply_sell(wager_meme_amount as u128)
            .ok_or(error!(CurveLaunchpadError::FlipBadRandomness))?;
        let loss_lst = sell_result.quote_amount;

        // Transfer loss LST: attacker BC → target BC. Signed by attacker PDA.
        let attacker_signer_seeds: [&[&[u8]]; 1] = [&[
            BondingCurve::SEED_PREFIX,
            attacker_mint_key.as_ref(),
            &[attacker_bump],
        ]];

        if loss_lst > 0 {
            let gross_loss = gross_up_for_transfer_fee(
                &ctx.accounts.quote_mint.to_account_info(),
                loss_lst,
                epoch,
            )?;
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.quote_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx
                            .accounts
                            .attacker_bonding_curve_quote_account
                            .to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: ctx
                            .accounts
                            .target_bonding_curve_quote_account
                            .to_account_info(),
                        authority: ctx.accounts.attacker_bonding_curve.to_account_info(),
                    },
                    &attacker_signer_seeds,
                ),
                gross_loss,
                quote_decimals,
            )?;
        }

        // Persist all four attacker reserve fields from the AMM (apply_sell touched them all).
        let attacker = &mut ctx.accounts.attacker_bonding_curve;
        attacker.real_token_reserves = attacker_amm.real_token_reserves as u64;
        attacker.virtual_token_reserves = attacker_amm.virtual_token_reserves as u64;
        attacker.virtual_quote_reserves = attacker_amm.virtual_quote_reserves as u64;
        attacker.real_quote_reserves = attacker_amm.real_quote_reserves as u64;

        let target = &mut ctx.accounts.target_bonding_curve;
        target.real_quote_reserves = target
            .real_quote_reserves
            .checked_add(loss_lst)
            .ok_or(error!(CurveLaunchpadError::FlipBadRandomness))?;

        stolen_lst_out = loss_lst;
        treasury_cut_out = 0;
    }

    emit_cpi!(FlipEvent {
        attacker_mint: attacker_mint_key,
        target_mint: target_mint_key,
        user: *ctx.accounts.user.to_account_info().key,
        wager_meme: wager_meme_amount,
        outcome_win,
        stolen_lst: stolen_lst_out,
        treasury_cut: treasury_cut_out,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Gross up a desired post-fee delivery amount for a Token-2022 mint that may
/// carry a `TransferFeeConfig` extension. If the mint has no fee config the
/// input is returned unchanged.
fn gross_up_for_transfer_fee(
    mint_account: &AccountInfo,
    post_fee_amount: u64,
    epoch: u64,
) -> Result<u64> {
    let data = mint_account.data.borrow();
    // Mint may be classic-SPL-packed (no extensions) or Token-2022 with extensions.
    // `StateWithExtensions::unpack` handles both.
    let state =
        match StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data) {
            Ok(s) => s,
            Err(_) => return Ok(post_fee_amount),
        };
    match state.get_extension::<TransferFeeConfig>() {
        Ok(cfg) => {
            let fee = cfg
                .calculate_inverse_epoch_fee(epoch, post_fee_amount)
                .unwrap_or(0);
            Ok(post_fee_amount.saturating_add(fee))
        }
        Err(_) => Ok(post_fee_amount),
    }
}
