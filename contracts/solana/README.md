# Solana protected payout escrow

This Anchor program holds classic six-decimal SPL tokens in a separate PDA vault
for each owner/project digest. Deployment policy must pin the approved USDC mint
and network domain. The program deliberately cannot determine GitHub authority or
whether an arbitrary mint is Circle USDC. A reviewed project manifest must bind
its program ID, project PDA, network, mint, owner and identity authority.

The owner deposits and approves immutable awards. The only mutable authority is
the identity authority, replaced by a public two-party timelock. Award approval reserves principal
and its included 2% fee before a wallet exists. The `award` PDA and separate `origin` PDA are
permanent: no close, cancellation, rescue or reserve withdrawal instruction exists.
The same source digest cannot be committed again under a different award ID.
The award ID must equal `sha256("slop-escrow-award" || project PDA || source digest)`,
so another project cannot reserve the same ID first.
A binding needs two signatures. The project's identity authority (Slop's
attester key) and the destination keypair both sign `bind_wallet`, which binds
a numeric GitHub actor to that co-signing destination with an expected
predecessor version. The program takes the destination from the co-signer, so
the authority alone cannot bind a wallet it does not hold, and a destination
cannot bind itself without the authority. Binding PDAs are per project: their
seeds are the project PDA and the actor, inside the program deployment, and
`bind_wallet` also checks the project's network domain. A binding in one
project never pays, delays or vetoes anything in another project, and the seeds
do not include the authority, so bindings survive an authority rotation.
Permissionless payment callers select neither amount nor recipient; the binding
and expected version select the recipient. The backend must verify GitHub login
and the contributor's current registered claim before the identity signer
co-signs. A compromised identity key cannot redirect unpaid awards on its own;
with a colluding wallet it can propose a new destination, which the delay and
veto below exist to catch. The authority must be disclosed, protected and
reviewed separately from relayers.

Two delays protect awards, both of length `binding_delay` (set once at
`initialize`, between one hour and 30 days). Each binding records `bound_at`,
and `pay` rejects the latest binding until `bound_at + binding_delay`. Each
award records `committed_at`, and `pay` rejects the award until
`committed_at + binding_delay`, so a binding placed before the actor had any
award still gives the owner a full delay from the moment money is attached to
it. The owner's exact power is `veto_binding(actor_id, version)` on the latest
binding: allowed while that binding waits out its own delay, or while an unpaid
award to the actor (passed as the optional `obligation` account) is inside its
commit delay, and never on a binding that has paid. A veto creates a permanent
`veto` PDA for that project, actor and version, and `pay` in that project never
uses a vetoed version. Only a new co-signed binding (the next version, with a
new delay) can follow. Between two payments to an actor, the owner can veto at
most three times (`veto_count` on the binding, reset by each payment); the next
binding cannot be vetoed and pays after its delay. An owner can therefore delay
a contributor's payout by a bounded number of delays, but never take an approved
award back or redirect it.

Only the latest binding (`destination`, `version`, `bound_at`, `claim_digest`)
can pay. `pay` requires its delay to have passed in this project and requires
the empty `veto` address for that version. `paid_version` records the version
the last payment in this project used, so that binding cannot be vetoed. While
a rotation waits out its delay, or after the owner vetoes it, no payment goes
to any earlier wallet: a contributor who rotates away from a lost or compromised
wallet freezes payment to it at once. This is the stale-binding rule in
`docs/base-solana-payout-plan.md`: a finalized change invalidates payment to
the earlier destination. `pay` requires the destination to be the
paying wallet's associated token account, and `bind_wallet` rejects a zero
claim digest, a destination equal to the identity authority, the project or the
vault PDA, and a submission past its `expires_at`; a PDA cannot co-sign in any
case. `initialize` rejects a fee recipient equal to the owner
or the project. Production deployments use a delay of at least 48 hours, and
the adapter checks the project's delay against the reviewed manifest.

### Identity authority rotation

