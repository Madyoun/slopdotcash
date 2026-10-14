import { isFundingAddress, isSolanaTransactionId } from "./funding-address.mjs";

/**
 * Technical network definitions only. Projects and deployments live in
 * project.json. `family` selects the adapter, executor and scanner
 * implementation; `chain` is the wallet-claim and consent identity. EVM
 * networks also carry the executor gas ceiling (gas units) and the scanner
 * window (blocks per eth_getLogs page, inclusive), which the generated
 * deployment record copies so hosted workers never assume a value.
 */
export const ESCROW_NETWORKS = Object.freeze({
  "base-sepolia": {
    chain: "base",
    family: "evm",
    testnet: true,
    chainId: "84532",
    asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    assetSymbol: "USDC",
    gasCeiling: "500000",
    scanPageBlocks: "2000",
  },
  "base-mainnet": {
    chain: "base",
    family: "evm",
    testnet: false,
    chainId: "8453",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    assetSymbol: "USDC",
    gasCeiling: "500000",
    scanPageBlocks: "2000",
  },
  "solana-devnet": {
    chain: "solana",
    family: "solana",
    testnet: true,
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    assetSymbol: "USDC",
  },
  "solana-testnet": {
    chain: "solana",
    family: "solana",
    testnet: true,
    asset: null,
    assetSymbol: "TEST",
  },
  "solana-mainnet": {
    chain: "solana",
    family: "solana",
    testnet: false,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    assetSymbol: "USDC",
  },
});
/** Chains a policy may name, in registry order; each maps to exactly one family. */
export const ESCROW_CHAINS = Object.freeze([
  ...new Set(Object.values(ESCROW_NETWORKS).map((network) => network.chain)),
]);
export function isEscrowChain(value) {
  return ESCROW_CHAINS.includes(value);
}
/** The execution family of a chain. Unknown chains throw; nothing may default to a family. */
export function chainFamily(chain) {
  const network = Object.values(ESCROW_NETWORKS).find(
    (candidate) => candidate.chain === chain,
  );
  if (!network) throw new TypeError(`Unknown escrow chain: ${String(chain)}`);
  return network.family;
}
/** Chains whose wallets are EVM accounts (personal_sign consent, EIP-712 bindings). */
export const EVM_CHAINS = Object.freeze(
  ESCROW_CHAINS.filter((chain) => chainFamily(chain) === "evm"),
);
/** Production destination bindings activate no sooner than 48 hours. */
export const MIN_PRODUCTION_BINDING_DELAY = 48 * 60 * 60;
/** A proposed Solana identity authority takes effect no sooner than 7 days later; Base fixes 7 days in the factory. */
export const MIN_PRODUCTION_ROTATION_DELAY = 7 * 24 * 60 * 60;
function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== expected.sort().join()
  )
    throw new TypeError("Invalid escrow policy fields");
}
export function assertEscrowPolicy(value) {
  keys(value, [
    "schemaVersion",
    "effectiveCycle",
    "chain",
    "feeBasisPoints",
    "withdrawalFeeBasisPoints",
    "feeMode",
    "deployments",
  ]);
  if (
    value.schemaVersion !== "1" ||
    !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value.effectiveCycle) ||
    !isEscrowChain(value.chain) ||
    value.feeBasisPoints !== 200 ||
    value.withdrawalFeeBasisPoints !== 1000 ||
    value.feeMode !== "deduct-from-gross" ||
    !Array.isArray(value.deployments)
  )
    throw new TypeError("Invalid escrow chain or fee policy");
  const networks = new Set();
  for (const deployment of value.deployments) {
    keys(deployment, [
      "network",
      "vault",
      "programId",
      "upgradeAuthority",
      "projectPda",
      "networkDomain",
      "asset",
      "owner",
      "identityAuthority",
      "feeRecipient",
      "deploymentTransaction",
      "sourceCommit",
      "codeSha256",
      "bindingDelaySeconds",
      "rotationDelaySeconds",
      "factory",
      "factoryCodeSha256",
      "registrar",
    ]);
    const network = ESCROW_NETWORKS[deployment.network];
    if (
      !network ||
      network.chain !== value.chain ||
      networks.has(deployment.network)
    )
      throw new TypeError("A project has one chain and one escrow per network");
    networks.add(deployment.network);
    if (
      ![
        deployment.vault,
        deployment.asset,
        deployment.owner,
        deployment.identityAuthority,
        deployment.feeRecipient,
      ].every((address) => isFundingAddress(value.chain, address))
    )
      throw new TypeError("Invalid escrow address");
    if (
      (network.asset && deployment.asset !== network.asset) ||
      (chainFamily(value.chain) === "evm"
        ? deployment.programId !== null ||
          deployment.upgradeAuthority !== null ||
          deployment.projectPda !== null ||
          deployment.networkDomain !== null ||
          deployment.rotationDelaySeconds !== null ||
          !isFundingAddress(value.chain, deployment.factory) ||
          !isFundingAddress(value.chain, deployment.registrar) ||
          !/^[0-9a-f]{64}$/.test(deployment.factoryCodeSha256)
        : deployment.factory !== null ||
          deployment.factoryCodeSha256 !== null ||
          deployment.registrar !== null ||
          (deployment.upgradeAuthority !== null &&
            !isFundingAddress("solana", deployment.upgradeAuthority)) ||
          !isFundingAddress("solana", deployment.programId) ||
          !isFundingAddress("solana", deployment.projectPda) ||
          !/^[0-9a-f]{64}$/.test(deployment.networkDomain))
    )
      throw new TypeError("Escrow asset or program does not match the network");
    // The owner proposes and the fee recipient confirms a new identity
    // authority; the notice period gives every binding made with a stolen
    // key time to be vetoed. Base fixes 7 days in the factory contract.
    if (
      chainFamily(value.chain) === "solana" &&
      (typeof deployment.rotationDelaySeconds !== "string" ||
        !/^(0|[1-9][0-9]{0,9})$/.test(deployment.rotationDelaySeconds) ||
        (!network.testnet &&
          Number(deployment.rotationDelaySeconds) <
            MIN_PRODUCTION_ROTATION_DELAY))
    )
      throw new TypeError(
        "Escrow rotation delay is missing or below the production minimum",
      );
    if (
      deployment.network === "solana-mainnet" &&
      deployment.upgradeAuthority !== null
    )
      throw new TypeError(
        "Production Solana escrow requires revoked upgrade authority before activation",
      );
    // A new or rotated destination binding waits this long before it can pay,
    // so the owner can cancel a binding made with a stolen identity key.
    if (
      typeof deployment.bindingDelaySeconds !== "string" ||
      !/^(0|[1-9][0-9]{0,9})$/.test(deployment.bindingDelaySeconds) ||
      (!network.testnet &&
        Number(deployment.bindingDelaySeconds) < MIN_PRODUCTION_BINDING_DELAY)
    )
      throw new TypeError(
        "Escrow binding delay is missing or below the production minimum",
      );
    // Three owner vetoes and the last binding's own delay must outlast the
    // rotation notice, so the new authority replaces a stolen key's last
    // binding before it can pay. Base fixes 7 days, under four 48-hour delays.
    if (
      chainFamily(value.chain) === "solana" &&
      Number(deployment.rotationDelaySeconds) >=
        4 * Number(deployment.bindingDelaySeconds)
    )
      throw new TypeError(
        "Escrow rotation delay must be shorter than four binding delays",
      );
    if (
      deployment.owner === deployment.identityAuthority ||
      deployment.vault === deployment.owner ||
      deployment.vault === deployment.feeRecipient ||
      deployment.vault === deployment.identityAuthority ||
      (chainFamily(value.chain) === "evm" &&
        [
          deployment.owner,
          deployment.identityAuthority,
          deployment.feeRecipient,
          deployment.vault,
        ].includes(deployment.registrar))
    )
      throw new TypeError("Escrow authorities must have separate roles");
    if (
      !/^[0-9a-f]{40}$/.test(deployment.sourceCommit) ||
      !/^[0-9a-f]{64}$/.test(deployment.codeSha256) ||
      !(chainFamily(value.chain) === "evm"
        ? /^0x[0-9a-f]{64}$/.test(deployment.deploymentTransaction)
        : isSolanaTransactionId(deployment.deploymentTransaction))
    )
      throw new TypeError(
        "Escrow deployment requires immutable source and transaction evidence",
      );
  }
  return value;
}
export function assertEscrowTransition(previous, next) {
  if (!previous) return;
  if (
    !next ||
    previous.chain !== next.chain ||
    previous.effectiveCycle !== next.effectiveCycle ||
    previous.feeMode !== next.feeMode ||
    previous.feeBasisPoints !== next.feeBasisPoints ||
    previous.withdrawalFeeBasisPoints !== next.withdrawalFeeBasisPoints
  )
    throw new TypeError(
      "An escrow project's settlement chain and fee policy cannot change",
    );
  for (const deployment of previous.deployments) {
    const successor = next.deployments.find(
      (candidate) => candidate.network === deployment.network,
    );
    if (
      !successor ||
      Object.keys(deployment).some((key) => deployment[key] !== successor[key])
    )
      throw new TypeError("Historical escrow deployments are immutable");
  }
}
