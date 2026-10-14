# Reviewer: opus / Solana

Scope: `contracts/solana/programs/slop-escrow/src/lib.rs` at bbcc87b (Anchor 0.32.1, anchor-syn 0.32.2, spl-token 8.0.0 per Cargo.lock). `cargo check --locked -p slop-escrow` builds clean (2 cfg warnings from the entrypoint macro). No PoC was run on a validator; every claim below is reasoning against the code plus the locked Anchor and SPL Token sources in `~/.cargo/registry`.

## Findings

### F-1: Owner can block a committed award forever by vetoing every new binding version
- Severity: Medium (the lead may rate it High under "owner permanently blocking a committed award")  Confidence: high
- Location: lib.rs:132-148 (`veto_binding`), lib.rs:388-400 (`VetoBinding`), lib.rs:161-167 (veto check in `pay`)
- Description: `veto_binding` has no limit on how many times it can be used, no per-destination memory, and no escalation. Any binding version that is still pending (`now < bound_at + binding_delay`) can be vetoed for the cost of one 8-byte PDA's rent. `pay` refuses a vetoed version, and the only way forward is a new authority binding (version+1), which starts a new pending window that the owner can veto again. Nothing on chain ends this loop. The award stays in `reserved` forever and the owner cannot withdraw it either (`free()` excludes `reserved`, lib.rs:299-307), so the owner gains nothing. But it does give the owner a permanent veto over a contributor's approved award, which goes past the README line 31 ("can delay a contributor's payout but never take an approved award back") and the brief's "delay via cancel during the binding window" power. The owner can also hold this over the contributor as leverage.
- Scenario: (1) Owner commits award G to actor X (lib.rs:53-94). (2) Authority binds X at version 1. (3) Owner calls `veto_binding(X, 1)` before `bound_at + delay`. (4) The executor sees the veto (workers/payment-executor/solana.ts:532 "identity review required"), and after review the authority binds version 2 to the same wallet. (5) Owner vetoes version 2. Repeat. `pay` fails with `BindingVetoed` or `BindingPending` forever.
- Evidence: reasoning only. `veto_binding` checks only `b.version == version && version > 0` and the pending window (lib.rs:134-141). The veto PDA is keyed by version (lib.rs:397), so each new version gets a fresh, vetoable slot.
- Recommendation: Decide the policy explicitly, then encode it. Options: (a) a re-assertion rule, so a binding to a destination the owner already vetoed for this actor once cannot be vetoed again by this project (key the veto on destination and count vetoes per (project, actor)); (b) cap vetoes per (project, actor), for example 1 or 2, after which a binding cannot be vetoed; (c) each veto must carry a reason digest and the off-chain review records it, with a documented maximum. Each option trades owner protection against a stolen authority key for contributor protection against the owner. Whatever is chosen, document the worst-case unbounded-delay power in the README. The EVM `cancelBinding` (ProjectEscrow.sol:178-185) has the same property.

### F-2: `initialize` is permissionless and takes every security parameter from the owner, with no bounds on chain
- Severity: Low (Medium if the manifest review does not pin `identityAuthority` and `feeRecipient` to Slop-run keys; see Open questions)  Confidence: high
- Location: lib.rs:9-34, lib.rs:335-348, lib.rs:293-297
- Description: Anyone can create a project and pick `identity_authority`, `fee_recipient`, `binding_delay`, `network` and any classic 6-decimal mint. The only checks are non-default keys, `identity_authority != owner` and `binding_delay >= 0` (lib.rs:17-23). Consequences on chain:
  (a) The owner can name a second key it controls as `identity_authority`. The `!= owner` check is cosmetic. After committing awards (which shows on chain as an approved reservation), the owner binds each actor to its own wallet, never vetoes, and pays itself after the delay. That takes back committed awards at the 2% fee.
  (b) `binding_delay` has no upper bound. With `i64::MAX`, `activates_at` overflows and returns `Arithmetic` (lib.rs:294-296), so both `pay` and `veto_binding` fail forever. With a merely huge value (the manifest schema allows up to 10 digits, about 317 years; src/lib/escrow-policy.mjs:119-123) awards are never payable. Either way reserved funds are locked for good.
  (c) `binding_delay = 0` makes `veto_binding` impossible (`now < bound_at` never holds), so there is no veto window against a stolen authority key.
  (d) `fee_recipient` may equal the project PDA. Fees would then go to a non-vault token account owned by the project PDA, which no instruction can move.
  (e) The mint can be one whose freeze authority is the owner, so the owner can freeze contributor ATAs or the vault.
  The adapter pins the exact reviewed values (adapter.ts:131-206) and the executor refuses to bind unless it is the project's authority (workers/payment-executor/solana.ts:463). So Slop-run flows are protected only to the extent that the manifest review is.
