# Reviewer: sonnet / parity and accounting

Scope: `ProjectEscrow.sol` and `slop-escrow/src/lib.rs` read side by side at bbcc87b, both READMEs, `docs/payouts-mvp.md`. EVM arithmetic checked with Foundry (`.../review/evm/test/SonnetParity.t.sol`, 11 tests, all pass, including a 256-run fuzz of split withdrawals and conservation-identity checks after every step). Solana reasoned from code only.

Headline: I found no way to create or lose money on either chain through fee arithmetic, splitting, ordering, `chargeService`, failed transfers or unsolicited transfers. Fees match exactly across chains. The findings below are liveness and documentation/reconciliation issues, not accounting breaks.

## Findings

### F-1: Owner cancel/veto is repeatable without bound, and "active binding is final" is not true
- Severity: Medium  Confidence: high (behavior), medium (severity, because the README documents "delay")
- Location: EVM `ProjectEscrow.sol:159-175`, `178-185`, `187-191`; Solana `lib.rs:96-129`, `132-148`, `157-160`; EVM README lines 30-33; Solana README lines 29-31.
- Description: The README says the owner "can therefore delay a contributor's payout". The code lets the owner cancel/veto every pending binding, for any actor, with no cap and no cost on EVM (and only veto-PDA rent on Solana). Each honest rebind by the authority starts a new pending window, so the owner can cancel it again. The award stays reserved (owner cannot reclaim it) but never becomes payable. Separately, "an active binding is final" is only true for that version's own `activatesAt`: `bindDestination` / `bind_wallet` overwrite the single stored binding, so an authority rotation (even to the same destination) makes the previously active version unpayable at once (`pay` requires `binding.version == expectedVersion`), and an owner cancel of the replacement leaves the actor with no payable binding at all.
- Scenario (EVM): owner commits award to actor 7. Loop: authority `bindDestination(7, dest, v)` then owner `cancelBinding(7, v+1)` inside the delay window, then `pay(id, v+1)` reverts. After 10 rounds the award is still reserved, `freeBalance` unchanged, owner cannot withdraw it. Variant: v1 is active and payable; authority rotates to v2 (e.g. wallet update requested by the contributor); owner cancels v2; `pay(id,1)` and `pay(id,2)` both revert. Solana is identical via `veto_binding`, with the extra property that the veto key is `(project, actor, version)`, so each round costs the owner one rent-exempt veto account.
- Evidence: `test_repeatedCancelBlocksForever`, `test_activeBindingSupersededThenCancelled` (both pass on EVM). Solana: reasoning only.
- Recommendation: Either document it as an indefinite owner veto (not a "delay") and rely on the sponsor-review policy, or bound it: allow at most one cancel per actor per project (or per N days), or let a version that survives one full window become immune to cancel even if the authority later rotates (keep the old active binding payable until the new one activates). Fix the README wording "An active binding is final".

### F-2: Solana payouts, withdrawals and service charges hard-depend on a live, unfrozen fee token account; EVM isolates this
- Severity: Low  Confidence: medium
- Location: `lib.rs:178-186` (pay fee leg), `229-237` (withdraw fee leg), `266-274`, `412-415`, `431`, `445`.
- Description: Both legs are always sent, including when `fee == 0`. SPL Token's transfer rejects a frozen source or destination even for amount 0, so a frozen `fee_account` reverts a payout whose fee is 0 (any award under 50 micro-units, or a withdrawal whose cumulative step is 0). The EVM design explicitly avoids this ("a blocked fee recipient cannot stop payouts or refunds", accrual plus `claimFees`).
- Scenario: Circle freezes the fee recipient's ATA. A relayer that keeps passing that ATA as `fee_account` fails every `pay`. This is recoverable because `fee_account` is only required to be a mint-matching token account with `owner == project.fee_recipient` (not an ATA), so anyone can create a fresh non-ATA account owned by the fee recipient via InitializeAccount3 and pass it. It becomes a lock only if the executor / owner-plan tooling hard-codes the ATA.
- Evidence: reasoning only.
- Recommendation: Skip the fee leg when `fee == 0` (matches EVM `sendExact` returning early on 0); make sure the executor falls back to an alternate fee account; document it.

