use anchor_lang::error_code;


#[error_code]
pub enum CurveLaunchpadError {
    #[msg("Global Already Initialized")]
    AlreadyInitialized,
    #[msg("Global Not Initialized")]
    NotInitialized,
    #[msg("Invalid Authority")]
    InvalidAuthority,
    #[msg("Bonding Curve Complete")]
    BondingCurveComplete,
    #[msg("Bonding Curve Not Complete")]
    BondingCurveNotComplete,
    #[msg("Insufficient Tokens")]
    InsufficientTokens,
    #[msg("Insufficient Quote")]
    InsufficientQuote,
    #[msg("Max Quote Cost Exceeded")]
    MaxQuoteCostExceeded,
    #[msg("Min Quote Output Exceeded")]
    MinQuoteOutputExceeded,
    #[msg("Min buy is 1 Token")]
    MinBuy,
    #[msg("Min sell is 1 Token")]
    MinSell,
    #[msg("Invalid Fee Recipient")]
    InvalidFeeRecipient,
    #[msg("Invalid Withdraw Authority")]
    InvalidWithdrawAuthority,
    #[msg("Invalid Quote Mint")]
    InvalidQuoteMint,
}