- Scenario: Owner calls `initialize(project_id, network, identity_authority = K2 (owner-held), fee_recipient = Slop, binding_delay = 172800)`, deposits, commits awards to contributors, then calls `bind_wallet` with K2 for each actor pointing to its own wallet, waits 48h, and calls `pay`.
- Evidence: reasoning only. The EVM factory pins token, fee recipient, identity authority and delay at factory construction and gates `create` to the registrar (ProjectEscrow.sol:272-295). Solana has no equivalent.
- Recommendation: Pin protocol parameters on chain. Use program constants or a one-time global config PDA written before the upgrade authority is revoked, holding the authority, fee recipient, mint, the minimum and maximum delay, and the network. Alternatively require the identity authority (or a registrar) to co-sign `initialize`. At minimum add `binding_delay <= MAX_DELAY` and `fee_recipient != project.key()` on chain, and have the manifest schema require `identityAuthority` and `feeRecipient` to equal Slop's published keys for each network.

### F-3: Fee is pushed inside `pay`, so every payout depends on a fee-recipient token account the caller picks
- Severity: Low  Confidence: medium
- Location: lib.rs:178-186, lib.rs:414-415 (also `withdraw` lib.rs:229-237, 431 and `charge_service` lib.rs:266-274, 445)
- Description: `fee_account` only has to be a classic token account for the mint, owned by `fee_recipient`, and not the vault. It is not required to be the ATA. Two effects:
  (1) Liveness coupling. If the fee recipient's ATA is frozen (for example by a USDC freeze), every `pay` the executor builds fails. The executor always uses `ata(mint, feeOwner)` (workers/payment-executor/solana.ts:548). This covers every project sharing that fee recipient, and it includes zero-fee awards, because SPL Token checks `is_frozen` on the destination before it looks at the amount (spl-token-8.0.0 processor.rs:248-250). A permissionless payer can work around it by creating a fresh token account owned by `fee_recipient` (classic Token has no default-frozen state), so this is a liveness issue, not a permanent lock.
  (2) Routing. Any payer can send fees to a token account the fee recipient never created, since `InitializeAccount3` accepts any owner. The funds stay under the fee recipient's control, and the adapter accepts this (it checks only the owner, adapter.ts:432-433). But a fee recipient that is a program PDA handling only its ATA could strand those fees.
- Scenario: The fee recipient's USDC ATA is frozen. Every executor-built `pay` for every project reverts with `AccountFrozen` until the executor is changed to create and use a non-ATA fee account.
- Evidence: reasoning only. The e2e suite freezes only the destination (integration/escrow.e2e.mjs:303-304).
- Recommendation: Require `fee_account` to be `get_associated_token_address(fee_recipient, mint)`, matching the destination rule, and either accrue fees in the project, with a separate permissionless `claim_fees` like EVM, or accept and document the coupling. Accruing restores the EVM property that a broken fee recipient blocks only fee claims.

