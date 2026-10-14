import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
/** Finalized escrow events from a reviewed deployment. The configured RPC and vault are trust roots. */
export interface EvmEscrowConfig {
  rpcUrl: string;
  chainId: bigint;
  vault: string;
  asset: string;
  owner: string;
  /** The identity authority at activation. Later authorities come only from the factory's
   * registrar-proposed 7-day timelock, so it is not compared with live state. */
  identityAuthority: string;
  feeRecipient: string;
  codeSha256: string;
  /** Reviewed delay, in seconds, before a destination binding can pay. */
  bindingDelaySeconds: string;
  /** The EscrowFactory that created the vault and holds the identity authority. */
  factory: string;
  /** sha256 of the factory's runtime code: its rotation rules and 7-day delay. */
  factoryCodeSha256: string;
  /** The factory registrar, the only account that can propose an authority rotation. */
  registrar: string;
}

export interface FinalizedEscrowEvent {
  transactionId: string;
  eventIndex: number;
  blockId: string;
  obligationId: string;
  githubUserId: string;
  grossMicro: string;
  netMicro: string;
  feeMicro: string;
  sourceDigest?: string;
  destination?: string;
  bindingVersion?: string;
}

const RESERVE_TOPIC =
  "0xd42548deb9ef20b582fe02f194f3c5e39fd0b7d1803321cd197e4ce48c30a857";
const PAYMENT_TOPIC =
  "0x4bf296cb04d665f3fe904ce30894876ea577c828bbc117e8bacad4c4bcb757f7";
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const U64 = (1n << 64n) - 1n;