### F-3: Input validation parity gaps on Solana (and an EVM destination check Solana lacks)
- Severity: Low  Confidence: high
- Location: Solana `lib.rs:60-66` (commit), `104-107` (bind_wallet); EVM `142`, `167-170`.
- Description: EVM rejects `sourceDigest == 0`, `claimDigest == 0`, `destination == address(this)`, and requires `expiresAt >= now`. Solana accepts zero `source_digest`, zero `claim_digest`, a `destination` equal to a project PDA / vault authority (the derived ATA is then owned by the project PDA and can never be spent: no instruction moves it), and has no submission expiry. A durable-nonce bind transaction therefore stays valid until its predecessor version changes. The authority is the only caller, so each is a trusted-component mistake, not an attack.
- Evidence: reasoning only.
- Recommendation: Add the same `!= [0;32]` checks and a `destination != project.key()` check; consider an expiry argument or document that bind transactions must use recent blockhashes only.

### F-4: Unbounded `bindingDelay` / `binding_delay` can permanently brick payout (config risk)
- Severity: Low  Confidence: high
- Location: EVM `ProjectEscrow.sol:172` (checked add), `EscrowFactory` ctor `273-282`; Solana `lib.rs:17-23`, `293-297`.
- Description: EVM: `uint64(block.timestamp) + bindingDelay` panics if the immutable delay is near `type(uint64).max`, so every `bindDestination` in every vault of that factory reverts; reserved awards are unpayable forever. A delay that makes `activatesAt == type(uint64).max` also collides with the cancel sentinel. Solana: `binding_delay` is chosen by the project owner at `initialize` (only `>= 0` is checked); a value like `i64::MAX` makes `activates_at` return `Arithmetic` in both `pay` and `veto_binding`, so any committed award on that project is unpayable. Neither chain enforces the documented 48 h minimum on chain; the adapter and manifest do.
- Evidence: reasoning only.
- Recommendation: Add an on-chain upper bound (for example 30 days) and, if desired, a lower bound; reject near-overflow values in the EVM constructors.

### F-5: Events do not let an indexer rebuild the full ledger on Solana, and EVM fee events mean "accrued", not "transferred"
- Severity: Low  Confidence: high
- Location: see section "Event reconstruction" below.
- Description: Solana lacks `Deposited` and `initialize` events, `AwardPaid` has no `actor_id`, no destination token account and no fee token account, `UnusedWithdrawn` has no destination account, `WalletBound` has no `claim_digest` / `authority` / activation time. All Solana events are program logs that the runtime can truncate (the README already says the adapter parses instructions instead). On EVM, `Paid.fee`, `UnusedWithdrawn.fee` and `ServiceCharged.amount` record accruals; tokens only move to the fee recipient in `FeesClaimed`, which does not break down by source, so "ServiceCharged = money paid to Slop" would be wrong until claimed.
- Evidence: reasoning only.
- Recommendation: Add `Deposited`/`ProjectInitialized` events and `actor_id`, `destination_token_account`, `fee_token_account` to Solana events; document the accrual semantics for EVM consumers or add a `totalFeesClaimed` counter.

### F-6: README conservation identities are not fully checkable on chain
- Severity: Informational  Confidence: high
- Location: EVM README lines 77-86; Solana README lines 54-55.
- Description: EVM identity 3 (`accruedFees + claimed fees = ...`) has no `claimed` counter in state (only `FeesClaimed` events), so it cannot be asserted from storage. Solana's identity `deposited = free + reserved + paid + ...` is a tautology because `free()` (`lib.rs:299-307`) is defined as the remainder. The real invariant is `vault.amount = free + reserved + unsolicited` (unsolicited >= 0), which neither README states. I verified it holds after every instruction (derivation below).
- Recommendation: add `totalFeesClaimed` on EVM; state the real Solana invariant in the README.

### F-7: `payouts-mvp.md` says "Contracts enforce ... fees" but Solana fee recipient, authority and delay are owner-chosen at `initialize`
- Severity: Informational  Confidence: high
- Location: `docs/payouts-mvp.md:17`; `lib.rs:9-34`.
- Description: `initialize` is permissionless and takes `identity_authority`, `fee_recipient`, `binding_delay` from the owner, who may set `fee_recipient` to itself (no 1% / 2% / 10% flows to Slop). EVM pins these in `EscrowFactory` (registrar-gated). On Solana the guarantee is manifest/adapter-level only. The Solana README does say a reviewed manifest must bind these, so this is a wording gap in the MVP doc.
- Recommendation: qualify the sentence in `payouts-mvp.md`.

## Fee arithmetic

Identical integer operations on both chains: payout `fee = gross / 50` (EVM `:126`, Solana `:66`), net `= gross - fee` (cannot underflow: fee <= gross/50 < gross for gross >= 1, so net >= 1 and `sendExact` never receives 0 from `pay`). Withdrawal `fee = floor((W+g)/10) - F` where W = cumulative gross withdrawn, F = withdrawal fees charged.

