use anchor_lang::prelude::*;

use instructions::*;

pub mod amm;
pub mod instructions;
pub mod state;

declare_id!("Cpm3iVenngWyh3YQUXtjR1PudXBXfJJqLhxMGrDiVSkW");

// Typed CPI bindings for Raydium CPMM, generated from the on-chain IDL at
// `idls/raydium_cp_swap.json`. Used by `migrate` for pool init and (eventually)
// by the post-mig flip drain path.
declare_program!(raydium_cp_swap);

#[program]
pub mod curve_launchpad {

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::initialize(ctx)
    }

    pub fn create(ctx: Context<Create>, name: String, symbol: String, uri: String) -> Result<()> {
        create::create(ctx, name, symbol, uri)
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

    pub fn migrate(ctx: Context<Migrate>) -> Result<()> {
        migrate::process(ctx)
    }

    pub fn set_params(
        ctx: Context<SetParams>,
        fee_recipient: Pubkey,
        withdraw_authority: Pubkey,
        initial_virtual_token_reserves: u64,
        initial_virtual_quote_reserves: u64,
        initial_real_token_reserves: u64,
        initial_token_supply: u64,
        fee_basis_points: u64,
        quote_mint: Pubkey,
    ) -> Result<()> {
        set_params::set_params(
            ctx,
            fee_recipient,
            withdraw_authority,
            initial_virtual_token_reserves,
            initial_virtual_quote_reserves,
            initial_real_token_reserves,
            initial_token_supply,
            fee_basis_points,
            quote_mint,
        )
    }

    pub fn flip(ctx: Context<Flip>, wager_meme_amount: u64) -> Result<()> {
        flip::flip(ctx, wager_meme_amount)
    }
}
