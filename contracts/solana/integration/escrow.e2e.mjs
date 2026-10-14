import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import anchor from "@coral-xyz/anchor";
import {
  createAccount,
  createMint,
  freezeAccount,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  thawAccount,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  escrowInvocations,
  solanaAwardId,
  solanaPaymentAdapter,
} from "../.local/adapter.mjs";
import { expectedDeployment } from "./deployment.mjs";

const { AnchorProvider, Program, BN } = anchor;
const provider = AnchorProvider.env();
const payer = provider.wallet.payer;
const program = new Program(
  JSON.parse(readFileSync("target/idl/slop_escrow.json")),
  provider,
);
const hash = (s) => [...createHash("sha256").update(s).digest()];
// A public test cluster keeps accounts between runs; a run salt gives each
// run new project accounts. Local runs leave it empty.
const RUN = process.env.SLOP_E2E_RUN ?? "";
const network = hash("solana:localnet:escrow-v2");
const bn = (x) => new BN(String(x));
const pda = (...seeds) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];
const key = (x) => x.toBuffer();
const seed = (s) => Buffer.from(s);
const actorSeed = (id) => bn(id).toArrayLike(Buffer, "le", 8);
const DELAY = 8;
const ROTATION_DELAY = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The program reads the validator clock, which can lag wall time on a loaded host.
// Wait until the validator clock itself has moved past the binding delay.
const chainTime = async () =>
  provider.connection.getBlockTime(
    await provider.connection.getSlot("confirmed"),
  );
async function activate() {
  const target = (await chainTime()) + DELAY + 2;
  while ((await chainTime()) < target) await sleep(500);
}
const authority = Keypair.generate();
const nextAuthority = Keypair.generate();
// The identity authority in force; the rotation test below moves it to nextAuthority.
let currentAuthority = authority;
const feeOwner = Keypair.generate();
const recipient = Keypair.generate();
const late = Keypair.generate();
let mint, source, feeAccount, destination, lateDestination, project, vault;
// Bindings are per project, so one project's delay, vetoes and payments never
// change another project's binding.
const bindingIn = (projectKey, id) =>
  pda(seed("wallet"), key(projectKey), actorSeed(id));
const binding = (id) => bindingIn(project, id);
const awardOf = (origin) =>
  Buffer.from(
    solanaAwardId(
      project.toBase58(),
      Buffer.from(hash(`source:${origin}`)).toString("hex"),
    ),
    "hex",
  );
const obligation = (id) => pda(seed("award"), key(project), awardOf(id));
// Submission expiry for bind_wallet; the binding itself never expires.
const expiry = () => bn(Math.floor(Date.now() / 1000) + 3600);
// The veto account always follows the stored latest version, whatever version the
// payer names.
async function latestVersion(actor, named) {
  try {
    return (await program.account.walletBinding.fetch(binding(actor))).version;
  } catch {
    return bn(named);
  }
}
async function commit(
  id,
  actor,
  principal,
  origin = id,
  awardId = awardOf(origin),
) {
  return program.methods
    .commit([...awardId], hash(`source:${origin}`), bn(actor), bn(principal))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      vault,
      obligation: pda(seed("award"), key(project), awardId),
      origin: pda(
        seed("origin"),
        key(project),
        Buffer.from(hash(`source:${origin}`)),
      ),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}
// The authority and the destination keypair both sign; the program reads the
// destination from its signer account. `expiresAt` limits submission only.
async function bind(
  actor,
  wallet,
  expected = 0,
  domain = network,
  {
    claim = hash(`claim:${actor}:${expected}`),
    expiresAt = expiry(),
    signer = currentAuthority,
    cosigners = [wallet],
  } = {},
) {
  return program.methods
    .bindWallet(bn(actor), domain, bn(expected), claim, expiresAt)
    .accountsStrict({
      payer: payer.publicKey,
      identityAuthority: signer.publicKey,
      destination: wallet.publicKey,
      project,
      binding: binding(actor),
      systemProgram: SystemProgram.programId,
    })
    .signers([signer, ...cosigners])
    .rpc();
}
const rotation = {
  propose: (next, signer = payer) =>
    program.methods
      .proposeAuthorityRotation(next)
      .accountsStrict({ owner: signer.publicKey, project })
      .signers(signer === payer ? [] : [signer])
      .rpc(),
  confirm: (signer = feeOwner) =>
    program.methods
      .confirmAuthorityRotation()
      .accountsStrict({ feeRecipient: signer.publicKey, project })
      .signers(signer === payer ? [] : [signer])
      .rpc(),
  cancel: (signer = payer) =>
    program.methods
      .cancelAuthorityRotation()
      .accountsStrict({ owner: signer.publicKey, project })
      .signers(signer === payer ? [] : [signer])
      .rpc(),
  execute: () =>
    program.methods
      .executeAuthorityRotation()
      .accountsStrict({ project })
      .rpc(),
};
const veto = (actor, version) =>
  pda(seed("veto"), key(project), actorSeed(actor), actorSeed(version));
