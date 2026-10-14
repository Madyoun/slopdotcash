import { ed25519 } from "@noble/curves/ed25519.js";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentExecutor } from "../../backend/payments/dispatch";
import type { D1Database } from "../../backend/trace/cloudflare-persistence";
import { solanaBase58 } from "../../contracts/solana/adapter";
import { readBoundedJson } from "../../src/lib/browser-json";
import {
  createEvmAttester,
  createEvmExecutor,
  type JournalStore,
  lookupAttempt,
  preflightEvmDeployment,
  retireUnsignedAttempt,
  type Signer,
} from "./core";
import {
  completeSolanaBinding,
  createSolanaAttester,
  createSolanaExecutor,
  preflightSolanaDeployment,
} from "./solana";

export { createEvmAttester, createEvmExecutor } from "./core";

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}
interface Namespace {
  idFromName(name: string): unknown;
  get(id: unknown): Fetcher;
}
interface Environment {
  PAYMENTS_DB: D1Database;
  PAYMENT_DEPLOYMENTS: string;
  PAYMENT_RPC_URLS: string;
  SIGNER_ROLE: "attester" | "relayer";
  CHAIN_FAMILY: "evm" | "solana";
  /** Dedicated test-only key; each independently deployed role has a different secret. */
  TEST_SIGNER_PRIVATE_KEY?: `0x${string}`;
  TEST_SOLANA_SIGNER_SEED?: string;
  JOURNAL: Namespace;
  IDENTITY_ATTESTER?: Fetcher;
}
interface State {
  storage: JournalStore;
}

/** One instance per signer role serializes nonce allocation and preserves signed bytes before broadcast. */
export class PaymentSignerJournal {
  constructor(
    private readonly state: State,
    private readonly env: Environment,
  ) {}
  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      ![
        "/v1/pay",
        "/v1/complete-bind",
        "/v1/attempt-status",
        "/v1/cancel-unsubmitted",
      ].includes(pathname)
    )
      return new Response("Not found", { status: 404 });
    try {
      const input = (await readBoundedJson(
        request as unknown as Response,
        4096,
        "payout execution",
      )) as Parameters<ReturnType<typeof createEvmExecutor>["submit"]>[0] & {
        transaction?: unknown;
      };
      if (["/v1/attempt-status", "/v1/cancel-unsubmitted"].includes(pathname)) {
        if (this.env.SIGNER_ROLE !== "relayer")
          return new Response("Not found", { status: 404 });
        const operation =
          pathname === "/v1/attempt-status"
            ? lookupAttempt
            : retireUnsignedAttempt;
        return Response.json(
          await operation(
            { PAYMENTS_DB: this.env.PAYMENTS_DB, JOURNAL: this.state.storage },
            input,
          ),
        );
      }
      if (request.headers.get("idempotency-key") !== input.idempotencyKey)
        return new Response("Idempotency key required", { status: 400 });
      if (
        this.env.SIGNER_ROLE !== "attester" &&
        this.env.SIGNER_ROLE !== "relayer"
      )
        throw new Error("Signer role missing");
      const service = this.env.IDENTITY_ATTESTER;
      const attester: PaymentExecutor | undefined = service
        ? {
            async submit(body) {
              const response = await service.fetch(
                new Request("https://identity-attester.internal/v1/pay", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "idempotency-key": body.idempotencyKey,
                  },
                  body: JSON.stringify(body),
                }),
              );
              if (!response.ok) throw new Error("Binding pending or rejected");
              const result = (await response.json()) as {
                transactionId: string;
              };
              if (
                typeof result.transactionId !== "string" ||
                !result.transactionId
              )
                throw new Error("Invalid binding transaction");
              return result;
            },
          }
        : undefined;
      const common = {
        PAYMENTS_DB: this.env.PAYMENTS_DB,
        PAYMENT_DEPLOYMENTS: this.env.PAYMENT_DEPLOYMENTS,
        PAYMENT_RPC_URLS: this.env.PAYMENT_RPC_URLS,
        JOURNAL: this.state.storage,
      };
      let engine: PaymentExecutor;
      if (
        pathname === "/v1/complete-bind" &&
        (this.env.SIGNER_ROLE !== "attester" ||
          this.env.CHAIN_FAMILY !== "solana")
      )
        return new Response("Not found", { status: 404 });
      if (this.env.CHAIN_FAMILY === "evm") {
        await preflightEvmDeployment(this.env, input);
        if (!this.env.TEST_SIGNER_PRIVATE_KEY)
          throw new Error("Test signer unavailable");
        const account = privateKeyToAccount(this.env.TEST_SIGNER_PRIVATE_KEY);
        const signer: Signer = {
          address: account.address,
          signTransaction: (transaction) =>
            account.signTransaction(transaction),
        };
        engine =
          this.env.SIGNER_ROLE === "attester"
            ? createEvmAttester({ ...common, SIGNER: signer })
            : createEvmExecutor({
                ...common,
                SIGNER: signer,
                ATTESTER: attester,
              });
      } else if (this.env.CHAIN_FAMILY === "solana") {
        await preflightSolanaDeployment(this.env, input);
        const encodedSeed = this.env.TEST_SOLANA_SIGNER_SEED;
        if (!encodedSeed || !/^[0-9a-f]{64}$/.test(encodedSeed))
          throw new Error("Test signer unavailable");
        const seed = Uint8Array.from(encodedSeed.match(/../g) ?? [], (byte) =>
          Number.parseInt(byte, 16),
        );
        const signer = {
          address: solanaBase58(ed25519.getPublicKey(seed)),
          async signMessage(message: Uint8Array) {
            return ed25519.sign(message, seed);
          },
        };
        // A Solana binding needs the destination wallet's signature on the
        // same bytes: the attester prepares and half-signs it, the wallet
        // co-signs, and the completed transaction comes back here.
        if (this.env.SIGNER_ROLE === "attester") {
          const solana = { ...common, SOLANA_SIGNER: signer };
          const { transaction, ...binding } = input;
          if (pathname === "/v1/complete-bind") {
            if (typeof transaction !== "string")
              throw new Error("Signed transaction required");
            return Response.json(
              await completeSolanaBinding(solana, binding, transaction),
            );
          }
          return Response.json(
            await createSolanaAttester(solana).submit(binding),
          );
        }
        engine = createSolanaExecutor({ ...common, SOLANA_SIGNER: signer });
      } else throw new Error("Unsupported signer family");
      const result = await engine.submit(input);
      return Response.json(result);
    } catch {
      // No keys, signed transaction bytes, wallet consent signatures, or RPC credentials in responses/logs.
      return Response.json(
        { error: "execution_pending_or_rejected" },
        { status: 409 },
      );
    }
  }
}

/** Service bindings only. workers_dev and preview URLs must remain disabled in both deployments. */
export default {
  async fetch(request: Request, env: Environment) {
    return env.JOURNAL.get(
      env.JOURNAL.idFromName("dedicated-test-signer-v1"),
    ).fetch(request);
  },
};