Proof that F = floor(W/10) always: W0 = F0 = 0; each withdrawal sets F to floor((W+g)/10) and W to W+g. So the subtraction never underflows, total fees depend only on total gross (path independent: splitting can neither reduce nor increase the total), and `fee <= g` always (floor(x/10) rises by at most 1 per unit), so `gross - fee` cannot underflow. Payouts and `chargeService` never touch W or F, so interleaving changes nothing (tested). Overflow of `W+g` reverts on both (EVM 0.8 checked, Solana `add`).

Payout fee table (EVM and Solana identical):

| gross | fee | net |
|---|---|---|
| 1 | 0 | 1 |
| 49 | 0 | 49 |
| 50 | 1 | 49 |
| 51 | 1 | 50 |
| 99 | 1 | 98 |
| 100 | 2 | 98 |
| 149 | 2 | 147 |
| 150 | 3 | 147 |
| 1,000,000 | 20,000 | 980,000 |

Per-award flooring is not path independent in the other direction: three 49-unit awards pay fee 0 where one 147 award pays 2 (test `test_selfPayoutExitFeeAndFragments`). The leak is at most 49/50 of one micro-unit per award, so exploitation is uneconomic (storage / rent / gas per award dwarfs it); README "tiny award rounding is intentional" is accurate. The README "splitting cannot reduce fees" is true for withdrawals only.

Withdrawal sequences (fee charged per step, cumulative rule):

| sequence of gross | fee per step | total fee | floor(total/10) |
|---|---|---|---|
| 100 | 10 | 10 | 10 |
| 10 x 10 | 1 each | 10 | 10 |
| 1 x 100 | 1 on every 10th step | 10 | 10 |
| 9, 1 | 0, 1 | 1 | 1 |
| 1, 9 | 0, 1 | 1 | 1 |
| 5, 5 | 0, 1 | 1 | 1 |
| 9, 1, 9, 1 | 0, 1, 0, 1 | 2 | 2 |
| 1, 49, 50, 51, 99, 100, 149 | 0, 5, 5, 5, 10, 10, 14 | 49 | 49 |

Observation: a single step can charge a fee equal to its gross (9 then 1: the second step has fee 1, returned 0). That is legal, path-total is unchanged, and EVM skips the zero transfer while Solana sends a zero-amount transfer (see F-2).

Interleaved EVM test: deposit 10,000; commit 149 and 99; withdraw 9; pay 149; withdraw 1; pay 99; withdraw 5. Nets 147 and 98; accrued fees 2 + 1 + (cumulative 15 -> 1) = 4; `claimFees` moves exactly 4; both identities hold after each step.

`chargeService` interplay: reduces `freeBalance` and increments `totalServiceFees` / `accruedFees` only; excluded from W, so it neither raises nor lowers the 10% withdrawal fee. Test: charge 100, then withdraw 100 yields fee 10; total claimed 110; withdraw of 801 from 800 free reverts.

The acceptance example in `payouts-mvp.md:23` (deposit 1,000; awards 100 and 50; pay 98+2; refund 850 as 765 + 85; late pay 49 + 1; totals 147 / 3 / 765 / 85) is reproduced by the formulas.

## Conservation identities (derived per instruction)

EVM, with D = totalDeposited, F = freeBalance, RP/RF = reservedPrincipal/Fees, P = totalPaid, PF = totalPayoutFees, GW = totalGrossWithdrawn, SF = totalServiceFees, A = accruedFees, B = token balance of vault:

| instruction | I1: D = F+RP+RF+P+PF+GW+SF | I2: B = F+RP+RF+A |
|---|---|---|
| deposit(a) | D+a, F+a | B+a, F+a |
| commitAward(g) | F-g, RP+g-f, RF+f | unchanged both sides |
| pay | RP-net, RF-f, P+net, PF+f | B-net; RP-net, RF-f, A+f; net change -net |
| withdrawUnused(g) | F-g, GW+g | B-(g-fee); F-g, A+fee |
| chargeService(a) | F-a, SF+a | B same; F-a, A+a |
| claimFees | no effect | B-A, A to 0 |
| bind/cancel | no effect | no effect |

Both hold in the code and under fuzz. Failed transfers revert whole transactions (state is written before `sendExact`, but a revert restores it; blocked-destination test leaves RP = 98, RF = 2). Unsolicited transfers make B strictly larger than the sum; nothing reads B except the per-call delta checks in `sendExact`, which compare before and after inside one call, so donations cannot make them fail. Cancel adds no accounting state.