async function payInstruction(id, actor, address, version = 1) {
  const latest = await latestVersion(actor, version);
  return program.methods.pay(bn(version)).accountsStrict({
    project,
    obligation: obligation(id),
    binding: binding(actor),
    mint,
    vault,
    destination: address,
    feeAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
    veto: veto(actor, latest),
  });
}
async function pay(id, actor, address, version = 1) {
  return (await payInstruction(id, actor, address, version)).rpc();
}
// `award` names an unpaid award whose commit delay extends the veto window.
function vetoBinding(actor, version, signer = payer, award = null) {
  return program.methods
    .vetoBinding(bn(actor), bn(version))
    .accountsStrict({
      owner: signer.publicKey,
      project,
      binding: binding(actor),
      veto: veto(actor, version),
      obligation: award ? obligation(award) : null,
      systemProgram: SystemProgram.programId,
    })
    .signers(signer === payer ? [] : [signer])
    .rpc();
}
async function parsedTransaction(signature) {
  const response = await fetch(provider.connection.rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        {
          commitment: "finalized",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });
  return (await response.json()).result;
}
function withdraw(amount) {
  return program.methods
    .withdraw(bn(amount))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      vault,
      destination: source,
      feeAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}
const service = (digest) =>
  pda(seed("service"), key(project), Buffer.from(digest));
