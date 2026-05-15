use anchor_lang::prelude::*;
use spl_token_2022::extension::{
    transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions,
};

use crate::CurveLaunchpadError;

/// Given a Token-2022 mint account and a desired NET amount the receiver
/// must end up with, return the GROSS amount to pass to `transfer_checked`
/// so that after the TransferFee extension is deducted, the receiver nets
/// exactly `net`.
///
/// If the mint has no TransferFeeConfig extension (legacy Token v1 or
/// Token-2022 without TransferFee), this returns `net` unchanged.
pub fn gross_up_for_fee(mint: &AccountInfo, net: u64) -> Result<u64> {
    let mint_data = mint.try_borrow_data()?;
    // Token-2022 mints have a discriminator past the legacy Mint layout.
    // `StateWithExtensions::unpack` works for both legacy and 2022 mints,
    // but extensions only exist on 2022. For legacy mints, the extension
    // lookup simply returns Err, which we treat as "no fee".
    let gross = match StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data) {
        Ok(mint_with_ext) => match mint_with_ext.get_extension::<TransferFeeConfig>() {
            Ok(cfg) => {
                let epoch = Clock::get()?.epoch;
                let fee: u64 = cfg.calculate_inverse_epoch_fee(epoch, net).unwrap_or(0);
                net.checked_add(fee)
                    .ok_or(error!(CurveLaunchpadError::InsufficientQuote))?
            }
            Err(_) => net,
        },
        Err(_) => net,
    };
    Ok(gross)
}