type RpcObject = Record<string, unknown>;
function object(value: unknown): RpcObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid RPC object");
  }
  return value as RpcObject;
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !QUANTITY.test(value)) {
    throw new Error("Invalid RPC quantity");
  }
  return BigInt(value);
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new Error("Invalid hash");
  }
  return value.toLowerCase();
}
function uint64(word: string): bigint {
  const value = BigInt(`0x${word}`);
  if (value > U64) throw new Error("Invalid uint64 event field");
  return value;
}
async function rpc(config: EvmEscrowConfig, method: string, params: unknown[]) {
  const response = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RPC HTTP failure: ${response.status}`);
  const body = object(await response.json());
  if (body.error || body.id !== 1 || !("result" in body)) {
    throw new Error("RPC request failed");
  }
  return body.result;
}

/** The reviewed factory rotates the identity authority only after this notice period. */
export const EVM_AUTHORITY_ROTATION_DELAY = 7n * 24n * 60n * 60n;
async function runtimeSha256(
  config: EvmEscrowConfig,
  address: string,
  blockTag: unknown,
) {
  const code = await rpc(config, "eth_getCode", [address, blockTag]);
  if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code))
    throw new Error("Escrow runtime code unavailable");
  const bytes = Uint8Array.from(code.slice(2).match(/../g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
  return Array.from(sha256(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function getter(
  config: EvmEscrowConfig,
  to: string,
  signature: string,
  blockTag: unknown,
  argument = "",
) {
  const selector = Array.from(
    keccak_256(new TextEncoder().encode(signature)).slice(0, 4),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const value = await rpc(config, "eth_call", [
    { to, data: `0x${selector}${argument}` },
    blockTag,
  ]);
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error("Malformed escrow state");
  return value.toLowerCase();
}
const addressWord = (value: string) =>
  `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;

/**
 * codeSha256 and factoryCodeSha256 hash decoded immutable runtime code bytes, not hex text or
 * creation code. The vault must be the one its pinned factory created for its project, and the
 * factory must have the reviewed registrar, asset, fee recipient, delays and code, so a vault
 * from a factory with other rotation rules fails.
 */
export async function verifyEvmDeployment(
  config: EvmEscrowConfig,
  blockTag: unknown = "finalized",
) {
  if (
    ![
      config.vault,
      config.asset,
      config.owner,
      config.identityAuthority,
      config.feeRecipient,
      config.factory,
      config.registrar,
    ].every((value) => ADDRESS.test(value)) ||
    !/^[0-9a-f]{64}$/.test(config.codeSha256) ||
    !/^[0-9a-f]{64}$/.test(config.factoryCodeSha256) ||
    !/^(0|[1-9][0-9]*)$/.test(config.bindingDelaySeconds) ||
    BigInt(config.bindingDelaySeconds) > U64
  )
    throw new Error("Reviewed deployment identity is incomplete");
  if (quantity(await rpc(config, "eth_chainId", [])) !== config.chainId)
    throw new Error("Wrong chain");
  if (
    (await runtimeSha256(config, config.vault, blockTag)) !== config.codeSha256
  )
    throw new Error("Escrow runtime code does not match reviewed deployment");
  if (
    (await runtimeSha256(config, config.factory, blockTag)) !==
    config.factoryCodeSha256
  )
    throw new Error("Escrow factory code does not match reviewed deployment");
  for (const [target, signature, expected] of [
    [config.vault, "token()", config.asset],
    [config.vault, "owner()", config.owner],
    [config.vault, "refundDestination()", config.owner],
    [config.vault, "feeRecipient()", config.feeRecipient],
    [config.vault, "factory()", config.factory],
    [config.factory, "registrar()", config.registrar],
    [config.factory, "token()", config.asset],
    [config.factory, "feeRecipient()", config.feeRecipient],
  ]) {
    if (
      (await getter(config, target, signature, blockTag)) !==
      addressWord(expected)
    )
      throw new Error(
        "Escrow asset, factory or registrar does not match reviewed deployment",
      );
  }
  for (const [target, signature, expected] of [
    [config.vault, "bindingDelay()", BigInt(config.bindingDelaySeconds)],
    [config.factory, "bindingDelay()", BigInt(config.bindingDelaySeconds)],
    [
      config.factory,
      "AUTHORITY_ROTATION_DELAY()",
      EVM_AUTHORITY_ROTATION_DELAY,
    ],
  ] as const) {
    if (BigInt(await getter(config, target, signature, blockTag)) !== expected)
      throw new Error("Escrow delays do not match reviewed deployment");
  }
  const projectId = await getter(config, config.vault, "projectId()", blockTag);
  if (
    (await getter(
      config,
      config.factory,
      "vaults(bytes32)",
      blockTag,
      projectId.slice(2),
    )) !== addressWord(config.vault)
  )
    throw new Error("Escrow vault was not created by the reviewed factory");
}

/** The only award ID ProjectEscrow accepts: keccak256(abi.encode(chainId, vault, sourceDigest)). */
export function evmAwardId(
  chainId: bigint,
  vault: string,
  sourceDigest: string,
): string {
  if (!ADDRESS.test(vault) || chainId <= 0n || chainId > U64)
    throw new Error("Invalid award domain");
  const source = hash(sourceDigest);
  const encoded = `${chainId.toString(16).padStart(64, "0")}${vault.slice(2).toLowerCase().padStart(64, "0")}${source.slice(2)}`;
  const bytes = Uint8Array.from(encoded.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  return `0x${Array.from(keccak_256(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function finalizedLog(
  config: EvmEscrowConfig,
  transactionId: string,
  eventIndex: number,
) {
  if (
    !ADDRESS.test(config.vault) ||
    !Number.isSafeInteger(eventIndex) ||
    eventIndex < 0
  ) {
    throw new Error("Invalid deployment or event index");
  }
  const transactionHash = hash(transactionId);
  if (quantity(await rpc(config, "eth_chainId", [])) !== config.chainId) {
    throw new Error("Wrong chain");
  }
  const receipt = object(
    await rpc(config, "eth_getTransactionReceipt", [transactionHash]),
  );
  if (
    receipt.status !== "0x1" ||
    hash(receipt.transactionHash) !== transactionHash
  ) {
    throw new Error("Unsuccessful or mismatched receipt");
  }
  const blockNumber = quantity(receipt.blockNumber);
  const blockId = hash(receipt.blockHash);
  const finalized = object(
    await rpc(config, "eth_getBlockByNumber", ["finalized", false]),
  );
  if (blockNumber > quantity(finalized.number))
    throw new Error("Receipt is not finalized");
  const canonical = object(
    await rpc(config, "eth_getBlockByNumber", [receipt.blockNumber, false]),
  );
  if (
    hash(canonical.hash) !== blockId ||
    quantity(canonical.number) !== blockNumber
  ) {
    throw new Error("Receipt block is not canonical");
  }
  await verifyEvmDeployment(config, receipt.blockNumber);
  if (!Array.isArray(receipt.logs)) throw new Error("Missing receipt logs");
  const matches = receipt.logs
    .map(object)
    .filter((log) => quantity(log.logIndex) === BigInt(eventIndex));
  if (matches.length !== 1) throw new Error("Missing or duplicate event index");
  const log = matches[0];
  if (
    log.removed === true ||
    typeof log.address !== "string" ||
    log.address.toLowerCase() !== config.vault.toLowerCase() ||
    hash(log.transactionHash) !== transactionHash ||
    hash(log.blockHash) !== blockId ||
    quantity(log.blockNumber) !== blockNumber
  ) {
    throw new Error("Event deployment or block mismatch");
  }
  return { log, blockId, transactionHash };
}

async function verify(
  config: EvmEscrowConfig,
  transactionId: string,
  eventIndex: number,
  obligationId: string,
  paid: boolean,
): Promise<FinalizedEscrowEvent> {
  const awardId = hash(obligationId);
  const { log, blockId, transactionHash } = await finalizedLog(
    config,
    transactionId,
    eventIndex,
  );
  if (!Array.isArray(log.topics) || log.topics.length !== (paid ? 4 : 3)) {
    throw new Error("Wrong event topics");
  }
  const topics = log.topics.map(hash);
  if (
    topics[0] !== (paid ? PAYMENT_TOPIC : RESERVE_TOPIC) ||
    topics[1] !== awardId
  ) {
    throw new Error("Wrong event or obligation");
  }
  if (
    typeof log.data !== "string" ||
    !(paid ? /^0x[0-9a-fA-F]{256}$/ : /^0x[0-9a-fA-F]{192}$/).test(log.data)
  ) {
    throw new Error("Wrong event data");
  }
  const words = [
    log.data.slice(2, 66),
    log.data.slice(66, 130),
    log.data.slice(130, 194),
    ...(paid ? [log.data.slice(194, 258)] : []),
  ];
  const actor = uint64(topics[2].slice(2));
  const gross = uint64(words[paid ? 1 : 0]);
  const fee = uint64(words[paid ? 3 : 1]);
  const net = paid ? uint64(words[2]) : gross - fee;
  if (
    actor === 0n ||
    gross === 0n ||
    fee !== gross / 50n ||
    net !== gross - fee
  ) {
    throw new Error("Invalid award accounting");
  }
  const result: FinalizedEscrowEvent = {
    transactionId: transactionHash,
    eventIndex,
    blockId,
    obligationId: awardId,
    githubUserId: actor.toString(),
    grossMicro: gross.toString(),
    netMicro: net.toString(),
    feeMicro: fee.toString(),
  };
  if (paid) {
    if (!/^0x0{24}[0-9a-f]{40}$/.test(topics[3]))
      throw new Error("Invalid destination encoding");
    result.destination = `0x${topics[3].slice(-40)}`;
    const version = uint64(words[0]);
    if (BigInt(result.destination) === 0n || version === 0n)
      throw new Error("Invalid binding");
    result.bindingVersion = version.toString();
  } else {
    result.sourceDigest = `0x${words[2].toLowerCase()}`;
    if (BigInt(result.sourceDigest) === 0n)
      throw new Error("Missing award origin");
  }
  return result;
}

export function verifyReserve(
  config: EvmEscrowConfig,
  transactionId: string,
  eventIndex: number,
  obligationId: string,
) {
  return verify(config, transactionId, eventIndex, obligationId, false);
}

export function verifyPayment(
  config: EvmEscrowConfig,
  transactionId: string,
  eventIndex: number,
  obligationId: string,
) {
  return verify(config, transactionId, eventIndex, obligationId, true);
}

export async function verifyBinding(
  config: EvmEscrowConfig,
  transactionId: string,
  eventIndex: number,
  githubUserId: string,
) {
  const { log, blockId, transactionHash } = await finalizedLog(
    config,
    transactionId,
    eventIndex,
  );
  if (
    !Array.isArray(log.topics) ||
    log.topics.length !== 3 ||
    typeof log.data !== "string" ||
    !/^0x[0-9a-fA-F]{192}$/.test(log.data)
  ) {
    throw new Error("Wrong binding event encoding");
  }
  const topics = log.topics.map(hash);
  if (
    topics[0] !==
      "0xa228a74ce6410fbd6c2c835cf0114180aa30e657287b2f9d47a1ed6c06a2b4b4" ||
    !/^0x0{24}[0-9a-f]{40}$/.test(topics[2])
  ) {
    throw new Error("Wrong binding event");
  }
  const actor = uint64(topics[1].slice(2));
  const version = uint64(log.data.slice(2, 66));
  const destination = `0x${topics[2].slice(-40)}`;
  const claimDigest = `0x${log.data.slice(66, 130).toLowerCase()}`;
  const activatesAt = uint64(log.data.slice(130, 194));
  if (
    actor === 0n ||
    actor.toString() !== githubUserId ||
    version === 0n ||
    BigInt(destination) === 0n ||
    BigInt(claimDigest) === 0n
  ) {
    throw new Error("Invalid binding identity");
  }
  return {
    transactionId: transactionHash,
    eventIndex,
    blockId,
    githubUserId,
    destination,
    bindingVersion: version.toString(),
    claimDigest,
    activatesAt: activatesAt.toString(),
  };
}

function word(value: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > U64)
    throw new Error("Invalid uint64 input");
  return BigInt(value).toString(16).padStart(64, "0");
}

/** Unsigned call data only. Never selects signers or submits a transaction. */
export function buildPayCalldata(
  obligationId: string,
  expectedBindingVersion: string,
) {
  if (expectedBindingVersion === "0")
    throw new Error("Payment needs an active binding");
  return `0xcbcf057d${hash(obligationId).slice(2)}${word(expectedBindingVersion)}`;
}

export interface BindingInput {
  githubUserId: string;
  destination: string;
  expectedVersion: string;
  claimDigest: string;
  expiresAt: string;
}
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
function assertBindingInput(input: BindingInput) {
  if (
    !ADDRESS.test(input.destination) ||
    BigInt(input.destination) === 0n ||
    input.githubUserId === "0" ||
    BigInt(hash(input.claimDigest)) === 0n
  ) {
    throw new Error("Invalid binding input");
  }
}
const keccakHex = (bytes: Uint8Array) =>
  `0x${Array.from(keccak_256(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
const unhex = (value: string) =>
  Uint8Array.from(value.replace(/^0x/, "").match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
/** keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)") */
const DOMAIN_TYPEHASH =
  "8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";
/** keccak256("DestinationBinding(uint64 actorId,address destination,uint64 expectedVersion,bytes32 claimDigest,uint64 expiresAt)") */
const BINDING_TYPEHASH =
  "da5a17ebadee256f10c42cd35247bcea3c3b77ba8772bea3807f7d5023a4489e";
/** keccak256("SlopProjectEscrow") and keccak256("3"): the vault's EIP-712 name and version. */
const DOMAIN_NAME_HASH =
  "3c605d82f7aa4ceb74cffe80a28c3f9b810fb40c95cdc887dea666b075537518";
const DOMAIN_VERSION_HASH =
  "2a80e1ef1d7842f27f2e6be0972bb708b9a135c38860dbe73c27c3486c34f4de";
/** The EIP-712 typed data a destination wallet signs to accept a binding (eth_signTypedData_v4). */
export function evmBindingTypedData(
  chainId: bigint,
  vault: string,
  input: BindingInput,
) {
  assertBindingInput(input);
  if (!ADDRESS.test(vault) || chainId <= 0n || chainId > U64)
    throw new Error("Invalid binding domain");
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      DestinationBinding: [
        { name: "actorId", type: "uint64" },
        { name: "destination", type: "address" },
        { name: "expectedVersion", type: "uint64" },
        { name: "claimDigest", type: "bytes32" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "DestinationBinding" as const,
    domain: {
      name: "SlopProjectEscrow",
      version: "3",
      chainId: chainId.toString(),
      verifyingContract: vault.toLowerCase(),
    },
    message: {
      actorId: input.githubUserId,
      destination: input.destination.toLowerCase(),
      expectedVersion: input.expectedVersion,
      claimDigest: hash(input.claimDigest),
      expiresAt: input.expiresAt,
    },
  };
}
/** The digest ProjectEscrow.bindingDigest returns for the same fields; recover it to verify a wallet signature. */
export function evmBindingDigest(
  chainId: bigint,
  vault: string,
  input: BindingInput,
): string {
  assertBindingInput(input);
  if (!ADDRESS.test(vault) || chainId <= 0n || chainId > U64)
    throw new Error("Invalid binding domain");
  const domain = keccakHex(
    unhex(
      `${DOMAIN_TYPEHASH}${DOMAIN_NAME_HASH}${DOMAIN_VERSION_HASH}${chainId.toString(16).padStart(64, "0")}${vault.slice(2).toLowerCase().padStart(64, "0")}`,
    ),
  );
  const struct = keccakHex(
    unhex(
      `${BINDING_TYPEHASH}${word(input.githubUserId)}${input.destination.slice(2).toLowerCase().padStart(64, "0")}${word(input.expectedVersion)}${hash(input.claimDigest).slice(2)}${word(input.expiresAt)}`,
    ),
  );
  return keccakHex(unhex(`1901${domain.slice(2)}${struct.slice(2)}`));
}
/** bindDestination(uint64,address,uint64,bytes32,uint64,bytes): the authority's call carrying the wallet's signature. */
export function buildBindCalldata(
  input: BindingInput & { walletSignature: string },
) {
  assertBindingInput(input);
  if (!SIGNATURE.test(input.walletSignature))
    throw new Error("Invalid wallet signature encoding");
  const signature = input.walletSignature.slice(2).toLowerCase();
  return `0xac11944e${word(input.githubUserId)}${input.destination.slice(2).toLowerCase().padStart(64, "0")}${word(input.expectedVersion)}${hash(input.claimDigest).slice(2)}${word(input.expiresAt)}${"c0".padStart(64, "0")}${"41".padStart(64, "0")}${signature.padEnd(192, "0")}`;
}
export interface EvmAuthorityRotation {
  factory: string;
  identityAuthority: string;
  /** Null when no rotation is proposed. */
  pendingIdentityAuthority: string | null;
  effectiveAt: string | null;
}
/** The identity authority in force for a vault and any pending factory rotation, at the finalized block. */
export async function readEvmAuthorityRotation(
  config: EvmEscrowConfig,
  blockTag: unknown = "finalized",
): Promise<EvmAuthorityRotation> {
  if (!ADDRESS.test(config.vault)) throw new Error("Invalid vault");
  const read = async (to: string, selector: string, pattern: RegExp) => {
    const value = await rpc(config, "eth_call", [
      { to, data: selector },
      blockTag,
    ]);
    if (typeof value !== "string" || !pattern.test(value))
      throw new Error("Malformed factory state");
    return value;
  };
  const addressWord = /^0x0{24}[0-9a-fA-F]{40}$/;
  const factory = `0x${(await read(config.vault, "0xc45a0155", addressWord)).slice(-40).toLowerCase()}`;
  const identityAuthority = `0x${(await read(factory, "0x13fa3c08", addressWord)).slice(-40).toLowerCase()}`;
  const pending = `0x${(await read(factory, "0xc9a66a21", addressWord)).slice(-40).toLowerCase()}`;
  const effectiveAt = uint64(
    (await read(factory, "0x2c35d137", /^0x[0-9a-fA-F]{64}$/)).slice(2),
  );
  const proposed = BigInt(pending) !== 0n;
  return {
    factory,
    identityAuthority,
    pendingIdentityAuthority: proposed ? pending : null,
    effectiveAt: proposed ? effectiveAt.toString() : null,
  };
}

export function buildDepositCalldata(grossMicro: string) {
  if (grossMicro === "0") throw new Error("Deposit must be positive");
  return `0x13765838${word(grossMicro)}`;
}
export function buildCommitAwardCalldata(input: {
  obligationId: string;
  githubUserId: string;
  grossMicro: string;
  sourceDigest: string;
}) {
  if (
    input.githubUserId === "0" ||
    input.grossMicro === "0" ||
    BigInt(hash(input.obligationId)) === 0n ||
    BigInt(hash(input.sourceDigest)) === 0n
  )
    throw new Error("Invalid award input");
  return `0x126db652${hash(input.obligationId).slice(2)}${word(input.githubUserId)}${word(input.grossMicro)}${hash(input.sourceDigest).slice(2)}`;
}
/** Owner-only: stops a pending binding before it can pay. */
export function buildCancelBindingCalldata(
  githubUserId: string,
  bindingVersion: string,
) {
  if (githubUserId === "0" || bindingVersion === "0")
    throw new Error("Invalid binding cancellation");
  return `0x92be84fc${word(githubUserId)}${word(bindingVersion)}`;
}
/** Permissionless: moves accrued fees to the immutable fee recipient. */
export function buildClaimFeesCalldata() {
  return "0xd294f093";
}
export function buildWithdrawCalldata(grossMicro: string) {
  if (grossMicro === "0") throw new Error("Withdrawal must be positive");
  return `0x3b6ba63d${word(grossMicro)}`;
}
