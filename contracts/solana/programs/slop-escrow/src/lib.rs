use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
declare_id!("4hXeYxsTKbwVKRRn8P1emGNDmVUSx13VMykfUAsbPnnj");
/// Bounds on the binding delay. Below one hour the owner cannot react; above 30 days a
/// binding or a committed award waits too long to be useful. The local end-to-end suite
/// builds with the `short-delay-for-tests` feature so it can wait the delay out in
/// seconds; that build must never be deployed.
const MIN_BINDING_DELAY: i64 = if cfg!(feature = "short-delay-for-tests") {
    1
} else {
    3600
};
const MAX_BINDING_DELAY: i64 = 30 * 86400;
/// An identity authority rotation is public for at least the binding delay floor and at most
/// 90 days; production manifests require at least 7 days.
const MAX_ROTATION_DELAY: i64 = 90 * 86400;
/// Size of a Project account created before the identity authority rotation fields existed.
/// `migrate_project` grows such an account to the current layout.
pub const LEGACY_PROJECT_SIZE: usize = 265;
/// Vetoes a project owner may record for an actor between two payments to that actor in
/// the project. Each veto can only delay the actor by one more binding delay, so this
/// bounds the owner's delay power.
const MAX_VETOES_BETWEEN_PAYMENTS: u8 = 3;
#[program]
pub mod slop_escrow {
    use super::*;
    pub fn initialize(
        ctx: Context<Initialize>,
        project_id: [u8; 32],
        network: [u8; 32],
        identity_authority: Pubkey,
        fee_recipient: Pubkey,
        binding_delay: i64,
        rotation_delay: i64,
    ) -> Result<()> {
        require!(
            identity_authority != Pubkey::default()
                && fee_recipient != Pubkey::default()
                && identity_authority != ctx.accounts.owner.key()
                && identity_authority != fee_recipient
                && fee_recipient != ctx.accounts.owner.key()
                && fee_recipient != ctx.accounts.project.key(),
            EscrowError::InvalidIdentity
        );
        require!(
            valid_delay(binding_delay) && valid_rotation_delay(rotation_delay),
            EscrowError::InvalidDelay
        );
        let p = &mut ctx.accounts.project;
        p.owner = ctx.accounts.owner.key();
        p.project_id = project_id;
        p.network = network;
        p.identity_authority = identity_authority;
        p.fee_recipient = fee_recipient;
        p.mint = ctx.accounts.mint.key();
        p.bump = ctx.bumps.project;
        p.binding_delay = binding_delay;
        p.rotation_delay = rotation_delay;
        Ok(())
    }
    // Grows a Project account created before the rotation fields existed to the current
    // layout. Only the project owner can run it, once, and it sets the rotation delay that
    // `initialize` sets for new projects. Borsh appends the new fields after the old ones, so
    // every existing field keeps its offset; the new bytes start as zero (no pending rotation).
    pub fn migrate_project(ctx: Context<MigrateProject>, rotation_delay: i64) -> Result<()> {
        require!(
            valid_rotation_delay(rotation_delay),
            EscrowError::InvalidDelay
        );
        let info = ctx.accounts.project.to_account_info();
        {
            let data = info.try_borrow_data()?;
            require!(
                data.len() == LEGACY_PROJECT_SIZE && &data[..8] == Project::DISCRIMINATOR,
                EscrowError::NotLegacyProject
            );
            require!(
                data[8..40] == ctx.accounts.owner.key().to_bytes(),
                EscrowError::InvalidIdentity
            );
        }
        let size = 8 + Project::INIT_SPACE;
        let rent = Rent::get()?.minimum_balance(size);
        let lamports = info.lamports();
        if rent > lamports {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.owner.to_account_info(),
                        to: info.clone(),
                    },
                ),
                rent - lamports,
            )?;
        }
        info.resize(size)?;
        let mut data = info.try_borrow_mut_data()?;
        let mut project = Project::try_deserialize(&mut &data[..])?;
        project.rotation_delay = rotation_delay;
        project.try_serialize(&mut &mut data[..])?;
        emit!(ProjectMigrated {
            project: info.key(),
            rotation_delay
        });
        Ok(())
    }
    // The owner starts a public two-party rotation of the identity authority. The current
    // authority has no instruction that can block it.
    pub fn propose_authority_rotation(
        ctx: Context<ProposeAuthorityRotation>,
        next: Pubkey,
    ) -> Result<()> {
        let p = &mut ctx.accounts.project;
        require!(
            next != Pubkey::default()
                && next != p.identity_authority
                && next != p.owner
                && next != p.fee_recipient,
            EscrowError::InvalidIdentity
        );
        require!(
            p.pending_identity_authority == Pubkey::default(),
            EscrowError::RotationPending
        );
        let effective_at = add_i64(Clock::get()?.unix_timestamp, p.rotation_delay)?;
        p.pending_identity_authority = next;
        p.rotation_effective_at = effective_at;
        p.rotation_confirmed = false;
        emit!(AuthorityRotationProposed {
            project: p.key(),
            current: p.identity_authority,
            proposed: next,
            effective_at
        });
        Ok(())
    }
    // The fee recipient is the second fixed party; its confirmation is required before execution.
    pub fn confirm_authority_rotation(ctx: Context<ConfirmAuthorityRotation>) -> Result<()> {
        let p = &mut ctx.accounts.project;
        require!(
            p.pending_identity_authority != Pubkey::default(),
            EscrowError::NoRotationPending
        );
        require!(!p.rotation_confirmed, EscrowError::RotationConfirmed);
        p.rotation_confirmed = true;
        emit!(AuthorityRotationConfirmed {
            project: p.key(),
            proposed: p.pending_identity_authority
        });
        Ok(())
    }
    // The owner withdraws its own proposal; nobody else can.
    pub fn cancel_authority_rotation(ctx: Context<CancelAuthorityRotation>) -> Result<()> {
        let p = &mut ctx.accounts.project;
        let proposed = p.pending_identity_authority;
        require!(proposed != Pubkey::default(), EscrowError::NoRotationPending);
        p.pending_identity_authority = Pubkey::default();
        p.rotation_effective_at = 0;
        p.rotation_confirmed = false;
        emit!(AuthorityRotationCancelled {
            project: p.key(),
            proposed
        });
        Ok(())
    }
    // Anyone executes a confirmed proposal once its delay has passed. Binding PDAs derive from
    // the project and actor, not the authority, so every existing binding stays valid.
    pub fn execute_authority_rotation(ctx: Context<ExecuteAuthorityRotation>) -> Result<()> {
        let p = &mut ctx.accounts.project;
        let next = p.pending_identity_authority;
        require!(next != Pubkey::default(), EscrowError::NoRotationPending);
        require!(p.rotation_confirmed, EscrowError::RotationUnconfirmed);
        require!(
            Clock::get()?.unix_timestamp >= p.rotation_effective_at,
            EscrowError::RotationNotReady
        );
        let previous = p.identity_authority;
        p.identity_authority = next;
        p.pending_identity_authority = Pubkey::default();
        p.rotation_effective_at = 0;
        p.rotation_confirmed = false;
        emit!(AuthorityRotated {
            project: p.key(),
            previous,
            current: next
        });
        Ok(())
    }
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            6,
        )?;
        ctx.accounts.project.deposited = add(ctx.accounts.project.deposited, amount)?;
        Ok(())
    }
    pub fn commit(
        ctx: Context<Commit>,
        award_id: [u8; 32],
        source_digest: [u8; 32],
        actor_id: u64,
        gross: u64,
    ) -> Result<()> {
        require!(gross > 0 && actor_id > 0, EscrowError::InvalidAmount);
        // Binding the project to the ID stops another project from claiming it first.
        require!(
            award_id == award_id_for(&ctx.accounts.project.key(), &source_digest),
            EscrowError::InvalidAward
        );
        let fee = gross / 50;
        let principal = gross - fee;
        let reserve = gross;
        let p = &mut ctx.accounts.project;
        require!(
            ctx.accounts.vault.amount >= add(p.reserved, reserve)? && free(p)? >= reserve,
            EscrowError::InsufficientFreeBalance
        );
        p.reserved = add(p.reserved, reserve)?;
        let a = &mut ctx.accounts.obligation;
        a.project = p.key();
        a.award_id = award_id;
        a.source_digest = source_digest;
        ctx.accounts.origin.obligation = a.key();
        a.actor_id = actor_id;
        a.gross = gross;
        a.principal = principal;
        a.fee = fee;
        a.committed_at = Clock::get()?.unix_timestamp;
        emit!(AwardCommitted {
            project: p.key(),
            award_id,
            source_digest,
            actor_id,
            gross,
            principal,
            fee
        });
        Ok(())
    }
    // The attester and the destination keypair both sign this exact transaction, including
    // deployment, project and predecessor. The destination is a co-signer, so the authority
    // alone cannot bind a wallet it does not hold. `expires_at` limits submission, not claim
    // lifetime. A new binding replaces the latest one for this project; no earlier binding
    // can pay afterwards.
    pub fn bind_wallet(
        ctx: Context<BindWallet>,
        actor_id: u64,
        network: [u8; 32],
        expected_version: u64,
        claim_digest: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        let destination = ctx.accounts.destination.key();
        let project = ctx.accounts.project.key();
        let vault = Pubkey::find_program_address(&[b"vault", project.as_ref()], ctx.program_id).0;
        // A destination owned by the project or vault PDA would strand the principal.
        require!(
            actor_id > 0
                && destination != ctx.accounts.identity_authority.key()
                && destination != project
                && destination != vault
                && claim_digest != [0u8; 32],
            EscrowError::InvalidIdentity
        );
        require!(
            Clock::get()?.unix_timestamp < expires_at,
            EscrowError::BindingExpired
        );
        require!(
            network == ctx.accounts.project.network,
            EscrowError::WrongNetwork
        );
        let b = &mut ctx.accounts.binding;
        require!(b.version == expected_version, EscrowError::StaleBinding);
        b.actor_id = actor_id;
        b.network = network;
        b.authority = ctx.accounts.identity_authority.key();
        b.destination = destination;
        b.claim_digest = claim_digest;
        b.version = add(expected_version, 1)?;
        b.bound_at = Clock::get()?.unix_timestamp;
        emit!(WalletBound {
            actor_id,
            network,
            destination,
            version: b.version,
            bound_at: b.bound_at
        });
        Ok(())
    }
    // The owner stops the latest binding for this project before it pays: while it waits
    // out its own delay, or while an unpaid award to the actor (passed as `obligation`) is
    // still inside its commit delay. A binding that has paid cannot be vetoed, and the
    // owner can veto at most MAX_VETOES_BETWEEN_PAYMENTS times between two payments to the
    // actor. A new authority binding (next version) is required afterwards.
    pub fn veto_binding(ctx: Context<VetoBinding>, actor_id: u64, version: u64) -> Result<()> {
        let p = &ctx.accounts.project;
        let b = &ctx.accounts.binding;
        require!(
            b.version == version && b.actor_id == actor_id && version > 0,
            EscrowError::StaleBinding
        );
        require!(version != b.paid_version, EscrowError::BindingActive);
        let now = Clock::get()?.unix_timestamp;
        let commit_window = match &ctx.accounts.obligation {
            Some(a) => now < add_i64(a.committed_at, p.binding_delay)?,
            None => false,
        };
        require!(
            now < activates_at(b, p)? || commit_window,
            EscrowError::BindingActive
        );
        require!(
            b.veto_count < MAX_VETOES_BETWEEN_PAYMENTS,
            EscrowError::VetoLimit
        );
        ctx.accounts.binding.veto_count += 1;
        emit!(BindingVetoed {
            project: ctx.accounts.project.key(),
            actor_id,
            version
        });
        Ok(())
    }
    // Pays an award once its commit delay has passed, only to this project's latest
    // binding, once that binding's delay has passed and the owner has not vetoed it. While
    // a newer binding waits or after its veto, no earlier binding pays.
    pub fn pay(ctx: Context<Pay>, expected_version: u64) -> Result<()> {
        let p = &ctx.accounts.project;
        let a = &ctx.accounts.obligation;
        let b = &ctx.accounts.binding;
        require!(!a.paid, EscrowError::AlreadyPaid);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= add_i64(a.committed_at, p.binding_delay)?,
            EscrowError::AwardPending
        );
        require!(b.version > 0, EscrowError::StaleBinding);
        require!(now >= activates_at(b, p)?, EscrowError::BindingPending);
        // A veto address can only be created by veto_binding; an empty system account
        // proves the owner did not veto that binding version.
        require!(unvetoed(&ctx.accounts.veto), EscrowError::BindingVetoed);
        require!(b.version == expected_version, EscrowError::StaleBinding);
        let (destination, version) = (b.destination, b.version);
        require!(
            ctx.accounts.destination.owner == destination
                && ctx.accounts.destination.key()
                    == get_associated_token_address(&destination, &ctx.accounts.mint.key()),
            EscrowError::WrongDestination
        );
        let seeds: &[&[u8]] = &[b"project", p.owner.as_ref(), &p.project_id, &[p.bump]];
        send(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.destination,
            &ctx.accounts.mint,
            p,
            seeds,
            a.principal,
        )?;
        send(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.fee_account,
            &ctx.accounts.mint,
            p,
            seeds,
            a.fee,
        )?;
        let principal = a.principal;
        let fee = a.fee;
        let p = &mut ctx.accounts.project;
        p.reserved = p
            .reserved
            .checked_sub(add(principal, fee)?)
            .ok_or(EscrowError::Arithmetic)?;
        p.paid = add(p.paid, principal)?;
        p.payout_fees = add(p.payout_fees, fee)?;
        ctx.accounts.obligation.paid = true;
        let b = &mut ctx.accounts.binding;
        b.paid_version = version;
        b.veto_count = 0;
        emit!(AwardPaid {
            project: p.key(),
            award_id: ctx.accounts.obligation.award_id,
            gross: ctx.accounts.obligation.gross,
            principal,
            fee,
            destination,
            wallet_version: version
        });
        Ok(())
    }
    pub fn withdraw(ctx: Context<Withdraw>, gross: u64) -> Result<()> {
        let p = &ctx.accounts.project;
        require!(
            gross > 0 && ctx.accounts.vault.amount >= add(p.reserved, gross)? && free(p)? >= gross,
            EscrowError::InsufficientFreeBalance
        );
        let cumulative = add(p.withdrawn_gross, gross)?;
        let fee = (cumulative / 10)
            .checked_sub(p.withdrawal_fees)
            .ok_or(EscrowError::Arithmetic)?;
        let returned = gross.checked_sub(fee).ok_or(EscrowError::Arithmetic)?;
        let seeds: &[&[u8]] = &[b"project", p.owner.as_ref(), &p.project_id, &[p.bump]];
        send(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.destination,
            &ctx.accounts.mint,
            p,
            seeds,
            returned,
        )?;
        send(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.fee_account,
            &ctx.accounts.mint,
            p,
            seeds,
            fee,
        )?;
        let p = &mut ctx.accounts.project;
        p.withdrawn_gross = cumulative;
        p.withdrawal_fees = add(p.withdrawal_fees, fee)?;
        emit!(UnusedWithdrawn {
            project: p.key(),
            gross,
            fee,
            returned
        });
        Ok(())
    }
    // PAY-10: the owner pays one Slopbot invoice from free sponsor funds. The
    // `service` PDA makes each invoice digest chargeable exactly once.
    pub fn charge_service(
        ctx: Context<ChargeService>,
        amount: u64,
        invoice_digest: [u8; 32],
    ) -> Result<()> {
        require!(
            amount > 0 && invoice_digest != [0u8; 32],
            EscrowError::InvalidAmount
        );
        let p = &ctx.accounts.project;
        require!(
            ctx.accounts.vault.amount >= add(p.reserved, amount)? && free(p)? >= amount,
            EscrowError::InsufficientFreeBalance
        );
        let seeds: &[&[u8]] = &[b"project", p.owner.as_ref(), &p.project_id, &[p.bump]];
        send(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.fee_account,
            &ctx.accounts.mint,
            p,
            seeds,
            amount,
        )?;
        let p = &mut ctx.accounts.project;
        p.service_fees = add(p.service_fees, amount)?;
        let c = &mut ctx.accounts.charge;
        c.project = p.key();
        c.invoice_digest = invoice_digest;
        c.amount = amount;
        emit!(ServiceCharged {
            project: p.key(),
            invoice_digest,
            amount
        });
        Ok(())
    }
}
/// The only valid award ID for a source in this project.
pub fn award_id_for(project: &Pubkey, source_digest: &[u8; 32]) -> [u8; 32] {
    hashv(&[b"slop-escrow-award", project.as_ref(), source_digest]).to_bytes()
}
fn valid_delay(binding_delay: i64) -> bool {
    (MIN_BINDING_DELAY..=MAX_BINDING_DELAY).contains(&binding_delay)
}
fn valid_rotation_delay(rotation_delay: i64) -> bool {
    (MIN_BINDING_DELAY..=MAX_ROTATION_DELAY).contains(&rotation_delay)
}
fn activates_at(b: &WalletBinding, p: &Project) -> Result<i64> {
    add_i64(b.bound_at, p.binding_delay)
}
fn add_i64(a: i64, b: i64) -> Result<i64> {
    a.checked_add(b).ok_or(error!(EscrowError::Arithmetic))
}
fn unvetoed(veto: &UncheckedAccount) -> bool {
    veto.data_is_empty() && veto.owner == &anchor_lang::system_program::ID
}
// Unsolicited token transfers do not acquire sponsor refund or award rights.
fn free(p: &Project) -> Result<u64> {
    p.deposited
        .checked_sub(p.paid)
        .and_then(|n| n.checked_sub(p.payout_fees))
        .and_then(|n| n.checked_sub(p.withdrawn_gross))
        .and_then(|n| n.checked_sub(p.service_fees))
        .and_then(|n| n.checked_sub(p.reserved))
        .ok_or(error!(EscrowError::Arithmetic))
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(error!(EscrowError::Arithmetic))
}
fn send<'info>(
    program: &Program<'info, Token>,
    source: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    project: &Account<'info, Project>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    // A zero fee or refund leg is skipped, so a frozen fee account cannot stall a
    // zero-fee payout and a zero-return withdrawal needs no transfer.
    if amount == 0 {
        return Ok(());
    }
    token::transfer_checked(
        CpiContext::new_with_signer(
            program.to_account_info(),
            TransferChecked {
                from: source.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: project.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        6,
    )
}
#[derive(Accounts)]
#[instruction(project_id:[u8;32])]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init,payer=owner,space=8+Project::INIT_SPACE,seeds=[b"project",owner.key().as_ref(),&project_id],bump)]
    pub project: Box<Account<'info, Project>>,
    #[account(constraint=mint.decimals==6 @ EscrowError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(init,payer=owner,seeds=[b"vault",project.key().as_ref()],bump,token::mint=mint,token::authority=project)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(mut,has_one=owner,has_one=mint)]
    pub project: Box<Account<'info, Project>>,
    pub mint: Account<'info, Mint>,
    #[account(mut,token::mint=mint,token::authority=owner)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut,seeds=[b"vault",project.key().as_ref()],bump,token::mint=mint,token::authority=project)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
#[instruction(award_id:[u8;32], source_digest:[u8;32])]
pub struct Commit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut,has_one=owner)]
    pub project: Box<Account<'info, Project>>,
    #[account(seeds=[b"vault",project.key().as_ref()],bump,constraint=vault.mint==project.mint,token::authority=project)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init,payer=owner,space=8+Origin::INIT_SPACE,seeds=[b"origin",project.key().as_ref(),&source_digest],bump)]
    pub origin: Account<'info, Origin>,
    #[account(init,payer=owner,space=8+Obligation::INIT_SPACE,seeds=[b"award",project.key().as_ref(),&award_id],bump)]
    pub obligation: Box<Account<'info, Obligation>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(actor_id:u64,network:[u8;32])]
