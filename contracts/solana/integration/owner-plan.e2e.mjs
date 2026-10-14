import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import anchor from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { awardIdFor, ownerPlan } from "../scripts/owner-plan.mjs";
import { expectedDeployment } from "./deployment.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
test("unsigned owner plans initialize, fund, reserve, veto and withdraw on actual SPL program", {
  timeout: 480000,
}, async () => {
  const provider = anchor.AnchorProvider.env(),
    owner = provider.wallet.payer;
  const identity = Keypair.generate(),
    fees = Keypair.generate(),
    mint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      6,
    );
  const source = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      owner,
      mint,
      owner.publicKey,
    ),
    // The withdraw plan must create the fee recipient's account itself.
    feeAccount = {
      address: getAssociatedTokenAddressSync(mint, fees.publicKey),
    };
  await mintTo(
    provider.connection,
    owner,
    mint,
    source.address,
    owner,
    100_000_000n,
  );
  const programId = new PublicKey(
      JSON.parse(readFileSync("idl/slop_escrow.json")).address,
    ),
    projectDigest = hash("owner-plan-project");
  const project = PublicKey.findProgramAddressSync(
    [
      Buffer.from("project"),
      owner.publicKey.toBuffer(),
      Buffer.from(projectDigest, "hex"),
    ],
    programId,
  )[0];
  const vault = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), project.toBuffer()],
    programId,
  )[0];
  const deployment = {
    programId: programId.toBase58(),
    projectPda: project.toBase58(),
    networkDomain: hash("owner-plan-domain"),
    vault: vault.toBase58(),
    asset: mint.toBase58(),
    owner: owner.publicKey.toBase58(),
    identityAuthority: identity.publicKey.toBase58(),
    feeRecipient: fees.publicKey.toBase58(),
    ...expectedDeployment,
    bindingDelaySeconds: "3600",
    rotationDelaySeconds: "604800",
  };
  const expectedGenesis = await provider.connection.getGenesisHash();
  async function execute(operation, extra) {
    const block = await provider.connection.getLatestBlockhash("finalized");
    const plan = await ownerPlan(
      { deployment, operation, ...extra },
      {
        rpcUrl: provider.connection.rpcEndpoint,
        expectedGenesis,
        recentBlockhash: block.blockhash,
      },
    );
    assert.equal(
      JSON.stringify(plan).includes(provider.connection.rpcEndpoint),
      false,
    );
    const transaction = Transaction.from(
      Buffer.from(plan.transactionBase64, "base64"),
    );
    assert.equal(
      transaction.signatures.every((s) => s.signature === null),
      true,
    );
    const signature = await sendAndConfirmTransaction(
      provider.connection,
      transaction,
      [owner],
    );
    await provider.connection.confirmTransaction(signature, "finalized");
  }
  await execute("initialize", { projectDigest });
  await execute("deposit", { grossMicro: "100000000" });
  const sourceDigest = hash("owner-plan-source");
  await assert.rejects(
    execute("commit", {
      awards: [
        {
          awardId: hash("owner-plan-award"),
          sourceDigest,
          githubUserId: "999",
          grossMicro: "25000000",
        },
      ],
    }),
    /not bound to this project/,
  );
  await execute("commit", {
    awards: [
      {
        awardId: Buffer.from(
          awardIdFor(project, Buffer.from(sourceDigest, "hex")),
        ).toString("hex"),
        sourceDigest,
        githubUserId: "999",
        grossMicro: "25000000",
      },
    ],
  });
  // The identity authority and the destination wallet bind actor 999; the
  // owner vetoes it while pending.
  const program = new anchor.Program(
    JSON.parse(readFileSync("idl/slop_escrow.json")),
    provider,
  );
  const actor = new anchor.BN(999).toArrayLike(Buffer, "le", 8),
    version = new anchor.BN(1).toArrayLike(Buffer, "le", 8),
    wallet = Keypair.generate();
  await program.methods
    .bindWallet(
      new anchor.BN(999),
      [...Buffer.from(deployment.networkDomain, "hex")],
      new anchor.BN(0),
      [...Buffer.from(hash("owner-plan-claim"), "hex")],
      new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
    )
    .accountsStrict({
      payer: owner.publicKey,
      identityAuthority: identity.publicKey,
      destination: wallet.publicKey,
      project,
      binding: PublicKey.findProgramAddressSync(
        [Buffer.from("wallet"), project.toBuffer(), actor],
        programId,
      )[0],
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([identity, wallet])
    .rpc();
  await execute("veto", { githubUserId: "999", bindingVersion: "1" });
  assert.ok(
    await provider.connection.getAccountInfo(
      PublicKey.findProgramAddressSync(
        [Buffer.from("veto"), project.toBuffer(), actor, version],
        programId,
      )[0],
      "finalized",
    ),
  );
  await execute("withdraw", { grossMicro: "75000000" });
  assert.equal(
    (await getAccount(provider.connection, vault)).amount,
    25_000_000n,
  );
  assert.equal(
    (await getAccount(provider.connection, source.address)).amount,
    67_500_000n,
  );
  assert.equal(
    (await getAccount(provider.connection, feeAccount.address)).amount,
    7_500_000n,
  );
});

