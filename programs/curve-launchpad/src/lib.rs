use anchor_lang::prelude::*;

use instructions::*;

pub mod amm;
pub mod instructions;
pub mod state;

declare_id!("G2LGhLggpxLknXSkEhWqmukeS1m6NJXYqhaDHrV6JejZ");

#[program]
pub mod curve_launchpad {

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::initialize(ctx)
    }

    /// Creates a bonding curve for an existing mint against `quote_mint`.
    /// `virtual_quote_reserves` is derived client-side from the curve's
    /// target market cap; `target_market_cap` is stored for display.
    pub fn create(
        ctx: Context<Create>,
        virtual_quote_reserves: u64,
        target_market_cap: u64,
    ) -> Result<()> {
        create::create(ctx, virtual_quote_reserves, target_market_cap)
    }

    pub fn buy(ctx: Context<Buy>, token_amount: u64, max_quote_cost: u64) -> Result<()> {
        buy::buy(ctx, token_amount, max_quote_cost)
    }

    pub fn sell(ctx: Context<Sell>, token_amount: u64, min_quote_output: u64) -> Result<()> {
        sell::sell(ctx, token_amount, min_quote_output)
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        withdraw::withdraw(ctx)
    }

    pub fn set_params(
        ctx: Context<SetParams>,
        fee_recipient: Pubkey,
        withdraw_authority: Pubkey,
        initial_virtual_token_reserves: u64,
        initial_virtual_sol_reserves: u64,
        initial_real_token_reserves: u64,
        inital_token_supply: u64,
        fee_basis_points: u64,
    ) -> Result<()> {
        set_params::set_params(
            ctx,
            fee_recipient,
            withdraw_authority,
            initial_virtual_token_reserves,
            initial_virtual_sol_reserves,
            initial_real_token_reserves,
            inital_token_supply,
            fee_basis_points,
        )
    }
}