pub struct BindWallet<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub identity_authority: Signer<'info>,
    /// The wallet being bound; its signature is the contributor's acceptance of this exact binding.
    pub destination: Signer<'info>,
    #[account(has_one=identity_authority)]
    pub project: Box<Account<'info, Project>>,
    #[account(init_if_needed,payer=payer,space=8+WalletBinding::INIT_SPACE,seeds=[b"wallet",project.key().as_ref(),&actor_id.to_le_bytes()],bump)]
    pub binding: Box<Account<'info, WalletBinding>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(actor_id:u64,version:u64)]
pub struct VetoBinding<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one=owner)]
    pub project: Box<Account<'info, Project>>,
    #[account(mut,seeds=[b"wallet",project.key().as_ref(),&actor_id.to_le_bytes()],bump)]
    pub binding: Box<Account<'info, WalletBinding>>,
    #[account(init,payer=owner,space=8+BindingVeto::INIT_SPACE,seeds=[b"veto",project.key().as_ref(),&actor_id.to_le_bytes(),&version.to_le_bytes()],bump)]
    pub veto: Account<'info, BindingVeto>,
    /// An unpaid award to this actor in this project whose commit delay has not passed;
    /// it extends the veto window to that award's commit delay.
    #[account(constraint=obligation.project==project.key() @ EscrowError::InvalidAward,constraint=obligation.actor_id==actor_id @ EscrowError::InvalidAward,constraint=!obligation.paid @ EscrowError::AlreadyPaid)]
    pub obligation: Option<Box<Account<'info, Obligation>>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(mut,has_one=mint)]
    pub project: Box<Account<'info, Project>>,
    #[account(mut,has_one=project,seeds=[b"award",project.key().as_ref(),&obligation.award_id],bump)]
    pub obligation: Box<Account<'info, Obligation>>,
    #[account(mut,seeds=[b"wallet",project.key().as_ref(),&obligation.actor_id.to_le_bytes()],bump,constraint=binding.actor_id==obligation.actor_id,constraint=binding.network==project.network)]
    pub binding: Box<Account<'info, WalletBinding>>,
    pub mint: Account<'info, Mint>,
    #[account(mut,seeds=[b"vault",project.key().as_ref()],bump,token::mint=mint,token::authority=project)]
    pub vault: Account<'info, TokenAccount>,
    /// The handler requires this to be the associated token account of whichever binding pays.
    #[account(mut,token::mint=mint,constraint=destination.key()!=vault.key())]
    pub destination: Account<'info, TokenAccount>,
    #[account(mut,token::mint=mint,constraint=fee_account.owner==project.fee_recipient,constraint=fee_account.key()!=vault.key())]
    pub fee_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: must be the empty veto address for this project, actor and latest binding version.
    #[account(seeds=[b"veto",project.key().as_ref(),&obligation.actor_id.to_le_bytes(),&binding.version.to_le_bytes()],bump)]
    pub veto: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct MigrateProject<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: a legacy-size Project account owned by this program; the handler checks its size,
    /// discriminator and stored owner before it grows the account.
    #[account(mut,owner=crate::ID @ EscrowError::NotLegacyProject)]
    pub project: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ProposeAuthorityRotation<'info> {
    pub owner: Signer<'info>,
    #[account(mut,has_one=owner)]
    pub project: Box<Account<'info, Project>>,
}
#[derive(Accounts)]
pub struct ConfirmAuthorityRotation<'info> {
    pub fee_recipient: Signer<'info>,
    #[account(mut,has_one=fee_recipient)]
    pub project: Box<Account<'info, Project>>,
}
#[derive(Accounts)]
pub struct CancelAuthorityRotation<'info> {
    pub owner: Signer<'info>,
    #[account(mut,has_one=owner)]
    pub project: Box<Account<'info, Project>>,
}
#[derive(Accounts)]
pub struct ExecuteAuthorityRotation<'info> {
    #[account(mut)]
    pub project: Box<Account<'info, Project>>,
}
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut,has_one=owner,has_one=mint)]
    pub project: Box<Account<'info, Project>>,
    pub mint: Account<'info, Mint>,
    #[account(mut,seeds=[b"vault",project.key().as_ref()],bump,token::mint=mint,token::authority=project)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut,token::mint=mint,token::authority=owner,constraint=destination.key()!=vault.key())]
    pub destination: Account<'info, TokenAccount>,
    #[account(mut,token::mint=mint,constraint=fee_account.owner==project.fee_recipient,constraint=fee_account.key()!=vault.key())]
    pub fee_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[derive(Accounts)]
