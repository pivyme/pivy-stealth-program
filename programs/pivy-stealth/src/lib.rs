//! PIVY Stealth Payment Program
//! ============================
//! Privacy-preserving one-way escrow for Solana SPL tokens (incl. WSOL).

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer},
};

declare_id!("ECytFKSRMLkWYPp1jnnCEt8AcdnUeaLfKyfr16J3SgUk");

/// Business-logic errors
#[error_code]
pub enum StealthError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Destination token-account owner mismatch")]
    DestinationOwnerMismatch,
    #[msg("Source and destination token accounts must differ")]
    SameAccount,
}

/// Emitted for every `pay` **or** `announce`
#[event]
pub struct PaymentEvent {
    pub stealth_owner: Pubkey,
    pub payer: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub label: [u8; 32],
    pub eph_pubkey: Pubkey,
    /// `false` → funds moved with `pay`
    /// `true`  → log-only `announce`
    pub announce: bool,
}

/// Emitted after every successful withdrawal
#[event]
pub struct WithdrawEvent {
    pub stealth_owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
}

/* ------------------------------------------------------------------ */
/*                               Pay                                  */
/* ------------------------------------------------------------------ */
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PayArgs {
    pub amount: u64,
    pub label: [u8; 32],
    pub eph_pubkey: Pubkey,
}

#[derive(Accounts)]
pub struct Pay<'info> {
    /// Stealth receiver (fresh every payment) – unchecked by design
    #[account(mut)]
    pub stealth_owner: UncheckedAccount<'info>,

    /// ATA owned by `stealth_owner`; created lazily
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = stealth_owner
    )]
    pub stealth_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// Payer’s funding ATA
    #[account(
        mut,
        constraint = payer_ata.owner == payer.key(),
        constraint = payer_ata.mint == mint.key()
    )]
    pub payer_ata: Box<Account<'info, TokenAccount>>,

    pub mint: Box<Account<'info, Mint>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_pay(ctx: Context<Pay>, args: PayArgs) -> Result<()> {
    require!(args.amount > 0, StealthError::InvalidAmount);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.payer_ata.to_account_info(),
                to: ctx.accounts.stealth_ata.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        args.amount,
    )?;

    emit!(PaymentEvent {
        stealth_owner: ctx.accounts.stealth_owner.key(),
        payer: ctx.accounts.payer.key(),
        mint: ctx.accounts.mint.key(),
        amount: args.amount,
        label: args.label,
        eph_pubkey: args.eph_pubkey,
        announce: false,
    });
    Ok(())
}

/* ------------------------------------------------------------------ */
/*                             Withdraw                               */
/* ------------------------------------------------------------------ */
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct WithdrawArgs {
    /// Pass `u64::MAX` to sweep everything.
    pub amount: u64,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub stealth_owner: Signer<'info>,

    #[account(
        mut,
        constraint = stealth_ata.owner == stealth_owner.key(),
        constraint = stealth_ata.mint  == mint.key(),
    )]
    pub stealth_ata: Box<Account<'info, TokenAccount>>,

    /// Receiver’s own ATA (can be any mint-compatible address)
    #[account(mut)]
    pub destination_ata: Box<Account<'info, TokenAccount>>,

    pub mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, args: WithdrawArgs) -> Result<()> {
    require!(
        ctx.accounts.stealth_ata.key() != ctx.accounts.destination_ata.key(),
        StealthError::SameAccount
    );

    let balance = ctx.accounts.stealth_ata.amount;
    let amount = if args.amount == u64::MAX {
        balance
    } else {
        args.amount
    };
    require!(amount > 0 && amount <= balance, StealthError::InvalidAmount);

    require!(
        ctx.accounts.destination_ata.owner == ctx.accounts.stealth_owner.key(),
        StealthError::DestinationOwnerMismatch
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.stealth_ata.to_account_info(),
                to: ctx.accounts.destination_ata.to_account_info(),
                authority: ctx.accounts.stealth_owner.to_account_info(),
            },
        ),
        amount,
    )?;

    ctx.accounts.stealth_ata.reload()?;
    if ctx.accounts.stealth_ata.amount == 0 {
        token::close_account(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.stealth_ata.to_account_info(),
                destination: ctx.accounts.stealth_owner.to_account_info(),
                authority: ctx.accounts.stealth_owner.to_account_info(),
            },
        ))?;
    }

    emit!(WithdrawEvent {
        stealth_owner: ctx.accounts.stealth_owner.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        destination: ctx.accounts.destination_ata.key(),
    });
    Ok(())
}

/* ------------------------------------------------------------------ */
/*                             Announce                               */
/* ------------------------------------------------------------------ */
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct AnnounceArgs {
    pub amount: u64,
    pub label: [u8; 32],
    pub eph_pubkey: Pubkey,
}

#[derive(Accounts)]
pub struct Announce<'info> {
    /// Stealth receiver (fresh every payment) – unchecked by design
    pub stealth_owner: UncheckedAccount<'info>,

    /// Entity making the announcement (usually the payer)
    pub payer: Signer<'info>,

    /// Mint referenced in the announcement
    pub mint: Box<Account<'info, Mint>>,
}

pub fn handle_announce(ctx: Context<Announce>, args: AnnounceArgs) -> Result<()> {
    require!(args.amount > 0, StealthError::InvalidAmount);

    emit!(PaymentEvent {
        stealth_owner: ctx.accounts.stealth_owner.key(),
        payer: ctx.accounts.payer.key(),
        mint: ctx.accounts.mint.key(),
        amount: args.amount,
        label: args.label,
        eph_pubkey: args.eph_pubkey,
        announce: true,
    });
    Ok(())
}

/* ------------------------------------------------------------------ */
/*                             Entrypoint                             */
/* ------------------------------------------------------------------ */
#[program]
pub mod pivy_stealth {
    use super::*;

    pub fn pay(ctx: Context<Pay>, args: PayArgs) -> Result<()> {
        handle_pay(ctx, args)
    }

    pub fn withdraw(ctx: Context<Withdraw>, args: WithdrawArgs) -> Result<()> {
        handle_withdraw(ctx, args)
    }

    /// Emits a `PaymentEvent` without moving funds.
    pub fn announce(ctx: Context<Announce>, args: AnnounceArgs) -> Result<()> {
        handle_announce(ctx, args)
    }
}