### F-4: Shared bindings: one rotation or recovery resets the activation clock and reopens veto windows in every project
- Severity: Informational  Confidence: high
- Location: lib.rs:384 (binding seeds have no project), lib.rs:112-120, lib.rs:153-160
- Description: The README documents the sharing, and a veto is correctly scoped to one project (veto seeds include `project.key()`, lib.rs:397 and 418). Consequences it does not spell out:
  (a) Any rebind for actor X, including the one needed to recover from a veto in project A, sets a new `bound_at`. Payments for X in every other project of that authority and network then pause for that project's delay (`StaleBinding` for in-flight transactions, then `BindingPending`), and every other owner gets a fresh veto window.
  (b) A compromised authority can halt all payouts for an actor in every project by rebinding to the same destination more often than the delay. This is weaker than the documented redirect power, but on EVM it takes one transaction per vault.
  (c) Owner A cannot touch the shared binding itself: `bind_wallet` needs the authority signature, and the veto PDA is per project. So no direct cross-project griefing was found.
- Scenario: Owner A vetoes X's version 5. The authority binds version 6. Project B's pending `pay(5)` fails `StaleBinding`, and X waits another 48h in B, with B's owner able to veto 6.
- Evidence: reasoning only.
- Recommendation: Document (a) and (b) in the README. If isolation matters, add the project to the binding seeds (this changes the authority workload to one bind per project, like EVM).

### F-5: Contributor can make its own binding unpayable by reassigning its ATA owner (fails closed)
- Severity: Informational  Confidence: high
- Location: lib.rs:412
- Description: Classic SPL Token allows `SetAuthority(AccountOwner)` on an ATA (spl-token-8.0.0 processor.rs:441-452; immutable owner is only a log message, processor.rs:799-806). After that, `destination.owner == binding.destination` fails, and the ATA address cannot be recreated while the account exists. `pay` fails until the authority rebinds to a new wallet, which means a new delay. The redundant owner check is what stops funds from reaching the new owner, so this is safe, just a liveness trap for a careless or compromised wallet.
- Evidence: reasoning only.
- Recommendation: None needed on chain. The executor should surface the constraint error as "rebind required".

### F-6: Events are not complete enough for log-based reconciliation
- Severity: Informational  Confidence: high
- Location: lib.rs:35-52 (deposit: no event), lib.rs:9-34 (initialize: no event), lib.rs:197-205 (`AwardPaid` lacks `actor_id` and the fee token account; `destination` is the wallet, not the ATA), lib.rs:121-127 (`WalletBound` lacks `authority` and `claim_digest`; EVM emits `claimDigest`), lib.rs:241-246 (`UnusedWithdrawn` lacks the destination token account)
- Description: The adapter deliberately parses instructions and inner `transferChecked`, not logs (README lines 106-118), so there is no current impact. Any indexer that relies on events would under-report deposits and withdraw destinations.
- Recommendation: Add `Deposited` and `ProjectInitialized` events and the missing fields, or document that events are non-authoritative.

### F-7: Missing input sanity checks the EVM version has
- Severity: Informational  Confidence: high
- Location: lib.rs:96-111, lib.rs:53-65
- Description: Solana accepts `claim_digest == 0` (EVM rejects, ProjectEscrow.sol:167) and `source_digest == 0` (EVM rejects, :142). It has no `expiresAt` on `bind_wallet` (EVM :164-167): a signed bind is limited only by blockhash expiry, or not at all if a durable nonce is used. The executor uses recent blockhashes (solana.ts:395-438). And `binding.destination` may be the project PDA, which would strand principal in a non-vault ATA owned by the PDA (authority-only, since EVM blocks `destination == address(this)`).
- Recommendation: Add the zero checks, `destination != project.key()`, and an optional `expires_at` argument checked against `Clock`.

### F-8: Award ID and PDAs carry no cluster domain
- Severity: Informational  Confidence: medium
- Location: lib.rs:290-292
- Description: `award_id = sha256("slop-escrow-award" || project PDA || source_digest)`. The project PDA depends only on program ID, owner and project_id. If the same program keypair is deployed on devnet and testnet (deploy-testnet.sh allows either with one keypair), identical owner and project_id give identical project PDAs and award IDs on both clusters. On-chain replay is impossible (blockhashes are cluster-specific), but an off-chain store keyed on award ID alone could conflate them. EVM includes `block.chainid`.
- Recommendation: Key off-chain records on (genesis hash, program ID, award ID), or include `network` in the award ID preimage.