Solana: define U = vault.amount - free - reserved. Every instruction keeps U unchanged: `commit` adds reserve to `reserved` and leaves `free` = F - g; `pay` moves exactly `principal + fee = gross` from `reserved` to `paid + payout_fees`; `withdraw` moves `returned + fee = gross` out of the vault and into `withdrawn_gross`; `charge_service` moves `amount` out and into `service_fees`; `deposit` adds equally to vault and `deposited`; `veto` / `bind` touch nothing. U starts at 0 and only grows via unsolicited transfers or MintTo (the vault authority is the project PDA, so Burn, Transfer, SetAuthority, Close and Approve are impossible without the program signing; the program never does those). So `free()` cannot underflow (each decrement is guarded by `free >= amount` or is a reserve-to-paid move of equal size), and the second guard `vault.amount >= reserved + x` (lines 71, 211, 262) is redundant but harmless. A freeze of the vault only stalls payouts; counters stay consistent. I found no sequence where `free()` and `vault.amount` diverge in a way that locks credited funds or allows over-commit; the only divergence is stranded unsolicited tokens (documented).

## State machine parity matrix

| Power / property | EVM | Solana | Consequence of difference |
|---|---|---|---|
| Who may create a vault | factory registrar only, one per projectId; fee recipient, authority, delay, token pinned by factory (`:273-293`) | anyone via `initialize`, seeds (owner, project_id); owner picks authority, fee recipient, delay, mint (6 decimals) (`:9-34`) | Solana protocol fee and authority are manifest-level only (F-7); project_id not unique across owners; delay is owner-chosen (F-4) |
| Deposit | owner only, exact-delta check (`:130-138`) | owner only via transfer_checked, counter credited with requested amount (`:35-52`) | none (classic SPL is exact) |
| Commit award | owner; id = keccak(chainid, vault, digest); rejects zero digest | owner; id = sha256("slop-escrow-award", project PDA, digest); accepts zero digest; extra `origin` PDA | Solana id has no cluster domain: same program id + owner + project_id on devnet and mainnet gives same award_id (ledger keys must include cluster); zero digest accepted (F-3) |
| Award cancellation | none | none | parity |
| Bind | authority; per vault; claimDigest != 0; expiresAt; destination != 0, != vault; version = predecessor + 1 | authority signer (separate payer); per (authority, network, actor), shared by all projects of that authority; no expiry; zero digest allowed; destination only != default | shared Solana binding means one rotation resets `bound_at` and invalidates expected versions for every project at once; a compromised authority key needs one tx, not one per vault; each project must veto separately |
| Pending window | `activatesAt` stored at bind from immutable factory delay | `bound_at` stored, delay read from project each time | none |
| Owner stop | `cancelBinding(actor, version)`: only while `now < activatesAt`; sets sentinel max; repeatable (second cancel also succeeds, re-emits) | `veto_binding(actor, version)`: only while pending; creates veto PDA keyed (project, actor, version); second veto fails (init); veto cannot be created for a not-yet-existing version (requires `b.version == version`) | both give unbounded repeated delay (F-1); EVM cancel mutates the binding so public getters show max; Solana binding account still looks live after a veto, readers must also check the veto PDA |
| Active binding vs rotation | rotation overwrites and unpays old version | same | README "active binding is final" misleading on both |
| Pay | permissionless; net sent, fee accrued; `expectedVersion`; destination any nonzero non-vault address | permissionless; net and fee both sent; destination must be the bound wallet's ATA; caller supplies `fee_account` | EVM payout cannot be stopped by a fee-recipient block; Solana can (F-2); Solana needs ATA to exist |
| Fee transfer | `claimFees()` anyone, pulls accrued to immutable recipient | inline, to any token account owned by `fee_recipient` | event semantics differ (F-5) |
| Withdraw unused | to immutable `refundDestination == owner` | to any token account whose authority is the owner key | equivalent trust; Solana event omits destination |
| Charge service | accrues (no transfer until claim) | immediate transfer; PDA per digest | EVM invoice "paid" only after `claimFees` |
| Claim expiry / `expiresAt` | present (submission only) | none | stale durable-nonce bind tx stays valid on Solana |
| Replay / duplicate pay | `paid` flag, per-vault award | `paid` flag, permanent PDAs | parity |
| Reentrancy | `nonReentrant` on money-moving calls; `commitAward` / bind / cancel unguarded but state is consistent at all callback points | n/a | none found |
| Token validation | six decimals checked at deploy, exact deltas | mint decimals 6, classic Token only, transfer_checked(6) | parity |
| Upgrade | none (immutable) | upgrade authority must be null on mainnet (launch gate) | upgrade key could drain on Solana until burned |
| Counters | checked uint64 | checked u64 | parity (overflow reverts) |

