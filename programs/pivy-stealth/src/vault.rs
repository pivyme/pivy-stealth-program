use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GYVFfTi9v1cfhZvXg92LPhs65uWcRH8enWbKpSnrKNx3");

/// 4% APY as rational
const RATE_NUM: u64 = 4;
const RATE_DEN: u64 = 100;
const SECS_PER_YEAR: u64 = 31_536_000;
const DECIMALS_SHIFT: u128 = 1_000_000_000_000; // Scale 6 decimals to 18

fn accrued(amount: u128, start: i64, now: i64) -> u128 {
    let dt = (now - start).max(0) as u128;
    let yield_part = amount.saturating_mul(RATE_NUM as u128).saturating_mul(dt)
        / (RATE_DEN as u128 * SECS_PER_YEAR as u128);
    amount + yield_part
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub amount: u128, // principal in 18 decimals
    pub last_ts: i64,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(init_if_needed,
              payer = owner,
              space = 8 + 32 + 16 + 8,
              seeds = [b"vpos", owner.key().as_ref(), mint.key().as_ref()],
              bump)]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, constraint = src.owner == owner.key(), constraint = src.mint == mint.key())]
    pub src: Account<'info, TokenAccount>,

    #[account(mut, constraint = vault.mint == mint.key(), constraint = vault.owner == program_authority.key())]
    pub vault: Account<'info, TokenAccount>,

    #[account(seeds = [b"auth"], bump)]
    pub program_authority: SystemAccount<'info>,

    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, has_one = owner)]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, constraint = dst.owner == owner.key(), constraint = dst.mint == mint.key())]
    pub dst: Account<'info, TokenAccount>,

    #[account(mut, constraint = vault.mint == mint.key(), constraint = vault.owner == program_authority.key())]
    pub vault: Account<'info, TokenAccount>,

    #[account(seeds = [b"auth"], bump)]
    pub program_authority: SystemAccount<'info>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[program]
pub mod usd_star_yield {
    use super::*;

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let clock = Clock::get()?;
        let pos = &mut ctx.accounts.position;

        // transfer tokens into the vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.src.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        let cur = accrued(pos.amount, pos.last_ts, clock.unix_timestamp);
        let deposited_scaled = (amount as u128) * DECIMALS_SHIFT;
        pos.amount = cur + deposited_scaled;
        pos.last_ts = clock.unix_timestamp;
        pos.owner = ctx.accounts.owner.key();

        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let clock = Clock::get()?;
        let pos = &mut ctx.accounts.position;

        let bump = ctx.bumps.program_authority;
        let seeds: &[&[&[u8]]] = &[&[b"auth", &[bump]]];

        let total = accrued(pos.amount, pos.last_ts, clock.unix_timestamp);
        require!(total > 0, ErrorCode::InvalidAmount);
        let transfer_amount = (total / 10u128.pow(12)) as u64; // downscale from 18-decimals to 6

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.dst.to_account_info(),
                    authority: ctx.accounts.program_authority.to_account_info(),
                },
                seeds,
            ),
            transfer_amount,
        )?;

        pos.amount = 0;
        pos.last_ts = clock.unix_timestamp;
        Ok(())
    }

    pub fn get_balance(ctx: Context<Withdraw>) -> Result<u128> {
        let clock = Clock::get()?;
        let pos = &ctx.accounts.position;
        let bal = accrued(pos.amount, pos.last_ts, clock.unix_timestamp);
        msg!("balance: {}", bal);
        Ok(bal)
    }

    /// ⚠️ Dev-only: manually patch position state
    pub fn admin_patch_timestamp(ctx: Context<AdminPatch>, new_ts: i64) -> Result<()> {
        ctx.accounts.position.last_ts = new_ts;
        msg!("Patched last_ts = {}", new_ts);
        Ok(())
    }

    #[derive(Accounts)]
    pub struct AdminPatch<'info> {
        #[account(mut, has_one = owner)]
        pub position: Account<'info, Position>,
        pub owner: Signer<'info>,
    }

}

#[error_code]
pub enum ErrorCode {
    #[msg("amount must be > 0")]
    InvalidAmount,
}
