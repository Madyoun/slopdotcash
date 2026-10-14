// The finalized-revert proof must name the deployment's chain and must only
// exist for a finalized, reverted receipt on the expected chain id.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { finalizedEvmRevert } from "./reconcile";

const txHash = `0x${"11".repeat(32)}`;
const blockHash = `0x${"22".repeat(32)}`;
let server: ReturnType<typeof Bun.serve>;
let url: string;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { id, method, params } = (await request.json()) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const result =
        method === "eth_chainId"
          ? "0x7a69"
          : method === "eth_getTransactionReceipt"
            ? {
                status: "0x0",
                transactionHash: txHash,
                blockHash,
                blockNumber: "0x10",
              }
            : method === "eth_getBlockByNumber" && params[0] === "finalized"
              ? { number: "0x20" }
              : method === "eth_getBlockByNumber"
                ? { hash: blockHash }
                : null;
      return Response.json({ jsonrpc: "2.0", id, result });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

test("records the deployment's chain in the proof", async () => {
  const proof = await finalizedEvmRevert(url, "31337", txHash, "base");
  expect(proof).toEqual({
    chain: "base",
    transactionId: txHash,
    blockHash,
    status: "reverted",
    finality: "finalized",
  });
});

test("rejects a chain id mismatch instead of producing a proof", async () => {
  await expect(finalizedEvmRevert(url, "8453", txHash, "base")).rejects.toThrow(
    /chain mismatch/,
  );
});

test("a missing chain id is a mismatch, not a pass", async () => {
  await expect(
    finalizedEvmRevert(url, undefined, txHash, "base"),
  ).rejects.toThrow(/chain mismatch/);
});
