use anchor_lang::prelude::*;
use std::fmt;

#[account]
#[derive(InitSpace)]
pub struct BondingCurve {
    pub virtual_quote_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_quote_reserves: u64,
    pub real_token_reserves: u64,
    pub token_total_supply: u64,
    pub complete: bool,
}

impl BondingCurve {
    pub const SEED_PREFIX: &'static [u8; 13] = b"bonding-curve";
}

impl fmt::Display for BondingCurve {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(
            f,
            "virtual_quote_reserves: {}, virtual_token_reserves: {}, real_quote_reserves: {}, real_token_reserves: {}, token_total_supply: {}, complete: {}",
            self.virtual_quote_reserves,
            self.virtual_token_reserves,
            self.real_quote_reserves,
            self.real_token_reserves,
            self.token_total_supply,
            self.complete
        )
    }
}
