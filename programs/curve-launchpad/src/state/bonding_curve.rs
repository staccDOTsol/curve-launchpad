use anchor_lang::prelude::*;
use std::fmt;

#[account]
#[derive(InitSpace)]
pub struct BondingCurve {
    /// The token being launched on this curve.
    pub mint: Pubkey,
    /// The quote token this curve trades against (wSOL, USDC, USDT, ...).
    pub quote_mint: Pubkey,
    /// Coin creator. Receives half of every trade fee.
    pub creator: Pubkey,
    pub virtual_quote_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_quote_reserves: u64,
    pub real_token_reserves: u64,
    pub token_total_supply: u64,
    /// Informational: market cap (in raw quote units) at which the curve completes.
    pub target_market_cap: u64,
    pub complete: bool,
}

impl BondingCurve {
    pub const SEED_PREFIX: &'static [u8; 13] = b"bonding-curve";
}

impl fmt::Display for BondingCurve {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(
            f,
            "mint: {}, quote_mint: {}, creator: {}, virtual_quote_reserves: {}, virtual_token_reserves: {}, real_quote_reserves: {}, real_token_reserves: {}, token_total_supply: {}, target_market_cap: {}, complete: {}",
            self.mint,
            self.quote_mint,
            self.creator,
            self.virtual_quote_reserves,
            self.virtual_token_reserves,
            self.real_quote_reserves,
            self.real_token_reserves,
            self.token_total_supply,
            self.target_market_cap,
            self.complete
        )
    }
}