## Checked and found sound
- Pre-creation and pre-funding griefing of every `init` PDA (project, vault, origin, award, veto, service, binding). Attackers cannot sign for these PDAs, so `create_account`, `allocate` and `assign` are out of reach. Sending lamports to the address is handled by Anchor's existing-lamports branch (anchor-syn-0.32.2 constraints.rs:1638-1670: top-up, allocate and assign with PDA seeds). `initialize` seeds include the signing owner (lib.rs:340).
- Veto UncheckedAccount in `pay` (lib.rs:163-166, 418). The address is seed-checked. Only this program can sign for it, and the only signed creation path is `veto_binding`'s `init`. Lamport transfers leave it system-owned with empty data, so `pay` still passes. A created veto is program-owned, 8 bytes (non-empty), and has no close path, so a vetoed version can never pay.
- Veto for a future or nonexistent version is impossible: `b.version == version && version > 0`, and the binding must exist as `Account<WalletBinding>` (lib.rs:134-137, 395-396). An active binding cannot be vetoed (lib.rs:138-141). The veto and pay boundaries are exact complements (`<` vs `>=` the same `activates_at`), with no gap or overlap.
- `init_if_needed` on `binding` (lib.rs:384). Seeds include the signing authority's key, so only that authority can create or modify it. The payer only pays rent and must co-sign. Existing accounts go through the owner, discriminator and space checks, with no reset. A fresh account has version 0, so `expected_version` must be 0. The version is strictly monotonic (checked add).
- PDA seed collisions. Prefix plus fixed-width field lengths are 37 (vault), 52 (veto), 69 (award), 70 (origin), 71 (project and service, whose prefixes differ in the first byte) and 78 (wallet). No two seed families can produce the same preimage.
- `pay` recipient and amount selection. Amounts come from the immutable `Obligation`. The destination must be the ATA of `binding.destination` and owned by it (lib.rs:412). The binding is seed-derived from the project's fixed authority and network and the obligation's actor (lib.rs:407). The obligation is seed-checked and `has_one=project` (lib.rs:405). The vault is seed-checked (lib.rs:410). A foreign or attacker-created `Project` can only spend its own vault, because signer seeds come from that project's stored owner, id and bump, which `initialize` set from the same values as the PDA seeds.
- Replay and double pay: `paid` is checked first and written back at exit (lib.rs:152, 196). Two `pay` instructions in one transaction see the persisted flag. Obligation and origin are permanent (no close), so they cannot be recreated. The origin is redundant with the award PDA (award_id is a function of source_digest) but harmless.
- CPI ordering and reentrancy. Classic SPL Token does not call back. Solana forbids indirect reentrancy. Any failed transfer reverts the whole transaction, so there is no partial state if the fee transfer fails after the principal transfer.
- Duplicate account aliasing. Anchor 0.32 has no duplicate-mutable check, but `project` and `obligation` have distinct discriminators, `destination` and `fee_account` are token-program-owned so Anchor never writes them back, and `!= vault` constraints block self-transfers from the vault.
- Arithmetic. All adds are checked, and `free()` uses checked subtraction (lib.rs:299-310). `reserved >= gross` holds for every committed and unpaid award, so the subtraction at lib.rs:190-193 cannot fail. The withdrawal fee `floor(cum/10) - withdrawal_fees` is never negative and never exceeds `gross` for `gross >= 1`, so splitting withdrawals cannot cut the total fee below `floor(total/10)`. `bound_at + binding_delay` is checked (lib.rs:294-296). `overflow-checks = true` in release (Cargo.toml).
- Conservation: `deposited = free + reserved + paid + payout_fees + withdrawn_gross + service_fees` holds after every instruction (deposit: +deposited +free; commit: free to reserved; pay: reserved to paid + payout_fees; withdraw: free to withdrawn_gross, which includes the fee; charge_service: free to service_fees). Vault balance equals free + reserved + unsolicited, because only the PDA can debit the vault. The extra `vault.amount >= reserved + x` checks are sound defense in depth.
- `withdraw` destination is any token account whose owner field is the project owner (lib.rs:429). That matches "refund only to owner". It cannot be the vault.
- `charge_service` moves only free funds to a fee-recipient-owned account, once per (project, invoice) via the `init` PDA. It does not touch `reserved`.
- Token-2022 exclusion. `Program<Token>` and `anchor_spl::token::{Mint, TokenAccount}` enforce classic Token program ownership. The hardcoded decimals 6 matches the `initialize` mint check, and `transfer_checked` re-verifies it. Classic SPL has no transfer fees, so the credited `amount` in `deposit` is exact.
- Account layout. `Project` INIT_SPACE is 257 (Borsh, no padding), so the adapter's offsets (delay at 249, authority at 104, fee recipient at 136, mint at 168) and the Obligation `paid` at 136 match.
- Program ID. No program keypair is committed (git ls-files). The deploy script refuses mainnet and requires the source `declare_id!` to match the keypair. The upgrade-authority trust boundary is documented, and the adapter and manifest schema require `null` on mainnet.