Each project rotates its own identity authority through a public two-party
timelock. The owner calls `propose_authority_rotation(next)`, which records the
candidate and an effective time `rotation_delay` seconds later (set at
`initialize`; production uses at least 7 days, and the adapter checks the
project's delay against the reviewed manifest) and emits
`AuthorityRotationProposed`. The fee recipient, the second fixed party, calls
`confirm_authority_rotation`. The owner can cancel its own pending proposal
with `cancel_authority_rotation`. Once confirmed and past the effective time,
anyone can call `execute_authority_rotation`, which emits `AuthorityRotated`;
the current authority has no instruction that blocks or delays it. Until
execution the current authority keeps binding; afterwards only the new one
can. Binding PDAs derive from the project and actor, not the current
authority, so every existing binding stays valid and `pay` keeps finding it.
Each project rotates independently: no other project's authority can write this
project's bindings. The next authority must differ from the owner, the fee
recipient and the current authority.

### Key recovery runbook

Who acts: the project owner key and the fee recipient key, together. The
identity key is a hot service key and is never used for recovery. Slop holds
the identity key and, as fee recipient, the confirming key; the owner alone
starts every rotation.

Identity key lost: the authority can no longer co-sign, so awards to actors
without an active binding wait; nothing is lost and no reserve moves. The
owner proposes the replacement, the fee recipient confirms, and anyone
executes after the delay. Existing bindings keep paying throughout.
Contributors whose bindings were pending or missing co-sign their next binding
with the new authority.

Identity key compromised: the owner proposes the replacement at once; the
exposure window is the rotation delay. During it the attacker can submit only
bindings that a wallet co-signs, each activating after `binding_delay`. The
owner watches `WalletBound` and vetoes any binding it did not expect with
`veto_binding`, which costs the contributor a delay and nothing else. After
execution the old key cannot bind. Rotation never vetoes or re-points a
binding by itself, so review every binding made during the window. The owner
vetoes late in each binding's delay, so three vetoes and the fourth binding's
own delay cover at least four binding delays: 8 days at the 48-hour production
minimum, longer than a 7-day rotation delay. After execution the new authority
co-signs the contributor's binding as the next version before the attacker's
last binding activates, and only the latest binding pays. A project whose
rotation delay is longer than four binding delays must choose a longer binding
delay.

Owner key lost: deposits, awards, withdrawals and rotation proposals for that
project stop; reserved awards still pay to active bindings. Fee recipient key
lost: fee transfers to its token accounts still work, but no rotation can be
confirmed, so the identity key of that project becomes fixed. There is no
owner or fee recipient change in this version.

The owner can commit an award to any GitHub actor, including an account the
owner controls, and so move unused funds out at the 2% payout fee instead of the
10% withdrawal fee. This is an accepted, documented risk: maintainer review of
related-party awards enforces the policy, not the program.

The 2% fee is deducted from each gross award: 100 pays 98 to the contributor
and 2 to the fee recipient, reserving 100. Integer arithmetic floors gross/50 once
per immutable award; unused withdrawal charges the difference
between floor(cumulative gross/10) and fees already charged. Amounts are SPL u64
micro-units. Tiny awards can incur zero fee. Withdrawals consume only free vault
balance, return funds only to the declared owner, and retain fees after any earlier
payout. Direct unsolicited token deposits do not confer refund rights and are not
counted in `deposited`; such transfers remain unavailable to awards and refunds. Both credited free balance
and the actual vault token balance must cover every new reserve or withdrawal.

`charge_service(amount, invoice_digest)` (PAY-10) lets only the owner pay one
Slopbot invoice from free funds to the fee recipient's token account. A
permanent `service` PDA per project and invoice digest makes each charge
happen once. The `service_fees` counter joins the conservation identity:
`deposited = free + reserved + paid + payout_fees + withdrawn_gross + service_fees`.
The binding lifecycle does not change this identity. A zero-amount transfer leg
(a zero fee, or a withdrawal whose return rounds to zero) is skipped, so a
frozen fee account cannot stall a zero-fee payout.
It cannot spend reserved principal or fees. Only the owner deposits, so every
credited balance is sponsor-class; this version holds no donor-class funds.

All transfer instructions validate the classic token program, mint, token account
owners, vault PDA, project account and signer. Failed token transfers roll back the
entire transaction, including fees and accounting. Frozen destinations do not block
other awards. `paid`, reserve, principal paid and fee counters are on-chain. Paid
records remain permanently allocated to prevent account recreation replay.

## Local build and end-to-end tests

Run `npm run build` here to build the actual SBF binary and its IDL.
Run `npm run test:e2e` to load that binary into an isolated local validator and
execute the SPL payment, durable executor, and unsigned owner-plan workflows.
These use real token accounts, transactions, finalized receipts and balance
checks. They cover the canonical lifecycle, delayed wallet registration, wallet
rotation that freezes payment to the earlier wallet, project-scoped bindings,
binding delay and owner veto with its cap, reserve protection, split withdrawals,
frozen destination rollback, duplicate payment and forged award rejection, wrong
destination, unauthorized binding, a third-party payment mixed with unrelated
token transfers, and a foreign project that mentions this project's account.
Fixture keys and tokens have no mainnet value. CI runs these end-to-end
workflows; a successful build alone is not payment evidence.
`cargo check --locked` verifies the host program build but does not prove SBF or
validator execution. Use Anchor 0.32.1 and the platform tools pinned in the scripts.
The end-to-end suite waits the binding delay out in seconds, so `test-e2e.sh`
builds with the `short-delay-for-tests` Cargo feature, which lowers the on-chain
delay floor from one hour to one second. `deploy-testnet.sh` never sets it;
a reviewed deployment digest must come from a build without it. Before that,
`test-e2e.sh` builds the deployable program without the feature, loads it into
the validator and runs `integration/production-delay.e2e.mjs`, which proves that
`initialize` rejects 3,599 seconds and accepts 3,600 seconds. `cargo test` checks
the same bounds on the host build.

## Public test deployment

`scripts/deploy-testnet.sh` is an explicit operator entry point, limited to Devnet
and Testnet. Provide reviewed expected genesis, isolated test payer/program/upgrade
keypair files, and the cluster through its documented required environment variables.
First update `declare_id!` and Anchor configuration to the chosen public program
identity, review and commit those public source changes, then invoke the script.
It builds the committed source, deploys, reads authority metadata and compares
program bytes. It never accepts mainnet or emits private key bytes.

Use Circle test USDC on Devnet only after rechecking Circle's current mint list.
Solana Testnet compatibility uses an explicitly labeled test mint when Circle has
no supported mint there. A local mint does not prove Circle USDC acceptance.
Deployment alone is not product acceptance: run the canonical funded lifecycle,
finalized reconciliation, real OAuth and browser journey separately.

Program upgrade authority remains a fundamental trust boundary: a retained upgrade
key can replace these restrictions. Do not activate mainnet without an explicit
reviewed immutable or governance-controlled deployment decision and independent
contract review. The owner and fee recipient keys are fixed in each project;
the identity authority changes only through the public two-party timelock
above, never through a hidden administrative bypass.

## Deployment identity and automatic execution

`adapter.ts` is Worker-compatible and verifies finalized transactions per
escrow instruction, not per transaction. The event index is the instruction's
position in the transaction's flattened instruction list (top-level
instructions, each followed by its inner instructions). For `commit` it checks
the instruction's project, award account and arguments against the durable
award. For `pay` it requires the inner `transferChecked` calls from the vault,
signed by the project PDA: the net amount to the destination, and the fee to
the fee recipient's account unless the fee is zero. Logs are not used, because unrelated
instructions in the same transaction can truncate them. Unrelated instructions
in the same transaction cannot make a valid payment unverifiable. The scanner
uses the same instruction list, skips other projects' instructions, processes
at most 100 transactions per run, and atomically checkpoints each verified chunk.
Backward discovery pages persist across runs, so a large backlog does not reset
discovery to the newest signature. Each reviewed configuration includes owner,
identity authority at activation, rotation delay, fee recipient, token mint,
network domain, program loader and code digest. The adapter checks every field
against finalized state except the identity authority: after activation it
changes only through the timelocked rotation that the verified program code
enforces, so the immutable manifest keeps verifying through a rotation and
historical receipts stay verifiable.
For the upgradeable loader, `codeSha256` hashes every byte after the fixed
45-byte ProgramData header, including allocation padding. `upgradeAuthority`
must match the finalized loader state, including `null` for an immutable program.
On mainnet the adapter and manifest schema require `null`: a retained upgrade key
could replace the program, empty vaults, and restore the reviewed bytes.
Classic immutable BPF loader deployments hash their complete executable data.
The deploy script prints separate compiled and deployed hashes; they need not match
when ProgramData reserves additional zero-filled capacity.

