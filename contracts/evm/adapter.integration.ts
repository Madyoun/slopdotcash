/** Real Anvil transactions, deploys the compiled escrow and test asset. Run with Bun. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  type BindingInput,
  buildBindCalldata,
  buildCancelBindingCalldata,
  buildClaimFeesCalldata,
  buildCommitAwardCalldata,
  buildDepositCalldata,
  buildPayCalldata,
  buildWithdrawCalldata,
  evmAwardId,
  evmBindingDigest,
  readEvmAuthorityRotation,
  verifyBinding,
  verifyEvmDeployment,
  verifyPayment,
  verifyReserve,
} from "./adapter";

const root = fileURLToPath(new URL(".", import.meta.url));
const rpcUrl = "http://127.0.0.1:18546";
const anvil = spawn("anvil", ["--port", "18546", "--silent"], {
  stdio: "ignore",
});
const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const attester = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const recipient = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
// Public Anvil mnemonic account 2; it controls the recipient and accepts each binding.
const recipientKey = Uint8Array.from(
  "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a".match(
    /../g,
  ) ?? [],
  (pair) => Number.parseInt(pair, 16),
);
const fee = "0x0000000000000000000000000000000000000fee";
const nextAttester = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const projectId = `0x${"1".padStart(64, "0")}`;
const source = `0x${"2".padStart(64, "0")}`;
const delay = "3600";
async function rpc(method: string, params: unknown[]) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}
function deploy(contract: string, args: string[] = []) {
  const output = execFileSync(
    "forge",
    [
      "create",
      "--root",
      root,
      contract,
      "--rpc-url",
      rpcUrl,
      "--unlocked",
      "--from",
      owner,
      "--broadcast",
      "--json",
      ...(args.length ? ["--constructor-args", ...args] : []),
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(output).deployedTo as string;
}
async function send(
  to: string,
  signature: string,
  args: string[],
  from = owner,
) {
  const data = execFileSync("cast", ["calldata", signature, ...args], {
    encoding: "utf8",
  }).trim();
  const tx = await rpc("eth_sendTransaction", [
    { from, to, data, gas: "0x7a1200" },
  ]);
  await rpc("anvil_mine", ["0x1"]);
  return tx as string;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (anvil.exitCode !== null)
      throw new Error("Isolated Anvil could not start");
    try {
      await rpc("eth_chainId", []);
      ready = true;
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  assert(ready, "Anvil startup");
  const token = deploy("integration/TestDollar.sol:TestDollar");
  // Vaults are created only by the factory, which holds the identity authority.
  const factory = deploy("src/ProjectEscrow.sol:EscrowFactory", [
    token,
    fee,
    attester,
    delay,
  ]);
  await send(factory, "create(bytes32,address,address)", [
    projectId,
    owner,
    owner,
  ]);
  const vault = `0x${(
    (await rpc("eth_call", [
      { to: factory, data: `0xcca23bf2${projectId.slice(2)}` },
      "latest",
    ])) as string
  ).slice(-40)}`;
  const id = evmAwardId(31337n, vault, source);
  /** The destination wallet signs the exact binding; the authority submits it unchanged. */
  const acceptBinding = (binding: BindingInput) => {
    const signed = secp256k1.sign(
      Uint8Array.from(
        evmBindingDigest(31337n, vault, binding).slice(2).match(/../g) ?? [],
        (pair) => Number.parseInt(pair, 16),
      ),
      recipientKey,
      { prehash: false, format: "recovered" },
    );
    return `0x${Array.from(signed.slice(1), (b) => b.toString(16).padStart(2, "0")).join("")}${(signed[0] + 27).toString(16)}`;
  };
  await send(token, "mint(address,uint256)", [owner, "115000000"]);
  await send(token, "approve(address,uint256)", [vault, "115000000"]);
  await rpc("eth_sendTransaction", [
    {
      from: owner,
      to: vault,
      gas: "0x7a1200",
      data: buildDepositCalldata("115000000"),
    },
  ]);
  await rpc("anvil_mine", ["0x1"]);
  const reserveTx = (await rpc("eth_sendTransaction", [
    {
      from: owner,
      to: vault,
      gas: "0x7a1200",
      data: buildCommitAwardCalldata({
        obligationId: id,
        githubUserId: "101",
        grossMicro: "100000000",
        sourceDigest: source,
      }),
    },
  ])) as string;
  await rpc("anvil_mine", ["0x1"]);
  const runtimeCode = (await rpc("eth_getCode", [vault, "latest"])) as string;
  const codeSha256 = async (address: string) =>
    createHash("sha256")
      .update(
        Buffer.from(
          ((await rpc("eth_getCode", [address, "latest"])) as string).slice(2),
          "hex",
        ),
      )
      .digest("hex");
  const config = {
    rpcUrl,
    chainId: 31337n,
    vault,
    asset: token,
    owner,
    identityAuthority: attester,
    feeRecipient: fee,
    codeSha256: createHash("sha256")
      .update(Buffer.from(runtimeCode.slice(2), "hex"))
      .digest("hex"),
    bindingDelaySeconds: delay,
    factory,
    factoryCodeSha256: await codeSha256(factory),
    registrar: owner,
  };
  await assert.rejects(
    verifyReserve(config, reserveTx, 0, id),
    /not finalized/,
  );
  await rpc("anvil_mine", ["0x40"]);
  await assert.rejects(
    verifyReserve({ ...config, asset: owner }, reserveTx, 0, id),
    /asset, factory or registrar/,
  );
  // The factory is pinned by address, runtime code and registrar. A second
  // factory with the same constructor arguments has identical code but did
  // not create this vault.
  const otherFactory = deploy("src/ProjectEscrow.sol:EscrowFactory", [
    token,
    fee,
    attester,
    delay,
  ]);
  await assert.rejects(
    verifyEvmDeployment({ ...config, factory: otherFactory }, "latest"),
    /asset, factory or registrar/,
  );
  await assert.rejects(
    verifyEvmDeployment(
      { ...config, factoryCodeSha256: "f".repeat(64) },
      "latest",
    ),
    /factory code/,
  );
  await assert.rejects(
    verifyEvmDeployment({ ...config, registrar: attester }, "latest"),
    /asset, factory or registrar/,
  );
  await assert.rejects(
    verifyReserve({ ...config, codeSha256: "f".repeat(64) }, reserveTx, 0, id),
    /runtime code/,
  );
  await assert.rejects(
    verifyReserve({ ...config, bindingDelaySeconds: "0" }, reserveTx, 0, id),
    /delays do not match/,
  );
  const reservation = await verifyReserve(config, reserveTx, 0, id);
  assert.equal(reservation.githubUserId, "101");
  assert.equal(reservation.grossMicro, "100000000");
  assert.equal(reservation.feeMicro, "2000000");
  assert.equal(reservation.sourceDigest, source);
  await assert.rejects(
    verifyReserve({ ...config, chainId: 84532n }, reserveTx, 0, id),
    /Wrong chain/,
  );
  await assert.rejects(
    verifyReserve({ ...config, vault: token }, reserveTx, 0, id),
    /deployment/,
  );
  await assert.rejects(
    verifyReserve(config, reserveTx, 0, source),
    /Wrong event/,
  );
  await assert.rejects(verifyReserve(config, reserveTx, 1, id), /event index/);
  const firstBinding: BindingInput = {
    githubUserId: "101",
    destination: recipient,
    expectedVersion: "0",
    claimDigest: source,
    expiresAt: "18446744073709551615",
  };
  // The authority alone cannot bind: a missing or foreign wallet signature reverts.
  const unsigned = await rpc("eth_sendTransaction", [
    {
      from: attester,
      to: vault,
      gas: "0x7a1200",
      data: buildBindCalldata({
        ...firstBinding,
        walletSignature: `0x${"0".repeat(130)}`,
      }),
    },
  ]);
  await rpc("anvil_mine", ["0x1"]);
  assert.equal(
    ((await rpc("eth_getTransactionReceipt", [unsigned])) as { status: string })
      .status,
    "0x0",
  );
  const bindingTx = await rpc("eth_sendTransaction", [
    {
      from: attester,
      to: vault,
      gas: "0x7a1200",
      data: buildBindCalldata({
        ...firstBinding,
        walletSignature: acceptBinding(firstBinding),
      }),
    },
  ]);
  await rpc("anvil_mine", ["0x1"]);
  await assert.rejects(
    verifyBinding(config, bindingTx, 0, "101"),
    /not finalized/,
  );
  await rpc("anvil_mine", ["0x40"]);
  const binding = await verifyBinding(config, bindingTx, 0, "101");
  assert.equal(binding.destination, recipient.toLowerCase());
  assert.equal(binding.bindingVersion, "1");
  assert.equal(binding.claimDigest, source);
  assert.ok(BigInt(binding.activatesAt) > 0n);
  await assert.rejects(verifyBinding(config, bindingTx, 0, "202"), /identity/);
  // A pending binding cannot pay; the owner can still cancel it.
  const early = await rpc("eth_sendTransaction", [
    {
      from: recipient,
      to: vault,
      gas: "0x7a1200",
      data: buildPayCalldata(id, binding.bindingVersion),
    },
  ]);
  await rpc("anvil_mine", ["0x1"]);
  assert.equal(
    ((await rpc("eth_getTransactionReceipt", [early])) as { status: string })
      .status,
    "0x0",
  );
  const cancelTx = await rpc("eth_sendTransaction", [
    {
      from: owner,
      to: vault,
      gas: "0x7a1200",
      data: buildCancelBindingCalldata("101", "1"),
    },
  ]);
  await rpc("anvil_mine", ["0x1"]);
  assert.equal(
    ((await rpc("eth_getTransactionReceipt", [cancelTx])) as { status: string })
      .status,
    "0x1",
  );
  const secondBinding: BindingInput = { ...firstBinding, expectedVersion: "1" };
  await rpc("eth_sendTransaction", [
    {
      from: attester,
      to: vault,
      gas: "0x7a1200",
      data: buildBindCalldata({
        ...secondBinding,
        walletSignature: acceptBinding(secondBinding),
      }),
    },
  ]);
  await rpc("evm_increaseTime", [Number(delay)]);
  await rpc("anvil_mine", ["0x1"]);
  const paymentTx = await rpc("eth_sendTransaction", [
    {
      from: recipient,
      to: vault,
      gas: "0x7a1200",
      data: buildPayCalldata(id, "2"),
    },
  ]);
  await rpc("anvil_mine", ["0x1"]);
  await assert.rejects(
    verifyPayment(config, paymentTx, 0, id),
    /not finalized/,
  );
  await rpc("anvil_mine", ["0x40"]);
  // PAY-10: the owner pays one Slopbot invoice from the 15 free; the 100
  // reserved for the award stays untouched, and an invoice pays once.
  const invoice = `0x${"3".padStart(64, "0")}`;
  const charge = (amount: string, digest = invoice, from = owner) =>
    rpc("eth_call", [
      {
        from,
        to: vault,
        data: execFileSync(
          "cast",
          ["calldata", "chargeService(uint64,bytes32)", amount, digest],
          { encoding: "utf8" },
        ).trim(),
      },
      "latest",
    ]);
  const selector = (error: string) =>
    execFileSync("cast", ["sig", error], { encoding: "utf8" }).trim();
  await assert.rejects(
    charge("15000001"),
    new RegExp(selector("InsufficientFreeBalance()")),
  );
  await assert.rejects(
    charge("1", `0x${"0".repeat(64)}`),
    new RegExp(selector("InvalidInput()")),
  );
  await assert.rejects(
    charge("1", invoice, recipient),
    new RegExp(selector("Unauthorized()")),
  );
  await send(vault, "chargeService(uint64,bytes32)", ["5000000", invoice]);
  await assert.rejects(charge("1"), new RegExp(selector("DuplicateInvoice()")));
  await rpc("eth_sendTransaction", [
    {
      from: owner,
      to: vault,
      gas: "0x7a1200",
      data: buildWithdrawCalldata("10000000"),
    },
  ]);
  await rpc("anvil_mine", ["0x1"]);
  const refunded = execFileSync(
    "cast",
    ["call", token, "balanceOf(address)(uint256)", owner, "--rpc-url", rpcUrl],
    { encoding: "utf8" },
  ).trim();
  assert.equal(refunded.split(" ")[0], "9000000");
  const payment = await verifyPayment(config, paymentTx, 0, id);
  assert.equal(payment.destination, recipient.toLowerCase());
  assert.equal(payment.bindingVersion, "2");
  assert.equal(payment.grossMicro, "100000000");
  assert.equal(payment.feeMicro, "2000000");
  assert.equal(payment.netMicro, "98000000");
  const recipientBalance = execFileSync(
    "cast",
    [
      "call",
      token,
      "balanceOf(address)(uint256)",
      recipient,
      "--rpc-url",
      rpcUrl,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(recipientBalance.split(" ")[0], "98000000");
  // Fees accrue in the vault and anyone can move them to the fee recipient.
  await rpc("eth_sendTransaction", [
    {
      from: recipient,
      to: vault,
      gas: "0x7a1200",
      data: buildClaimFeesCalldata(),
    },
  ]);
  await rpc("anvil_mine", ["0x1"]);
  const feeBalance = execFileSync(
    "cast",
    ["call", token, "balanceOf(address)(uint256)", fee, "--rpc-url", rpcUrl],
    { encoding: "utf8" },
  ).trim();
  // 2 payout fee, 1 withdrawal fee and the 5 service charge.
  assert.equal(feeBalance.split(" ")[0], "8000000");
  await assert.rejects(
    verifyReserve(config, paymentTx, 0, id),
    /Wrong event topics/,
  );
  // Identity authority rotation: the registrar (the deployer here) proposes and
  // the change takes effect after 7 days. The adapter pins the factory and its
  // rotation rules, not the authority in force, so verification continues
  // through the rotation without a manifest change.
  assert.deepEqual(await readEvmAuthorityRotation(config, "latest"), {
    factory: factory.toLowerCase(),
    identityAuthority: attester.toLowerCase(),
    pendingIdentityAuthority: null,
    effectiveAt: null,
  });
  await send(factory, "proposeIdentityAuthority(address)", [nextAttester]);
  const pending = await readEvmAuthorityRotation(config, "latest");
  assert.equal(pending.pendingIdentityAuthority, nextAttester.toLowerCase());
  assert.ok(BigInt(pending.effectiveAt ?? "0") > 0n);
  const premature = await send(
    factory,
    "executeIdentityAuthorityRotation()",
    [],
  );
  assert.equal(
    (
      (await rpc("eth_getTransactionReceipt", [premature])) as {
        status: string;
      }
    ).status,
    "0x0",
    "execution before the notice period reverts",
  );
  await rpc("evm_increaseTime", [7 * 24 * 60 * 60]);
  await rpc("anvil_mine", ["0x1"]);
  await send(factory, "executeIdentityAuthorityRotation()", [], recipient);
  assert.equal(
    (await readEvmAuthorityRotation(config, "latest")).identityAuthority,
    nextAttester.toLowerCase(),
  );
  await rpc("anvil_mine", ["0x40"]);
  await verifyEvmDeployment(config);
  assert.equal(
    (await verifyPayment(config, paymentTx, 0, id)).netMicro,
    "98000000",
    "a payment made before the rotation still verifies after it",
  );
  console.log(
    "Base adapter integration passed: real factory deployment, vault-bound award, wallet-accepted delayed and cancellable binding, payment, fee claim, exactly-once service charge, finalized gating, wrong chain/vault/award/index/delay rejection, timelocked authority rotation.",
  );
} finally {
  anvil.kill("SIGTERM");
}