## Divergences between EVM and Solana
- Parameter pinning. EVM: a registrar-only factory fixes token, fee recipient, identity authority and delay. Solana: `initialize` is permissionless and owner-chosen, with no delay bound (F-2).
- Binding scope. EVM bindings are per vault. Solana bindings are shared per (authority, network, actor), with per-project vetoes (F-4).
- Fee path. EVM accrues fees and `claimFees` pushes them, so a broken fee recipient blocks only fee claims. Solana pushes the fee inside `pay`, `withdraw` and `charge_service` to any caller-chosen account the fee recipient owns (F-3).
- Bind inputs. EVM has `expiresAt`, `claimDigest != 0`, and `destination != address(this)`. Solana has none of these (F-7). EVM requires `sourceDigest != 0`; Solana does not.
- `feeRecipient != address(this)` on EVM. No `fee_recipient != project PDA` check on Solana.
- Award ID domain. EVM includes `block.chainid` and the vault address. Solana includes the project PDA only, so there is no cluster component (F-8).
- Events. EVM emits `Deposited`, and `Paid` includes `actorId`. Solana has no deposit event, and `AwardPaid` omits `actor_id` (F-6).
- Unbounded cancel or veto is the same on both (F-1).

## Open questions for the lead
- Is unbounded repeated veto (F-1) an intended owner power? If not, which limit does product want? This is a policy call for Shaw.
- Does manifest review pin `identityAuthority` and `feeRecipient` to Slop's published keys? `src/lib/escrow-policy.mjs:61-136` checks only format, role separation and a minimum (not maximum) delay. If the owner supplies them, F-2(a) lets an owner reclaim committed awards on a reviewed project, and its severity should rise.
- When the Slop pipeline verifies a `pay`, does it compare the paid destination to the contributor's consented wallet in D1, or does it trust the on-chain binding? This decides whether F-2(a) would be recorded as "paid".

## Attack classes the e2e suite does not cover (integration/escrow.e2e.mjs)
- A second project sharing the same authority and network: veto isolation, different per-project delays against one shared `bound_at`, and a rebind resetting the other project's clock.
- More than one veto per actor (successive versions), and a veto attempt for a future version or version 0.
- Lamports sent in advance to the veto, award, origin, binding or vault PDA addresses before `init`.
- A non-ATA fee account or a frozen fee account (only the destination freeze is tested, lines 303-304). A zero-fee award to a frozen fee account.
- ATA owner reassignment by the contributor.
- `initialize` with `binding_delay` of 0, very large, or `i64::MAX`, or with an arbitrary identity authority or fee recipient equal to the project PDA.
- Two `pay` instructions in one transaction. A rebind and `pay` in the same transaction.
- Token-2022 mint or token account rejection.
- The exact boundary `now == activates_at` (wall-clock validator makes this hard; `warp` or a bankrun harness would cover it).