The shared service in `workers/payment-executor/solana.ts` validates the current
SQLite/D1 wallet consent and the finalized deployment before signing. Each role
holds a different test signer. The gas signer cannot be the owner or identity
signer. It creates recipient and fee ATAs idempotently and pays the exact bound
version. The identity role prepares a `bind_wallet` transaction that names the
destination as a second required signer, signs its half, journals the bytes
and returns them; the contributor's wallet signs the same bytes and the
completed transaction is broadcast through the identity role, which checks
both signatures against the journaled message first. The transaction must be
completed within its blockhash lifetime, so the identity role never binds
unattended. The account API reaches the identity role through a service
binding: a signed-in contributor calls `POST /wallets/solana-bind/prepare` with
the award ID to receive the half-signed transaction for their current claim
and payout attempt, signs it in the wallet, and returns it with
`POST /wallets/solana-bind/complete`. The identity role stores the claim digest
in the wallet binding. The executor compares both delays with the time of the
latest confirmed block, not the host clock, so a fast host clock cannot submit
a payment the program must reject. A
successor needs the shared 24-hour signed-lineage policy and reconciliation of
older attempts. The program itself never authorizes GitHub sessions.

The durable journal stores signed transaction bytes before sending them. Repeated
requests reuse that signature. A missing receipt cannot authorize another signature
until finalized block height passes the stored expiry, history still has no receipt,
and finalized obligations/bindings are reconciled. Replacement uses an atomic
comparison with the exact expired attempt, so concurrent workers cannot replace a
still-valid transaction. Retired unsigned attempts are rejected before signing.