function chargeService(amount, digest, signer = payer) {
  return program.methods
    .chargeService(bn(amount), digest)
    .accountsStrict({
      owner: signer.publicKey,
      project,
      mint,
      vault,
      feeAccount,
      charge: service(digest),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers(signer === payer ? [] : [signer])
    .rpc();
}
const balance = async (address) =>
  (await getAccount(provider.connection, address)).amount;
test("actual SPL escrow lifecycle, late wallet claim, reserve and authority attacks", async () => {
  mint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    payer.publicKey,
    6,
  );
  source = await createAccount(
    provider.connection,
    payer,
    mint,
    payer.publicKey,
  );
  feeAccount = await createAccount(
    provider.connection,
    payer,
    mint,
    feeOwner.publicKey,
  );
  destination = await createAccount(
    provider.connection,
    payer,
    mint,
    recipient.publicKey,
  );
  lateDestination = await createAccount(
    provider.connection,
    payer,
    mint,
    late.publicKey,
  );
  await mintTo(provider.connection, payer, mint, source, payer, 1_000_000_000n);
  project = pda(
    seed("project"),
    key(payer.publicKey),
    Buffer.from(hash(`project${RUN}`)),
  );
  vault = pda(seed("vault"), key(project));
  await program.methods
    .initialize(
      hash(`project${RUN}`),
      network,
      authority.publicKey,
      feeOwner.publicKey,
      bn(DELAY),
      bn(ROTATION_DELAY),
    )
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await program.methods
    .deposit(bn(1_000_000_000))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      source,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  const firstCommit = await commit("first", 101, 100_000_000);
  await commit("late", 102, 50_000_000);
  assert.equal(
    (await program.account.project.fetch(project)).reserved.toString(),
    "150000000",
  );
  await assert.rejects(withdraw(1_000_000_000), /InsufficientFreeBalance/);
  await assert.rejects(
    commit("overspend", 103, 1_000_000_000),
    /InsufficientFreeBalance/,
  );
  await assert.rejects(
    pay("late", 102, lateDestination),
    /AccountNotInitialized/,
  );
  // Let both awards pass their commit delay so the binding delay is what rejects.
  await activate();
  // The authority alone cannot bind a wallet it does not hold: without the
  // destination's signature the transaction never verifies.
  await assert.rejects(bind(101, recipient, 0, network, { cosigners: [] }));
  // The destination alone cannot bind itself either.
  await assert.rejects(
    bind(101, recipient, 0, network, { signer: recipient, cosigners: [] }),
  );
  await bind(101, recipient);
  await assert.rejects(pay("first", 101, destination), /BindingPending/);
  await activate();
  await assert.rejects(vetoBinding(101, 1), /BindingActive/);
  await assert.rejects(bind(101, late), /StaleBinding/);
  await assert.rejects(bind(102, late, 0, hash("different-network")));
  await assert.rejects(
    pay("first", 101, lateDestination),
    /ConstraintRaw|WrongDestination/,
  );
  // A co-signing wallet with a non-authority signer is still rejected.
  await assert.rejects(bind(101, late, 1, network, { signer: payer }));
  await freezeAccount(provider.connection, payer, destination, mint, payer);
  await assert.rejects(pay("first", 101, destination));
  assert.equal(await balance(feeAccount), 0n);
  assert.equal(
    (await program.account.obligation.fetch(obligation("first"))).paid,
    false,
  );
  await thawAccount(provider.connection, payer, destination, mint, payer);
  const firstPayment = await pay("first", 101, destination);
  assert.equal(await balance(destination), 98_000_000n);
  assert.equal(await balance(feeAccount), 2_000_000n);
  await assert.rejects(pay("first", 101, destination), /AlreadyPaid/);
  await assert.rejects(commit("first", 101, 100_000_000));
  // An award ID that is not bound to this project and source is rejected.
  await assert.rejects(
    commit("forged", 101, 1, "forged", Buffer.from(hash("forged-id"))),
    /InvalidAward/,
  );
  await assert.rejects(
    program.methods
      .withdraw(bn(1))
      .accountsStrict({
        owner: authority.publicKey,
        project,
        mint,
        vault,
        destination: source,
        feeAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc(),
    /ConstraintHasOne/,
  );
  const wrongMint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    null,
    6,
  );
  const wrongDestination = await createAccount(
    provider.connection,
    payer,
    wrongMint,
    late.publicKey,
  );
  await bind(102, late);
  await activate();
  await assert.rejects(
    pay("late", 102, wrongDestination),
    /ConstraintTokenMint|WrongDestination/,
  );
  // PAY-10: the owner pays one Slopbot invoice from free funds only. The 50
  // reserved for actor 102 cannot be charged, and an invoice pays once.
  const invoice = hash("invoice:local:2026-10");
  await assert.rejects(
    chargeService(850_000_001, invoice),
    /InsufficientFreeBalance/,
  );
  await assert.rejects(chargeService(1, Array(32).fill(0)), /InvalidAmount/);
  const stranger = Keypair.generate();
  await sendAndConfirmTransaction(
    provider.connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: stranger.publicKey,
        lamports: 100_000_000,
      }),
    ),
    [payer],
  );
  await assert.rejects(chargeService(1, invoice, stranger), /ConstraintHasOne/);
  await chargeService(20_000_000, invoice);
  assert.equal(await balance(feeAccount), 22_000_000n);
  await assert.rejects(chargeService(20_000_000, invoice));
  const charged = await program.account.serviceCharge.fetch(service(invoice));
  assert.equal(charged.amount.toString(), "20000000");
  assert.equal(await balance(feeAccount), 22_000_000n);
  // Split withdrawals cannot avoid the cumulative 10% charge.
  await withdraw(1);
  await withdraw(829_999_999);
  assert.equal(await balance(source), 747_000_000n);
  assert.equal(await balance(feeAccount), 105_000_000n);
  await assert.rejects(withdraw(1), /InsufficientFreeBalance/);
  // A stolen authority key rebinds actor 102 to a thief, who must expose a
  // wallet by co-signing. Only the owner can veto it, and only while it is
  // pending; the vetoed version never pays.
  const thief = Keypair.generate();
  const thiefDestination = await createAccount(
    provider.connection,
    payer,
    mint,
    thief.publicKey,
  );
  await bind(102, thief, 1);
  // Fund the identity key so the owner check, not rent, rejects its veto.
  await sendAndConfirmTransaction(
    provider.connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: authority.publicKey,
        lamports: 100_000_000,
      }),
    ),
    [payer],
  );
  await assert.rejects(vetoBinding(102, 2, authority), /ConstraintHasOne/);
  await vetoBinding(102, 2);
  await activate();
  await assert.rejects(pay("late", 102, thiefDestination, 2), /BindingVetoed/);
  assert.equal(await balance(thiefDestination), 0n);
  await bind(102, recipient, 2);
  // Actor 102 has never been paid, so nothing pays while version 3 is pending.
  await assert.rejects(pay("late", 102, destination, 2), /BindingPending/);
  await activate();
  await assert.rejects(pay("late", 102, destination, 2), /StaleBinding/);
  // A third party pays with unrelated token movements in the same transaction.
  // The adapter must still verify this payment from its own instruction.
  const polluted = await sendAndConfirmTransaction(
    provider.connection,
    new Transaction().add(
      await (await payInstruction("late", 102, destination, 3)).instruction(),
      (await import("@solana/spl-token")).createTransferInstruction(
        source,
        destination,
        payer.publicKey,
        1n,
      ),
    ),
    [payer],
  );
  assert.equal(await balance(destination), 147_000_001n);
  assert.equal(await balance(feeAccount), 106_000_000n);
  assert.equal(await balance(vault), 0n);
  const state = await program.account.project.fetch(project);
  assert.equal(state.reserved.toString(), "0");
  assert.equal(state.paid.toString(), "147000000");
  assert.equal(state.payoutFees.toString(), "3000000");
  assert.equal(state.withdrawalFees.toString(), "83000000");
  assert.equal(state.serviceFees.toString(), "20000000");
  assert.equal(
    (await balance(source)) +
      (await balance(destination)) +
      (await balance(feeAccount)) +
      (await balance(vault)),
    1_000_000_000n,
  );
  await provider.connection.confirmTransaction(firstPayment, "finalized");
  await provider.connection.confirmTransaction(polluted, "finalized");
  const evidence = {
    programId: program.programId.toBase58(),
    genesisHash: await provider.connection.getGenesisHash(),
    signature: firstPayment,
    project: project.toBase58(),
    awardId: awardOf("first").toString("hex"),
    sourceDigest: Buffer.from(hash("source:first")).toString("hex"),
    actorId: 101,
    gross: "100000000",
    principal: "98000000",
    fee: "2000000",
    walletVersion: 1,
    destinationOwner: recipient.publicKey.toBase58(),
    destinationAccount: destination.toBase58(),
    vault: vault.toBase58(),
    feeAccount: feeAccount.toBase58(),
    mint: mint.toBase58(),
    network: Buffer.from(network).toString("hex"),
  };
  const workerAdapter = solanaPaymentAdapter({
    rpcUrl: provider.connection.rpcEndpoint,
    genesisHash: evidence.genesisHash,
    programId: evidence.programId,
    projectPda: evidence.project,
    projectId: "local-project",
    network: "solana:localnet",
    networkDomain: evidence.network,
    vault: evidence.vault,
    mint: evidence.mint,
    owner: payer.publicKey.toBase58(),
    identityAuthority: authority.publicKey.toBase58(),
    feeRecipient: feeOwner.publicKey.toBase58(),
    ...expectedDeployment,
    bindingDelaySeconds: String(DELAY),
    rotationDelaySeconds: String(ROTATION_DELAY),
  });
  for (const [signature, kind] of [
    [firstCommit, "reserved"],
    [firstPayment, "paid"],
  ]) {
    const [invocation] = escrowInvocations(
      await parsedTransaction(signature),
      evidence.programId,
    );
    const input = {
      transactionId: signature,
      eventIndex: invocation.index,
      kind,
      obligationId: evidence.awardId,
    };
    const normalized = await workerAdapter.verifyFinalized(input);
    assert.equal(normalized.grossMicro, "100000000");
    assert.equal(normalized.netMicro, "98000000");
    assert.equal(normalized.githubUserId, "101");
    if (kind === "paid")
      assert.equal(normalized.destination, recipient.publicKey.toBase58());
    await assert.rejects(
      workerAdapter.verifyFinalized({
        ...input,
        eventIndex: invocation.index + 1,
      }),
      /Exact escrow instruction/,
    );
  }
  const [pollutedPay] = escrowInvocations(
    await parsedTransaction(polluted),
    evidence.programId,
  );
  const pollutedEvidence = await workerAdapter.verifyFinalized({
    transactionId: polluted,
    eventIndex: pollutedPay.index,
    kind: "paid",
    obligationId: awardOf("late").toString("hex"),
  });
  assert.equal(pollutedEvidence.netMicro, "49000000");
  assert.equal(pollutedEvidence.destination, recipient.publicKey.toBase58());
  await mintTo(provider.connection, payer, mint, vault, payer, 1_000_000n);
  await assert.rejects(withdraw(1), /InsufficientFreeBalance/);
  await assert.rejects(
    commit("unsolicited", 105, 1),
    /InsufficientFreeBalance/,
  );
  assert.equal(await balance(vault), 1_000_000n);
  // Identity authority rotation: the owner proposes, the fee recipient
  // confirms, anyone executes after the delay, and the current authority has
  // no instruction that stops it. Existing bindings survive the rotation.
  await mintTo(provider.connection, payer, mint, source, payer, 20_000_000n);
  await program.methods
    .deposit(bn(20_000_000))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      source,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  await commit("again", 101, 5_000_000);
  await commit("rotated", 104, 10_000_000);
  await assert.rejects(rotation.execute(), /NoRotationPending/);
  await assert.rejects(rotation.confirm(), /NoRotationPending/);
  await assert.rejects(rotation.cancel(), /NoRotationPending/);
  await assert.rejects(rotation.propose(payer.publicKey), /InvalidIdentity/);
  await assert.rejects(rotation.propose(feeOwner.publicKey), /InvalidIdentity/);
  await assert.rejects(
    rotation.propose(authority.publicKey),
    /InvalidIdentity/,
  );
  await assert.rejects(
    rotation.propose(nextAuthority.publicKey, authority),
    /ConstraintHasOne/,
  );
  await rotation.propose(nextAuthority.publicKey);
  let rotated = await program.account.project.fetch(project);
  assert.equal(
    rotated.pendingIdentityAuthority.toBase58(),
    nextAuthority.publicKey.toBase58(),
  );
  assert.equal(rotated.rotationConfirmed, false);
  await assert.rejects(
    rotation.propose(Keypair.generate().publicKey),
    /RotationPending/,
  );
  await assert.rejects(rotation.execute(), /RotationUnconfirmed/);
  await assert.rejects(rotation.confirm(authority), /ConstraintHasOne/);
  await rotation.cancel();
  await assert.rejects(rotation.execute(), /NoRotationPending/);
  await rotation.propose(nextAuthority.publicKey);
  await rotation.confirm();
  await assert.rejects(rotation.confirm(), /RotationConfirmed/);
  await assert.rejects(rotation.execute(), /RotationNotReady/);
  // The current authority still binds while the proposal waits.
  await bind(104, late);
  await sleep((ROTATION_DELAY + 2) * 1000);
  await rotation.execute();
  rotated = await program.account.project.fetch(project);
  assert.equal(
    rotated.identityAuthority.toBase58(),
    nextAuthority.publicKey.toBase58(),
  );
  assert.equal(
    rotated.pendingIdentityAuthority.toBase58(),
    SystemProgram.programId.toBase58(),
  );
  currentAuthority = nextAuthority;
  await assert.rejects(
    bind(104, late, 1, network, { signer: authority }),
    /ConstraintHasOne/,
  );
  // Bindings made before the rotation keep paying: actor 101 through its
  // active version 1, actor 104 through the version bound during the window.
  await activate();
  await pay("again", 101, destination, 1);
  assert.equal(await balance(destination), 151_900_001n);
  await activate();
  await pay("rotated", 104, lateDestination, 1);
  assert.equal(await balance(lateDestination), 9_800_000n);
  // The new authority binds the next version at the same PDA.
  await bind(104, recipient, 1, network, { signer: nextAuthority });
  assert.equal(
    (
      await program.account.walletBinding.fetch(binding(104))
    ).version.toString(),
    "2",
  );
});

