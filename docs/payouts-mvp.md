# Escrow migration decision and acceptance record

Implementation authority: the maintainer requested the Base/Solana migration and then instructed subagents to implement and test the plan on 6 October 2026. The subsequent explicit fee instruction replaces the initial on-top assumption.

This is a focused implementation addendum to [the canonical PRD](slop-product-requirements.md), requirements WAL-01–05, PAY-01–08 and FND-05, and [MVP-02, MVP-06 and MVP-07](slop-mvp-plan.md). It does not replace the canonical MVP or claim that all of its packages are complete. Donation funding remains disabled until separate on-chain funding classes are implemented and verified.

## Product contract

Projects select one payout chain: Base, Solana or Robinhood Chain (USDG, see [the Robinhood Chain design record](robinhood-chain-escrow-design.md)). The selected chain cannot change while the project's payment history and obligations exist. Network-specific execution lives behind adapters so additional chains can implement the same financial contract.

All new escrow allocations are gross amounts of the project network's stablecoin: USDC on Base and Solana, USDG on Robinhood Chain. Both have six decimals. The fee is deducted: `fee = floor(gross / 50)`, `recipientNet = gross - fee`. A 100-unit allocation reserves 100, transfers 98 to the contributor, and transfers 2 to the fee recipient. Contributor earnings display net. Per-award gross and fee remain inspectable. Monetary arithmetic is integer micro-units (one millionth of one USDC or USDG).

Every return of unused escrow principal incurs a 10% fee, calculated as the difference of cumulative floor-rounded fees. Previously paid awards do not exempt the remaining refund. Funded unpaid awards, including recipients without wallets, are permanently reserved and cannot be reclaimed by the sponsor.

GitHub is the only account login. Immutable numeric actor identity owns each award, not a mutable login name. The backend stores independent append-only Base, Solana and Robinhood Chain wallet claims. A Base claim does not satisfy a Robinhood Chain award, even for the same address, because the consent and binding signatures name the chain. Registering and proving a wallet enables automatic payment of eligible unpaid awards on that chain. A wrong-chain wallet does not satisfy the award.

The project owner authorizes gross awards and unused-fund withdrawals. The identity attester is a Slop-held key with one power: to co-sign an exact actor-to-destination binding that the destination wallet has itself signed over the chain, vault or project, actor, destination, expected version, claim digest and expiry (PAY-05, approved by the repository owner on 14 October 2026). It never chooses an amount, executes a transfer or reaches free or reserved funds. Every binding activates only after the reviewed delay, the project owner can cancel it during that delay, and the key is replaced by a timelocked rotation that the attester cannot block: proposed by the factory registrar on Base and Robinhood Chain, and by the project owner with fee-recipient confirmation on Solana, effective after the reviewed rotation delay (7 days in production). Existing bindings stay valid across a rotation. A separate relayer submits version-bound payments and sponsors gas. Contracts enforce obligations, fees and exact-once payment. No user wallet private key enters the application; the wallet signs in the contributor's own wallet software. `contracts/evm/README.md` and `contracts/solana/README.md` carry the exact rules and the key recovery runbook.

Operator wallet assistance records actor, address, reason and operator identity. It does not silently bypass contributor authorization or mark a payment paid. Only an externally owned account can sign a Base or Robinhood Chain binding and only a keypair can co-sign a Solana binding; contract-wallet possession needs a separate reviewed recovery path, and an off-curve address is not a signature-capable wallet.

## Acceptance

The same real local-chain workflow must pass on EVM, under each EVM network's chain id (Base and Robinhood Chain), and on Solana: deposit 1,000; commit gross awards 100 and 50; pay 98 plus fee 2 to the registered recipient; retain 50 for the walletless recipient; refund free 850 as 765 sponsor plus 85 fee; register the late recipient; pay 49 plus fee 1. Final totals are 147 contributors, 3 payout fees, 765 sponsor returns and 85 withdrawal fees. Repeating requests cannot pay again.

Cover unauthenticated registration, actor mismatch, wallet change/payment races, wrong asset/network/vault, stale bindings, failed token transfers, duplicate origins, retry after ambiguous submission, queue restart, finality, and counter reconciliation. Contract execution, database integration and browser interaction are separate evidence boundaries. Seeded local identity is not proof of live GitHub OAuth.

Before public test deployment, record exact build hashes, contract/program identities, isolated signer roles, test assets, network identity and authority readback. Base Sepolia and Solana Devnet validate real test-USDC integration. Solana Testnet uses a separately labeled test mint because no Circle Testnet USDC is listed. Robinhood Chain Testnet uses Paxos test USDG (`0x7e955252e15c84f5768b83c41a71f9eba181802f`); the testnet runbook must establish its supply route.

Every escrow policy records an immutable effective UTC cycle. Earlier cycles retain their original gross display and legacy fee/verification rules. No existing project or historical payout is automatically migrated. Its owner must select the chain, deploy and fund the approved escrow, reconcile legacy attempts and adopt the reviewed deployment in the canonical project manifest. Preserve all historical fee policies and paid receipts. The legacy payout path must remain disabled for a migrated project.

## Delivery sequence

1. Contracts and matching accounting invariants.
2. Existing GitHub session and wallet-registry integration; durable outbox and chain evidence.
3. Identity-binding and payment execution service, with restart-safe transaction journals.
4. Contributor earnings and wallet UX; project chain selection and reviewed deployment registry.
5. Full local validator and browser validation, then independent review.
6. Protected, isolated testnet provisioning and public-chain evidence.
7. Reviewed legacy migration and separately authorized production activation.

See [the full architecture and test plan](base-solana-payout-plan.md). A source implementation, local test, merged PR, or deployment alone does not prove the next boundary.