`owner-plan.mjs` creates unsigned initialize/deposit/commit/veto/withdraw,
migrate, propose-rotation and cancel-rotation transactions; a veto may name an
unpaid award (`obligationId`) to use its commit-delay window.

### Project account migration

The rotation fields (`pending_identity_authority`, `rotation_effective_at`,
`rotation_confirmed`, `rotation_delay`) are appended to `Project`, which grows
from 265 to 314 bytes. Borsh keeps every earlier field at its offset. A project
created by an earlier build of this program keeps its 265-byte account after an
upgrade, and Anchor cannot read it, so every instruction on it fails until the
owner runs `migrate_project(rotation_delay)` (owner-plan operation `migrate`).
The instruction accepts only this program's 265-byte project account whose
stored owner signed, tops up rent from the owner, grows the account, sets the
rotation delay within the same bounds as `initialize` and leaves no rotation
pending. A second migration fails. The vault, awards, bindings and reserves are
untouched. Mainnet requires an immutable program, so this path applies to test
deployments upgraded in place; a mainnet layout change is a new deployment.
`test-e2e.sh` preloads a 265-byte project into the validator
(`integration/legacy-project.mjs`) and the owner-plan suite migrates it.
Give it the reviewed input file; private RPC URL, expected genesis and a fresh
blockhash come separately from `SLOP_SOLANA_RPC_URL`, `SLOP_SOLANA_GENESIS`, and
`SLOP_SOLANA_RECENT_BLOCKHASH`. It verifies deployed code and authorities and never
reads keys or sends a transaction. Its output omits the RPC URL. The checked-in
IDL is generated from the program; regenerate it after instruction layout changes.

`bootstrap-linux.sh` installs the pinned Linux x86_64 GitHub Actions toolchain.
It is not a mainnet deployment path. The separate Node SDK package is used only
for local integration and unsigned operator tools. Its upstream dependency audit
has unresolved advisories; lifecycle scripts are disabled and the bigint code
uses its JavaScript implementation. The hosted verifier and signer use the root
Noble dependencies and do not import the Anchor/web3/SPL Node SDK packages.
