import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import anchor from "@coral-xyz/anchor";
import { createMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

// Runs only against the deployable build (no `short-delay-for-tests` feature).
const { AnchorProvider, Program, BN } = anchor;
const provider = AnchorProvider.env();
const payer = provider.wallet.payer;
const program = new Program(
  JSON.parse(readFileSync("target/idl/slop_escrow.json")),
  provider,
);
const hash = (s) => [...createHash("sha256").update(s).digest()];
const pda = (...seeds) =>
  PublicKey.findProgramAddressSync(seeds, program.programId)[0];

test("the deployable build rejects a binding delay below one hour", async () => {
  const mint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    null,
    6,
  );
  const initialize = (delay, rotationDelay = 3600) => {
    const id = hash(`production-delay:${delay}:${rotationDelay}`);
    const project = pda(
      Buffer.from("project"),
      payer.publicKey.toBuffer(),
      Buffer.from(id),
    );
    return program.methods
      .initialize(
        id,
        hash("solana:localnet:escrow-v2"),
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
        new BN(delay),
        new BN(rotationDelay),
      )
      .accountsStrict({
        owner: payer.publicKey,
        project,
        mint,
        vault: pda(Buffer.from("vault"), project.toBuffer()),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  };
  await assert.rejects(initialize(1), /InvalidDelay/);
  await assert.rejects(initialize(3599), /InvalidDelay/);
  // The identity authority rotation delay has the same one-hour floor.
  await assert.rejects(initialize(3600, 1), /InvalidDelay/);
  await assert.rejects(initialize(3600, 3599), /InvalidDelay/);
  await initialize(3600);
});