// Binding lifecycle after the 12 October 2026 review (M-1, M-2, L-1 to L-5).
test("commit delay, rotation freezes the earlier wallet, veto cap, bounded delay, project-scoped bindings, bind and fee checks", async () => {
  const ata = async (owner) =>
    createAccount(provider.connection, payer, mint, owner);
  const walletA = Keypair.generate(),
    walletB = Keypair.generate(),
    walletC = Keypair.generate(),
    walletD = Keypair.generate();
  const [ataA, ataB, ataC, ataD] = await Promise.all(
    [walletA, walletB, walletC, walletD].map((k) => ata(k.publicKey)),
  );
  await mintTo(provider.connection, payer, mint, source, payer, 100_000_000n);
  await program.methods
    .deposit(bn(100_000_000))
    .accountsStrict({
      owner: payer.publicKey,
      project,
      mint,
      source,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  // M-1: a binding armed before any award pays only after the award's own delay, and
  // the owner can veto it inside that window by naming the unpaid award.
  await bind(201, walletA);
  await activate();
  await commit("m1", 201, 10_000_000);
  await assert.rejects(pay("m1", 201, ataA), /AwardPending/);
  await assert.rejects(vetoBinding(201, 1), /BindingActive/);
  await vetoBinding(201, 1, payer, "m1");
  await activate();
  await assert.rejects(pay("m1", 201, ataA), /BindingVetoed/);
  assert.equal(await balance(ataA), 0n);
  await bind(201, walletA, 1);
  await activate();
  await pay("m1", 201, ataA, 2);
  assert.equal(await balance(ataA), 9_800_000n);
  // A binding that has paid cannot be vetoed, even while a new award is in its window.
  await commit("m1b", 201, 1_000_000);
  await assert.rejects(vetoBinding(201, 2, payer, "m1b"), /BindingActive/);
  let state201 = await program.account.walletBinding.fetch(binding(201));
  assert.equal(state201.paidVersion.toString(), "2");
  assert.equal(state201.vetoCount, 0);
  // M-2: while a rotation waits out its delay, and after the owner vetoes it, no
  // payment goes to the earlier wallet. A rotation away from a compromised wallet
  // therefore freezes payment to it at once.
  await commit("m2", 201, 10_000_000);
  await activate();
  await bind(201, walletB, 2);
  await assert.rejects(pay("m2", 201, ataB, 3), /BindingPending/);
  await assert.rejects(pay("m2", 201, ataA, 2), /BindingPending/);
  await vetoBinding(201, 3);
  await activate();
  await assert.rejects(pay("m2", 201, ataB, 3), /BindingVetoed/);
  await assert.rejects(pay("m2", 201, ataA, 2), /BindingVetoed/);
  // The veto cap applies between payments too: after the paid version, the owner
  // can veto three rotations, and the fourth pays once its delay passes.
  await bind(201, walletB, 3);
  await vetoBinding(201, 4);
  await bind(201, walletB, 4);
  await vetoBinding(201, 5);
  await bind(201, walletB, 5);
  await assert.rejects(vetoBinding(201, 6), /VetoLimit/);
  await activate();
  await assert.rejects(pay("m2", 201, ataA, 2), /StaleBinding/);
  await pay("m2", 201, ataB, 6);
  await pay("m1b", 201, ataB, 6);
  assert.equal(await balance(ataA), 9_800_000n);
  assert.equal(await balance(ataB), 10_780_000n);
  state201 = await program.account.walletBinding.fetch(binding(201));
  assert.equal(state201.paidVersion.toString(), "6");
  assert.equal(state201.vetoCount, 0);
  // Veto cap: before the actor's first payment the owner gets three vetoes.
  await commit("c1", 202, 10_000_000);
  for (let version = 1; version <= 3; version++) {
    await bind(202, walletC, version - 1);
    await vetoBinding(202, version);
  }
  assert.equal(
    (await program.account.walletBinding.fetch(binding(202))).vetoCount,
    3,
  );
  await bind(202, walletC, 3);
  await assert.rejects(vetoBinding(202, 4), /VetoLimit/);
  await activate();
  await pay("c1", 202, ataC, 4);
  assert.equal(await balance(ataC), 9_800_000n);
  // L-4: bind_wallet rejects the project and vault PDAs, a zero claim digest and an
  // expired submission.
  // A PDA cannot co-sign, so the project and vault addresses never bind.
  await assert.rejects(
    bind(203, { publicKey: project }, 0, network, { cosigners: [] }),
  );
  await assert.rejects(
    bind(203, { publicKey: vault }, 0, network, { cosigners: [] }),
  );
  await assert.rejects(
    bind(203, walletD, 0, network, { claim: Array(32).fill(0) }),
    /InvalidIdentity/,
  );
  await assert.rejects(
    bind(203, walletD, 0, network, { expiresAt: bn(1) }),
    /BindingExpired/,
  );
  // L-2: a 49-unit award has a zero fee, so a frozen fee account does not stop it.
  await commit("zero-fee", 204, 49);
  await bind(204, walletD);
  await activate();
  await freezeAccount(provider.connection, payer, feeAccount, mint, payer);
  const zeroFee = await pay("zero-fee", 204, ataD);
  await thawAccount(provider.connection, payer, feeAccount, mint, payer);
  assert.equal(await balance(ataD), 49n);
  await provider.connection.confirmTransaction(zeroFee, "finalized");
  const [zeroFeePay] = escrowInvocations(
    await parsedTransaction(zeroFee),
    program.programId.toBase58(),
  );
  assert.equal(zeroFeePay.children.length, 1);
  const zeroFeeAdapter = solanaPaymentAdapter({
    rpcUrl: provider.connection.rpcEndpoint,
    genesisHash: await provider.connection.getGenesisHash(),
    programId: program.programId.toBase58(),
    projectPda: project.toBase58(),
    projectId: "local-project",
    network: "solana:localnet",
    networkDomain: Buffer.from(network).toString("hex"),
    vault: vault.toBase58(),
    mint: mint.toBase58(),
    owner: payer.publicKey.toBase58(),
    // The authority at activation: verification continues after a rotation.
    identityAuthority: authority.publicKey.toBase58(),
    feeRecipient: feeOwner.publicKey.toBase58(),
    ...expectedDeployment,
    bindingDelaySeconds: String(DELAY),
    rotationDelaySeconds: String(ROTATION_DELAY),
  });
  const zeroFeeEvidence = await zeroFeeAdapter.verifyFinalized({
    transactionId: zeroFee,
    eventIndex: zeroFeePay.index,
    kind: "paid",
    obligationId: awardOf("zero-fee").toString("hex"),
  });
  assert.equal(zeroFeeEvidence.feeMicro, "0");
  assert.equal(zeroFeeEvidence.netMicro, "49");
  // L-1 and L-3: initialize rejects an out-of-range delay and a fee recipient equal to
  // the owner or the project.
  const initialize = (
    delay,
    feeRecipient = feeOwner.publicKey,
    label = "x",
  ) => {
    const id = hash(`bounds:${label}:${delay}${RUN}`);
    const p = pda(seed("project"), key(payer.publicKey), Buffer.from(id));
    return program.methods
      .initialize(
        id,
        network,
        authority.publicKey,
        feeRecipient,
        bn(delay),
        bn(ROTATION_DELAY),
      )
      .accountsStrict({
        owner: payer.publicKey,
        project: p,
        mint,
        vault: pda(seed("vault"), key(p)),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  };
  await assert.rejects(initialize(0), /InvalidDelay/);
  await assert.rejects(initialize(30 * 86400 + 1), /InvalidDelay/);
  await assert.rejects(initialize(DELAY, payer.publicKey), /InvalidIdentity/);
  const selfId = hash(`bounds:self:${DELAY}${RUN}`);
  await assert.rejects(
    initialize(
      DELAY,
      pda(seed("project"), key(payer.publicKey), Buffer.from(selfId)),
      "self",
    ),
    /InvalidIdentity/,
  );
  await initialize(30 * 86400, feeOwner.publicKey, "max");
  // Another project with the same identity authority and network has its own
  // binding account: actor 201's bindings, vetoes and payments here do not exist
  // there, so that project's delay and veto cap start from its own binding.
  await initialize(DELAY, feeOwner.publicKey, "other");
  const other = pda(
    seed("project"),
    key(payer.publicKey),
    Buffer.from(hash(`bounds:other:${DELAY}${RUN}`)),
  );
  assert.notEqual(bindingIn(other, 201).toBase58(), binding(201).toBase58());
  assert.equal(
    await provider.connection.getAccountInfo(bindingIn(other, 201)),
    null,
  );
});