## Event reconstruction

EVM: `Deposited(sponsor, amount)`; `AwardCommitted(id, actorId, gross, fee, sourceDigest)` (net = gross - fee); `DestinationBound(actorId, destination, version, claimDigest, activatesAt)`; `BindingCancelled(actorId, version)`; `Paid(id, actorId, destination, version, gross, net, fee)`; `UnusedWithdrawn(destination, gross, net, fee)`; `ServiceCharged(invoiceDigest, amount)`; `FeesClaimed(recipient, amount)`; factory `VaultCreated`. Reconstructible: every payee, gross/net/fee, version, deposits, refunds, claims. `Paid.destination` is exactly the address passed to `sendExact` (`:199-200`), so it does not mislead. Caveats: fee fields are accruals (tokens move at `FeesClaimed`, which merges payout, withdrawal and service fees); `DestinationBound.activatesAt` is superseded by a later `BindingCancelled` (no sentinel in the event); `Paid` lacks `sourceDigest` (join through id); `VaultCreated` omits fee recipient / authority / delay (read immutables).

Solana: `AwardCommitted` (project, award_id, source_digest, actor_id, gross, principal, fee) is complete. `WalletBound` lacks `claim_digest`, `authority`, previous version. `BindingVetoed` is complete. `AwardPaid` has `destination` = wallet owner pubkey (not the ATA that received tokens) and no `actor_id` (join via award_id), no fee token account. `UnusedWithdrawn` has gross, fee, returned but no destination token account (owner may choose any). `ServiceCharged` has no fee token account. No event for `initialize` or `deposit`. Events are `emit!` logs, which can be truncated, so complete reconstruction needs instruction data plus pre/post token balances; the README's instruction-based adapter does that.

## Checked and found sound
- Payout fee floor and `gross - fee`: no underflow, net >= 1 (EVM `:125-127,192`; Solana `:66-67`).
- Withdrawal fee formula (EVM `:207-209`, Solana `:214-218`): F = floor(W/10) invariant makes subtraction safe, path-independent total, fee <= gross, tested with fuzz.
- chargeService: excluded from W/F, once-per-digest (EVM `:222`, Solana `init` of `service` PDA `:447`), cannot spend reserved funds.
- Both conservation identities on EVM and the free/reserved/unsolicited invariant on Solana hold after every instruction (derivations above).
- Failed or blocked transfers roll back entire state on both (EVM test; Solana atomicity).
- Unsolicited transfers: cannot cause over-commit (EVM tracks `freeBalance`; Solana `free()` is counter-derived and the vault guard is an additional bound), cannot cause underflow or a stuck instruction; they are simply stranded (documented).
- `veto_binding` / `cancelBinding` cannot affect an active binding, cannot pre-block a future version (`b.version == version`), and a cancelled/vetoed version can never pay (EVM sentinel max; Solana veto PDA must be empty system account; a pre-funded veto address stays system-owned and empty, so griefing by lamport donation does not create a veto).
- Solana `free()` cannot underflow: every decrement is guarded; `pay` moves exactly gross from `reserved` to `paid + payout_fees`.
- Award IDs: EVM binds chainid and vault; Solana binds project PDA (which embeds program id and owner); award and origin PDAs stop duplicates; reserving another project's ID is impossible.
- Acceptance numbers in `payouts-mvp.md` reproduce.

## Divergences between EVM and Solana
See the matrix. Ones with protective asymmetry: EVM has chain-id domain separation, zero-digest and `destination != vault` checks, submission expiry, fee accrual that decouples payouts from the fee recipient, immutable factory-pinned parameters. Solana has: one-time-use veto PDA, ATA-only destinations, `network` binding in the project and bindings, immediate fee delivery (nothing sits in the vault).

## Open questions for the lead
- Is repeated owner cancel/veto (F-1) within the intended trust model? If so the README should say "indefinitely block", and the "active binding is final" sentence should go. If not, a per-actor cancel budget is the smallest fix.
- Does the Solana executor ever hard-code the ATA for `fee_account`? If yes, F-2 becomes a real liveness risk.
- Do other reviewers' Solana findings about shared bindings (cross-project rotation resets) want to be merged with the F-1 theme?
- Docs housekeeping, not security: `docs/payouts-mvp.md` lines 11 and 36 use "earnings"; the project's language rule prefers projected/approved/paid wording.