// The validator preloads a 265-byte project account from before the identity
// authority rotation fields (integration/legacy-project.mjs). Anchor cannot read
// it until the owner grows it with migrate_project.
test("owner plan migrates a legacy project account, then proposes and cancels a rotation", {
  timeout: 120000,
}, async () => {
  const provider = anchor.AnchorProvider.env(),
    payer = provider.wallet.payer;
  const legacy = JSON.parse(readFileSync(".local/legacy-project.json"));
  const owner = Keypair.fromSecretKey(Uint8Array.from(legacy.owner));
  await sendAndConfirmTransaction(
    provider.connection,
    new Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: owner.publicKey,
        lamports: 1_000_000_000,
      }),
    ),
    [payer],
  );
  const program = new anchor.Program(
    JSON.parse(readFileSync("idl/slop_escrow.json")),
    provider,
  );
  const project = new PublicKey(legacy.project);
  const deployment = {
    programId: program.programId.toBase58(),
    projectPda: legacy.project,
    networkDomain: legacy.networkDomain,
    vault: PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), project.toBuffer()],
      program.programId,
    )[0].toBase58(),
    asset: legacy.mint,
    owner: owner.publicKey.toBase58(),
    identityAuthority: legacy.identityAuthority,
    feeRecipient: legacy.feeRecipient,
    ...expectedDeployment,
    bindingDelaySeconds: "3600",
    rotationDelaySeconds: "604800",
  };
  const expectedGenesis = await provider.connection.getGenesisHash();
  const plan = async (operation, extra = {}) =>
    ownerPlan(
      { deployment, operation, ...extra },
      {
        rpcUrl: provider.connection.rpcEndpoint,
        expectedGenesis,
        recentBlockhash: (
          await provider.connection.getLatestBlockhash("finalized")
        ).blockhash,
      },
    );
  async function execute(operation, extra) {
    const transaction = Transaction.from(
      Buffer.from((await plan(operation, extra)).transactionBase64, "base64"),
    );
    await provider.connection.confirmTransaction(
      await sendAndConfirmTransaction(provider.connection, transaction, [
        owner,
      ]),
      "finalized",
    );
  }
  const next = Keypair.generate().publicKey;
  const migrate = (signer, rotationDelay) =>
    program.methods
      .migrateProject(new anchor.BN(rotationDelay))
      .accountsStrict({
        owner: signer.publicKey,
        project,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([signer])
      .rpc();
  // Before migration no instruction can read the project.
  assert.equal(
    (await provider.connection.getAccountInfo(project)).data.length,
    265,
  );
  await assert.rejects(
    program.methods
      .proposeAuthorityRotation(next)
      .accountsStrict({ owner: owner.publicKey, project })
      .signers([owner])
      .rpc(),
    /AccountDidNotDeserialize/,
  );
  await assert.rejects(
    plan("propose-rotation", { nextIdentityAuthority: next.toBase58() }),
  );
  // Only the stored owner can migrate, with a rotation delay inside the bounds.
  await assert.rejects(migrate(payer, 604800), /InvalidIdentity/);
  await assert.rejects(migrate(owner, 90 * 86400 + 1), /InvalidDelay/);
  await execute("migrate");
  const migrated = await provider.connection.getAccountInfo(
    project,
    "finalized",
  );
  assert.equal(migrated.data.length, 314);
  assert.ok(
    migrated.lamports >=
      (await provider.connection.getMinimumBalanceForRentExemption(314)),
  );
  const state = await program.account.project.fetch(project, "finalized");
  assert.equal(state.owner.toBase58(), owner.publicKey.toBase58());
  assert.equal(state.identityAuthority.toBase58(), legacy.identityAuthority);
  assert.equal(state.feeRecipient.toBase58(), legacy.feeRecipient);
  assert.equal(state.mint.toBase58(), legacy.mint);
  assert.equal(state.bindingDelay.toString(), "3600");
  assert.equal(state.rotationDelay.toString(), "604800");
  assert.equal(
    state.pendingIdentityAuthority.toBase58(),
    anchor.web3.SystemProgram.programId.toBase58(),
  );
  assert.equal(state.rotationConfirmed, false);
  // A migrated project cannot be migrated again.
  await assert.rejects(plan("migrate"), /Not a legacy project/);
  await assert.rejects(migrate(owner, 604800), /NotLegacyProject/);
  // The owner's rotation plans now work on the migrated project.
  await execute("propose-rotation", { nextIdentityAuthority: next.toBase58() });
  assert.equal(
    (
      await program.account.project.fetch(project, "finalized")
    ).pendingIdentityAuthority.toBase58(),
    next.toBase58(),
  );
  await execute("cancel-rotation");
  assert.equal(
    (
      await program.account.project.fetch(project, "finalized")
    ).pendingIdentityAuthority.toBase58(),
    anchor.web3.SystemProgram.programId.toBase58(),
  );
});
