// Family and registry invariants for the escrow network registry. The
// registry is the only place a chain maps to an execution family; nothing
// downstream may infer "EVM" from the word "base".
import { describe, expect, test } from "bun:test";
import {
  assertEscrowPolicy,
  chainFamily,
  ESCROW_CHAINS,
  ESCROW_NETWORKS,
  EVM_CHAINS,
  isEscrowChain,
} from "../../src/lib/escrow-policy.mjs";

const evmDeployment = {
  network: "base-sepolia",
  vault: "0x1000000000000000000000000000000000000001",
  programId: null,
  upgradeAuthority: null,
  projectPda: null,
  networkDomain: null,
  asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  owner: "0x2000000000000000000000000000000000000002",
  identityAuthority: "0x3000000000000000000000000000000000000003",
  feeRecipient: "0x4000000000000000000000000000000000000004",
  deploymentTransaction: `0x${"ab".repeat(32)}`,
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  codeSha256: "ab".repeat(32),
  bindingDelaySeconds: "60",
  rotationDelaySeconds: null,
  factory: "0x5000000000000000000000000000000000000005",
  factoryCodeSha256: "cd".repeat(32),
  registrar: "0x6000000000000000000000000000000000000006",
};
const solanaDeployment = {
  network: "solana-devnet",
  vault: "So11111111111111111111111111111111111111112",
  programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  upgradeAuthority: null,
  projectPda: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  networkDomain: "cd".repeat(32),
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  owner: "11111111111111111111111111111111",
  identityAuthority: "SysvarRent111111111111111111111111111111111",
  feeRecipient: "SysvarC1ock11111111111111111111111111111111",
  deploymentTransaction: "1".repeat(64),
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  codeSha256: "ab".repeat(32),
  bindingDelaySeconds: "60",
  rotationDelaySeconds: "60",
  factory: null,
  factoryCodeSha256: null,
  registrar: null,
};
const policy = (chain: string, deployment: object) => ({
  schemaVersion: "1",
  effectiveCycle: "2026-11",
  chain,
  feeBasisPoints: 200,
  withdrawalFeeBasisPoints: 1000,
  feeMode: "deduct-from-gross",
  deployments: [deployment],
});

describe("escrow chain families", () => {
  test("each chain maps to exactly one family", () => {
    expect([...ESCROW_CHAINS]).toEqual(["base", "solana"]);
    expect(chainFamily("base")).toBe("evm");
    expect(chainFamily("solana")).toBe("solana");
    expect([...EVM_CHAINS]).toEqual(["base"]);
  });
  test("an unknown chain is rejected, never defaulted to a family", () => {
    expect(isEscrowChain("evm")).toBe(false);
    expect(isEscrowChain("BASE")).toBe(false);
    expect(isEscrowChain(undefined)).toBe(false);
    expect(() => chainFamily("evm")).toThrow(TypeError);
    expect(() => chainFamily("BASE")).toThrow(TypeError);
  });
  test("EVM networks carry chain id, gas ceiling and scan page; Solana networks carry none", () => {
    for (const network of Object.values(ESCROW_NETWORKS)) {
      expect(chainFamily(network.chain)).toBe(network.family);
      expect(typeof network.assetSymbol).toBe("string");
      expect(network.assetSymbol.length).toBeGreaterThan(0);
      if (network.family === "evm") {
        expect(network.chainId).toMatch(/^[1-9][0-9]*$/);
        expect(network.gasCeiling).toMatch(/^[1-9][0-9]*$/);
        expect(network.scanPageBlocks).toMatch(/^[1-9][0-9]*$/);
      } else {
        expect(network.chainId).toBeUndefined();
        expect(network.gasCeiling).toBeUndefined();
        expect(network.scanPageBlocks).toBeUndefined();
      }
    }
  });
  test("Base keeps its executor and scanner limits", () => {
    for (const name of ["base-sepolia", "base-mainnet"] as const) {
      expect(ESCROW_NETWORKS[name].gasCeiling).toBe("500000");
      expect(ESCROW_NETWORKS[name].scanPageBlocks).toBe("2000");
      expect(ESCROW_NETWORKS[name].assetSymbol).toBe("USDC");
    }
    expect(ESCROW_NETWORKS["solana-testnet"].assetSymbol).toBe("TEST");
  });
});

describe("assertEscrowPolicy after the family refactor", () => {
  test("accepts a reviewed Base deployment", () => {
    expect(() =>
      assertEscrowPolicy(policy("base", evmDeployment)),
    ).not.toThrow();
  });
  test("accepts a reviewed Solana deployment", () => {
    expect(() =>
      assertEscrowPolicy(policy("solana", solanaDeployment)),
    ).not.toThrow();
  });
  test("rejects a family name used as a chain", () => {
    expect(() => assertEscrowPolicy(policy("evm", evmDeployment))).toThrow(
      /Invalid escrow chain/,
    );
  });
  test("rejects Solana-only fields on an EVM deployment", () => {
    expect(() =>
      assertEscrowPolicy(
        policy("base", { ...evmDeployment, programId: evmDeployment.vault }),
      ),
    ).toThrow(/does not match the network/);
  });
  test("rejects an EVM transaction hash on a Solana deployment", () => {
    expect(() =>
      assertEscrowPolicy(
        policy("solana", {
          ...solanaDeployment,
          deploymentTransaction: `0x${"ab".repeat(32)}`,
        }),
      ),
    ).toThrow(/immutable source and transaction evidence/);
  });
});