#[instruction(amount:u64, invoice_digest:[u8;32])]
pub struct ChargeService<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut,has_one=owner,has_one=mint)]
    pub project: Box<Account<'info, Project>>,
    pub mint: Account<'info, Mint>,
    #[account(mut,seeds=[b"vault",project.key().as_ref()],bump,token::mint=mint,token::authority=project)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut,token::mint=mint,constraint=fee_account.owner==project.fee_recipient,constraint=fee_account.key()!=vault.key())]
    pub fee_account: Account<'info, TokenAccount>,
    #[account(init,payer=owner,space=8+ServiceCharge::INIT_SPACE,seeds=[b"service",project.key().as_ref(),&invoice_digest],bump)]
    pub charge: Account<'info, ServiceCharge>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[account]
#[derive(InitSpace)]
pub struct Project {
    pub owner: Pubkey,
    pub project_id: [u8; 32],
    pub network: [u8; 32],
    pub identity_authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub mint: Pubkey,
    pub reserved: u64,
    pub deposited: u64,
    pub paid: u64,
    pub payout_fees: u64,
    pub withdrawn_gross: u64,
    pub withdrawal_fees: u64,
    pub bump: u8,
    pub binding_delay: i64,
    pub service_fees: u64,
    /// Fields after this point were added with the authority rotation; `migrate_project` grows
    /// accounts created without them.
    pub pending_identity_authority: Pubkey,
    pub rotation_effective_at: i64,
    pub rotation_confirmed: bool,
    pub rotation_delay: i64,
}
#[account]
#[derive(InitSpace)]
pub struct ServiceCharge {
    pub project: Pubkey,
    pub invoice_digest: [u8; 32],
    pub amount: u64,
}
#[account]
#[derive(InitSpace)]
pub struct Obligation {
    pub gross: u64,
    pub source_digest: [u8; 32],
    pub project: Pubkey,
    pub award_id: [u8; 32],
    pub actor_id: u64,
    pub principal: u64,
    pub fee: u64,
    pub paid: bool,
    pub committed_at: i64,
}
/// One binding per project and actor, so each project's delay, vetoes and payments are
/// its own. The first seven fields are the latest binding, the only one that can pay.
#[account]
#[derive(InitSpace)]
pub struct WalletBinding {
    pub claim_digest: [u8; 32],
    pub authority: Pubkey,
    pub actor_id: u64,
    pub network: [u8; 32],
    pub destination: Pubkey,
    pub version: u64,
    pub bound_at: i64,
    /// The version the last payment in this project used; 0 before the first payment.
    pub paid_version: u64,
    /// Vetoes recorded since the last payment in this project.
    pub veto_count: u8,
}
#[account]
#[derive(InitSpace)]
pub struct BindingVeto {}
#[event]
pub struct ProjectMigrated {
    pub project: Pubkey,
    pub rotation_delay: i64,
}
#[event]
pub struct AuthorityRotationProposed {
    pub project: Pubkey,
    pub current: Pubkey,
    pub proposed: Pubkey,
    pub effective_at: i64,
}
#[event]
pub struct AuthorityRotationConfirmed {
    pub project: Pubkey,
    pub proposed: Pubkey,
}
#[event]
pub struct AuthorityRotationCancelled {
    pub project: Pubkey,
    pub proposed: Pubkey,
}
#[event]
pub struct AuthorityRotated {
    pub project: Pubkey,
    pub previous: Pubkey,
    pub current: Pubkey,
}
#[event]
pub struct BindingVetoed {
    pub project: Pubkey,
    pub actor_id: u64,
    pub version: u64,
}
#[event]
pub struct AwardCommitted {
    pub gross: u64,
    pub source_digest: [u8; 32],
    pub project: Pubkey,
    pub award_id: [u8; 32],
    pub actor_id: u64,
    pub principal: u64,
    pub fee: u64,
}
#[event]
pub struct WalletBound {
    pub actor_id: u64,
    pub network: [u8; 32],
    pub destination: Pubkey,
    pub version: u64,
    pub bound_at: i64,
}
#[event]
pub struct AwardPaid {
    pub gross: u64,
    pub project: Pubkey,
    pub award_id: [u8; 32],
    pub principal: u64,
    pub fee: u64,
    pub destination: Pubkey,
    pub wallet_version: u64,
}
#[event]
pub struct ServiceCharged {
    pub project: Pubkey,
    pub invoice_digest: [u8; 32],
    pub amount: u64,
}
#[event]
pub struct UnusedWithdrawn {
    pub project: Pubkey,
    pub gross: u64,
    pub fee: u64,
    pub returned: u64,
}
#[error_code]
pub enum EscrowError {
    #[msg("Invalid actor or destination")]
    InvalidIdentity,
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("Arithmetic overflow")]
    Arithmetic,
    #[msg("Withdrawal or award would consume reserved funds")]
    InsufficientFreeBalance,
    #[msg("Obligation already paid")]
    AlreadyPaid,
    #[msg("Wallet predecessor version is stale")]
    StaleBinding,
    #[msg("Network domain does not match project")]
    WrongNetwork,
    #[msg("Only six decimal classic SPL tokens are supported")]
    WrongMint,
    #[msg("Award ID is not bound to this project and source")]
    InvalidAward,
    #[msg("Wallet binding is still in its activation delay")]
    BindingPending,
    #[msg("Project owner vetoed this wallet binding")]
    BindingVetoed,
    #[msg("Wallet binding has paid or its veto window has closed")]
    BindingActive,
    #[msg("Destination must be the bound wallet's associated token account")]
    WrongDestination,
    #[msg("Award is still inside its commit delay")]
    AwardPending,
    #[msg("Owner veto limit reached since the actor's last payment")]
    VetoLimit,
    #[msg("Binding delay must be 1 hour to 30 days; rotation delay 1 hour to 90 days")]
    InvalidDelay,
    #[msg("Binding submission expired")]
    BindingExpired,
    #[msg("An identity authority rotation is already proposed")]
    RotationPending,
    #[msg("No identity authority rotation is proposed")]
    NoRotationPending,
    #[msg("The fee recipient already confirmed this rotation")]
    RotationConfirmed,
    #[msg("The fee recipient has not confirmed this rotation")]
    RotationUnconfirmed,
    #[msg("The rotation delay has not passed")]
    RotationNotReady,
    #[msg("Account is not a legacy-size project of this program")]
    NotLegacyProject,
}

#[account]
#[derive(InitSpace)]
pub struct Origin {
    pub obligation: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::*;
    // The deployable build (no `short-delay-for-tests`) must keep the one-hour floor.
    #[cfg(not(feature = "short-delay-for-tests"))]
    #[test]
    fn production_delay_bounds() {
        assert!(!valid_delay(0));
        assert!(!valid_delay(3599));
        assert!(valid_delay(3600));
        assert!(valid_delay(30 * 86400));
        assert!(!valid_delay(30 * 86400 + 1));
        assert!(!valid_rotation_delay(3599));
        assert!(valid_rotation_delay(3600));
        assert!(valid_rotation_delay(90 * 86400));
        assert!(!valid_rotation_delay(90 * 86400 + 1));
    }
}
