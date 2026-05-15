use anchor_lang::prelude::*;

// PR-2: full rewrite to use LST/MEME on Raydium CPMM and retain LP
// authority under the program (no burn). The original WSOL-paired,
// LP-burning flow has been removed. See SPEC.md §3 and §4 (post-mig).

#[derive(Accounts)]
pub struct Migrate<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
}

pub fn process(_ctx: Context<Migrate>) -> Result<()> {
    msg!("migrate: not yet implemented in stacc-rewrite; tracked as PR-2");
    err!(MigrateError::NotImplemented)
}

#[error_code]
pub enum MigrateError {
    #[msg("Migration is not implemented in this build")]
    NotImplemented,
}
