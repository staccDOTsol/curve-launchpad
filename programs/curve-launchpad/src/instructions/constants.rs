use anchor_lang::prelude::Pubkey;
use anchor_lang::pubkey;

pub const DEFAULT_DECIMALS: u32 = 6;
pub const DEFAULT_TOKEN_LAMPORTS: u64 = (10 as u64).pow(DEFAULT_DECIMALS);
pub const DEFAULT_TOKEN_SUPPLY: u64 = 1_000_000_000 * DEFAULT_TOKEN_LAMPORTS;

pub const STACC_QUOTE_MINT: Pubkey = pubkey!("6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f");
