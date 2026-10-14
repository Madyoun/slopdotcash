import { evmBindingTypedData } from "../../contracts/evm/adapter";
import { readBoundedJson } from "../../src/lib/browser-json";
import { ESCROW_CHAINS, EVM_CHAINS } from "../../src/lib/escrow-policy.mjs";
import type {
  AccountPayment,
  DirectTransfer,
  PaymentsAccount,
} from "../../src/lib/payments/contracts";
import { isWalletAddress, isWalletChain } from "../../src/lib/wallets";
import { sha256Hex } from "../../workers/identity/crypto";
import type { D1Database } from "../trace/cloudflare-persistence";
import {
  buildPaymentWalletMessage,
  canonicalEvmSignature,
  verifyEvmBindingSignature,
  verifyPaymentWalletSignature,
} from "./possession";
import { slopbotInvoice } from "./slopbot-billing";
import { registerPaymentWallet } from "./wallet-registration";

export interface PaymentsDependencies {
  db: D1Database;
  now?: () => Date;
  /** Additional trusted deployment origins; never sourced from request input. */
  allowedOrigins?: readonly string[];
  /** Trusted numeric GitHub operator allowlist; never request-supplied. */
  operatorIds?: readonly string[];
  /** Reviewed escrow deployments (PAYMENT_DEPLOYMENTS); never request-supplied. */
  paymentDeployments?: readonly PaymentDeploymentIdentity[];
  /** Service binding to the Solana identity attester role; never request-supplied. */
  solanaAttester?: { fetch(request: Request): Promise<Response> };
}
export interface PaymentDeploymentIdentity {
  network: string;
  chain: string;
  vault: string;
  chainId?: string;
}
/** The attester must still have this long to submit a binding authorization. */
const BINDING_SUBMISSION_WINDOW_SECONDS = 600;
const origins = new Set([
  "https://slop.cash",
  "https://slop.tech",
  "https://eliza.army",
]);
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
async function directTransfers(
  db: D1Database,
  column: "project_id" | "github_user_id",
  value: string,
): Promise<DirectTransfer[]> {
  const row = await db
    .prepare(
      `SELECT json_group_array(json_object('projectId',project_id,'contributionMonth',contribution_month,'githubUserId',github_user_id,'login',github_login,'network',network,'chain',chain,'recipient',recipient,'amountMicro',amount_micro,'transactionId',transaction_id,'blockTime',block_time)) items FROM (SELECT * FROM payment_direct_transfers WHERE ${column}=? ORDER BY block_time,transaction_id)`,
    )
    .bind(value)
    .first<{ items: string }>();
  return JSON.parse(row?.items ?? "[]") as DirectTransfer[];
}
export async function handlePaymentsApi(
  request: Request,
  deps: PaymentsDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace("/api/v1/payments", "");
  const now = (deps.now?.() ?? new Date()).toISOString();
  if (
    !new Set([...origins, ...(deps.allowedOrigins ?? [])]).has(url.origin) ||
    (request.method !== "GET" &&
      (request.method !== "POST" ||
        request.headers.get("origin") !== url.origin ||
        request.headers.get("content-type")?.split(";")[0] !==
          "application/json"))
  )
    return json(403, { error: "origin_forbidden" });
  try {
    const totalsRoute = /^\/projects\/([a-z0-9][a-z0-9-]*)\/totals$/.exec(path);
    if (totalsRoute && request.method === "GET") {
      const projectId = totalsRoute[1];
      const result = await deps.db
        .prepare(
          "SELECT json_group_array(json_object('network',network,'gross',gross_micro,'fee',fee_micro,'state',state)) items FROM payment_obligations WHERE project_id=?",
        )
        .bind(projectId)
        .first<{ items: string }>();
      const rows = JSON.parse(result?.items ?? "[]") as {
        network: string;
        gross: string;
        fee: string;
        state: string;
      }[];
      const cursor = await deps.db
        .prepare(
          "SELECT network,position,synced_at FROM payment_chain_cursors WHERE project_id=?",
        )
        .bind(projectId)
        .first<{ network: string; position: string; synced_at: string }>();
      if (!rows.length && !cursor)
        return json(503, { error: "project_payments_not_indexed" });
      const total = (state: string, fee: boolean) =>
        rows
          .filter((r) => r.state === state)
          .reduce(
            (sum, r) =>
              sum + (fee ? BigInt(r.fee) : BigInt(r.gross) - BigInt(r.fee)),
            0n,
          )
          .toString();
      return json(200, {
        projectId,
        network: cursor?.network ?? rows[0].network,
        totalNetPaidMicro: total("paid", false),
        payoutFeesPaidMicro: total("paid", true),
        reservedNetMicro: total("reserved", false),
        reservedFeeMicro: total("reserved", true),
        coverage: {
          kind: "finalized-payment-events",
          completeThrough: cursor?.position ?? null,
        },
        syncedAt: cursor?.synced_at ?? null,
      });
    }
    const directRoute =
      /^\/(?:projects\/([a-z0-9][a-z0-9-]*)|actors\/([1-9]\d{0,15}))\/direct-transfers$/.exec(
        path,
      );
    if (directRoute && request.method === "GET") {
      const transfers = await directTransfers(
        deps.db,
        directRoute[2] ? "github_user_id" : "project_id",
        directRoute[2] ?? directRoute[1],
      );
      return json(200, {
        transfers,
        totalMicro: transfers
          .reduce((sum, t) => sum + BigInt(t.amountMicro), 0n)
          .toString(),
      });
    }
    const invoiceRoute =
      /^\/slopbot\/installations\/([1-9]\d{0,14})\/invoices\/(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(
        path,
      );
    if (invoiceRoute && request.method === "GET") {
      const invoice = await slopbotInvoice(
        deps.db,
        Number(invoiceRoute[1]),
        invoiceRoute[2],
        now,
      );
      return invoice
        ? json(200, invoice)
        : json(404, { error: "installation_not_found" });
    }
    const token = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("__Host-slop_points="))
      ?.slice("__Host-slop_points=".length);
    if (!token || !/^[A-Za-z0-9_-]{40,128}$/.test(token))
      return json(401, { error: "not_signed_in" });
    const member = await deps.db
      .prepare(
        "SELECT m.github_id,m.login FROM points_members m JOIN points_sessions s ON s.actor_id=m.actor_id WHERE s.token_hash=? AND s.expires_at>?",
      )
      .bind(await sha256Hex(token), now)
      .first<{ github_id: string; login: string }>();
    if (!member) return json(401, { error: "session_expired" });
    if (path === "/admin/wallet-proposals" && request.method === "POST") {
      if (!deps.operatorIds?.includes(member.github_id))
        return json(403, { error: "operator_required" });
      const body = (await readBoundedJson(
        request as unknown as Response,
        4096,
        "wallet proposal",
      )) as Record<string, unknown>;
      if (
        typeof body.githubUserId !== "string" ||
        !/^[1-9]\d*$/.test(body.githubUserId) ||
        !isWalletChain(body.chain) ||
        typeof body.address !== "string" ||
        !isWalletAddress(body.chain, body.address) ||
        typeof body.reason !== "string" ||
        !body.reason.trim()
      )
        return json(400, { error: "invalid_proposal" });
      const id = crypto.randomUUID();
      await deps.db
        .prepare("INSERT INTO payment_wallet_proposals VALUES(?,?,?,?,?,?,?)")
        .bind(
          id,
          body.githubUserId,
          body.chain,
          body.address,
          member.github_id,
          body.reason,
          now,
        )
        .run();
      return json(201, { id, state: "pending_contributor_authorization" });
    }

    if (path === "/wallets/register" && request.method === "POST") {
      const body = (await readBoundedJson(
        request as unknown as Response,
        4096,
        "wallet registration",
      )) as Record<string, unknown>;
      if (
        !isWalletChain(body.chain) ||
        typeof body.address !== "string" ||
        !isWalletAddress(body.chain, body.address)
      )
        return json(400, { error: "invalid_wallet" });
      const result = await registerPaymentWallet(
        deps.db,
        member,
        body.chain,
        body.address,
        now,
      );
      return result.conflict
        ? json(409, { error: "stale_wallet_claim" })
        : json(200, { claimId: result.claimId });
    }
    if (path === "/wallets/challenge" && request.method === "POST") {
      const body = (await readBoundedJson(
        request as unknown as Response,
        4096,
        "wallet challenge",
      )) as Record<string, unknown>;
      if (typeof body.claimId !== "string")
        return json(400, { error: "invalid_request" });
      const wallet = await deps.db
        .prepare(
          "SELECT id,chain,wallet_address,record_sha256 FROM wallet_claims w WHERE id=? AND github_user_id=? AND source='d1_registry' AND NOT EXISTS(SELECT 1 FROM wallet_claims n WHERE n.supersedes_claim_id=w.id)",
        )
        .bind(body.claimId, member.github_id)
        .first<{
          id: string;
          chain: string;
          wallet_address: string;
          record_sha256: string;
        }>();
      if (!wallet) return json(409, { error: "claim_not_current" });
      const id = crypto.randomUUID();
      const expiresAt = new Date(Date.parse(now) + 15 * 60000).toISOString();
      const message = buildPaymentWalletMessage({
        actorId: member.github_id,
        chain: wallet.chain,
        address: wallet.wallet_address,
        claimId: wallet.id,
        claimDigest: wallet.record_sha256,
        nonce: id,
        expiresAt,
      });
      await deps.db
        .prepare("INSERT INTO payment_wallet_challenges VALUES(?,?,?,?,?,NULL)")
        .bind(id, wallet.id, member.github_id, message, expiresAt)
        .run();
      return json(200, {
        challengeId: id,
        message,
        address: wallet.wallet_address,
        chain: wallet.chain,
        expiresAt,
      });
    }
    if (path === "/wallets/authorize" && request.method === "POST") {
      const body = (await readBoundedJson(
        request as unknown as Response,
        4096,
        "wallet authorization",
      )) as Record<string, unknown>;
      if (
        typeof body.claimId !== "string" ||
        typeof body.challengeId !== "string" ||
        typeof body.signature !== "string"
      )
        return json(400, { error: "invalid_request" });
      const challenge = await deps.db
        .prepare(
          "SELECT c.message,w.chain,w.wallet_address FROM payment_wallet_challenges c JOIN wallet_claims w ON w.id=c.claim_id WHERE c.id=? AND c.claim_id=? AND c.github_user_id=? AND c.expires_at>? AND c.consumed_at IS NULL AND NOT EXISTS(SELECT 1 FROM wallet_claims n WHERE n.supersedes_claim_id=w.id)",
        )
        .bind(body.challengeId, body.claimId, member.github_id, now)
        .first<{ message: string; chain: string; wallet_address: string }>();
      if (
        !challenge ||
        !verifyPaymentWalletSignature(
          challenge.chain,
          challenge.wallet_address,
          challenge.message,
          body.signature,
        )
      )
        return json(403, { error: "wallet_signature_required" });
      const consumed = await deps.db
        .prepare(
          "UPDATE payment_wallet_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?",
        )
        .bind(now, body.challengeId, now)
        .run();
      if (consumed.meta?.changes !== 1)
        return json(409, { error: "challenge_consumed" });
      const result = await deps.db.batch([
        deps.db
          .prepare(
            "INSERT INTO payment_wallet_authorizations(claim_id,github_user_id,authorized_at,challenge_id,signature) SELECT id,github_user_id,?,?,? FROM wallet_claims w WHERE id=? AND github_user_id=? AND source='d1_registry' AND NOT EXISTS(SELECT 1 FROM wallet_claims next WHERE next.supersedes_claim_id=w.id) ON CONFLICT(claim_id) DO NOTHING",
          )
          .bind(
            now,
            body.challengeId,
            body.signature,
            body.claimId,
            member.github_id,
          ),
        deps.db
          .prepare(
            "INSERT INTO payment_outbox(obligation_id,state,updated_at) SELECT o.id,'ready',? FROM payment_obligations o JOIN wallet_claims w ON w.github_user_id=o.github_user_id AND w.chain=o.chain JOIN payment_wallet_authorizations a ON a.claim_id=w.id WHERE w.id=? AND w.github_user_id=? AND o.state='reserved' AND NOT EXISTS(SELECT 1 FROM wallet_claims n WHERE n.supersedes_claim_id=w.id) ON CONFLICT(obligation_id) DO UPDATE SET state='ready',updated_at=excluded.updated_at WHERE payment_outbox.state='held'",
          )
          .bind(now, body.claimId, member.github_id),
      ]);
      if (result.some((r) => !r.success))
        throw new Error("Authorization failed");
      const authorized = await deps.db
        .prepare(
          "SELECT a.claim_id FROM payment_wallet_authorizations a JOIN wallet_claims w ON w.id=a.claim_id WHERE a.claim_id=? AND a.github_user_id=? AND NOT EXISTS(SELECT 1 FROM wallet_claims n WHERE n.supersedes_claim_id=w.id)",
        )
        .bind(body.claimId, member.github_id)
        .first();
      return authorized
        ? json(200, { authorized: true })
        : json(409, { error: "claim_not_current" });
    }
    // An EVM destination binding needs the destination wallet's EIP-712
    // signature over the exact chain, vault, actor, destination, expected
    // version, claim digest and expiry (PAY-05). The challenge is stateless:
    // the authorize step verifies every field against the current claim, and
    // the chain ID comes from the reviewed deployment, never the request.
    if (
      ["/wallets/bind-challenge", "/wallets/bind-authorize"].includes(path) &&
      request.method === "POST"
    ) {
      const body = (await readBoundedJson(
        request as unknown as Response,
        4096,
        "binding authorization",
      )) as Record<string, unknown>;
      const decimal = (value: unknown): value is string =>
        typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value);
      const authorize = path === "/wallets/bind-authorize";
      if (
        typeof body.claimId !== "string" ||
        typeof body.network !== "string" ||
        typeof body.vault !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(body.vault) ||
        !decimal(body.expectedVersion) ||
        (authorize &&
          (!decimal(body.expiresAt) ||
            typeof body.signature !== "string" ||
            !/^0x[0-9a-fA-F]{130}$/.test(body.signature)))
      )
        return json(400, { error: "invalid_request" });
      if (!deps.paymentDeployments)
        return json(503, { error: "payment_deployments_unavailable" });
      const vault = body.vault.toLowerCase();
      const deployments = deps.paymentDeployments.filter(
        (d) =>
          (EVM_CHAINS as readonly string[]).includes(d.chain) &&
          d.network === body.network &&
          d.vault.toLowerCase() === vault &&
          typeof d.chainId === "string" &&
          /^[1-9][0-9]{0,18}$/.test(d.chainId),
      );
      if (deployments.length !== 1)
        return json(400, { error: "unknown_deployment" });
      const chainId = BigInt(deployments[0].chainId as string);
      const wallet = await deps.db
        .prepare(
          `SELECT w.id,w.wallet_address,w.record_sha256 FROM wallet_claims w JOIN payment_wallet_authorizations a ON a.claim_id=w.id WHERE w.id=? AND w.github_user_id=? AND w.chain=? AND w.source='d1_registry' AND NOT EXISTS(SELECT 1 FROM wallet_claims n WHERE n.supersedes_claim_id=w.id)`,
        )
        .bind(body.claimId, member.github_id, deployments[0].chain)
        .first<{ id: string; wallet_address: string; record_sha256: string }>();
      if (!wallet) return json(409, { error: "claim_not_current" });
      const nowSeconds = Math.floor(Date.parse(now) / 1000);
      const expiresAt = authorize
        ? (body.expiresAt as string)
        : String(nowSeconds + 90 * 24 * 60 * 60);
      const binding = {
        githubUserId: member.github_id,
        destination: wallet.wallet_address,
        expectedVersion: body.expectedVersion,
        claimDigest: `0x${wallet.record_sha256}`,
        expiresAt,
      };
      if (!authorize)
        return json(200, {
          claimId: wallet.id,
          typedData: evmBindingTypedData(chainId, vault, binding),
        });
      // Only an authorization the attester can still submit is stored.
      if (
        BigInt(expiresAt) <=
        BigInt(nowSeconds + BINDING_SUBMISSION_WINDOW_SECONDS)
      )
        return json(400, { error: "authorization_expires_too_soon" });
      // Store the encoding the vault accepts: a recovery byte of 0 or 1
      // becomes 27 or 28; a high-s signature is refused.
      const signature = canonicalEvmSignature(body.signature as string);
      if (
        !signature ||
        !verifyEvmBindingSignature(chainId, vault, binding, signature)
      )
        return json(403, { error: "wallet_signature_required" });
      // Rows are append-only evidence. A new signature with another expiry is
      // its own row, so an expired authorization never blocks a renewal.
      await deps.db
        .prepare(
          "INSERT INTO payment_binding_authorizations(claim_id,github_user_id,network,vault,chain_id,expected_version,expires_at,signature,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(claim_id,network,vault,chain_id,expected_version,expires_at) DO NOTHING",
        )
        .bind(
          wallet.id,
          member.github_id,
          body.network,
          vault,
          chainId.toString(),
          body.expectedVersion,
          expiresAt,
          signature,
          now,
        )
        .run();
      // An identical earlier row is a signature over the same fields; report
      // success only when a verified row for these exact fields is stored.
      const stored = await deps.db
        .prepare(
          "SELECT signature FROM payment_binding_authorizations WHERE claim_id=? AND github_user_id=? AND network=? AND vault=? AND chain_id=? AND expected_version=? AND expires_at=?",
        )
        .bind(
          wallet.id,
          member.github_id,
          body.network,
          vault,
          chainId.toString(),
          body.expectedVersion,
          expiresAt,
        )
        .first<{ signature: string }>();
      if (
        !stored ||
        !verifyEvmBindingSignature(chainId, vault, binding, stored.signature)
      )
        throw new Error("Binding authorization was not stored");
      return json(200, { authorized: true, expiresAt });
    }
    // A Solana binding transaction must carry the destination wallet's own
    // signature (PAY-05). The attester prepares and half-signs the exact
    // transaction for the contributor's current claim and payout attempt; the
    // contributor's wallet signs the same bytes and returns them here.
    if (
      [
        "/wallets/solana-bind/prepare",
        "/wallets/solana-bind/complete",
      ].includes(path) &&
      request.method === "POST"
    ) {
      const body = (await readBoundedJson(
        request as unknown as Response,
        4096,
        "solana binding",
      )) as Record<string, unknown>;
      const complete = path === "/wallets/solana-bind/complete";
      if (
        typeof body.obligationId !== "string" ||
        !/^[0-9a-f]{64}$/.test(body.obligationId) ||
        (complete &&
          (typeof body.transaction !== "string" ||
            body.transaction.length > 2048 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(body.transaction)))
      )
        return json(400, { error: "invalid_request" });
      if (!deps.solanaAttester)
        return json(503, { error: "identity_attester_unavailable" });
      const payment = await deps.db
        .prepare(
          "SELECT o.id obligationId,o.network,o.vault,o.github_user_id githubUserId,w.id claimId,w.record_sha256 claimDigest,w.wallet_address destination,t.id idempotencyKey FROM payment_obligations o JOIN wallet_claims w ON w.github_user_id=o.github_user_id AND w.chain=o.chain JOIN payment_wallet_authorizations a ON a.claim_id=w.id JOIN payment_attempts t ON t.obligation_id=o.id AND t.claim_id=w.id WHERE o.id=? AND o.github_user_id=? AND o.chain='solana' AND o.state='reserved' AND w.source='d1_registry' AND t.state IN ('prepared','unknown','submitted') AND NOT EXISTS(SELECT 1 FROM wallet_claims n WHERE n.supersedes_claim_id=w.id) ORDER BY t.created_at LIMIT 1",
        )
        .bind(body.obligationId, member.github_id)
        .first<Record<string, string>>();
      if (!payment) return json(409, { error: "binding_not_ready" });
      const response = await deps.solanaAttester.fetch(
        new Request(
          `https://identity-attester.internal/v1/${complete ? "complete-bind" : "pay"}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": payment.idempotencyKey,
            },
            body: JSON.stringify(
              complete
                ? { ...payment, transaction: body.transaction }
                : payment,
            ),
          },
        ),
      );
      if (!response.ok)
        return json(409, { error: "binding_pending_or_rejected" });
      const result = (await response.json()) as {
        transactionId?: unknown;
        transaction?: unknown;
      };
      if (
        typeof result.transactionId !== "string" ||
        (result.transaction !== undefined &&
          typeof result.transaction !== "string")
      )
        throw new Error("Invalid identity attester response");
      return json(200, {
        transactionId: result.transactionId,
        ...(!complete && typeof result.transaction === "string"
          ? { transaction: result.transaction }
          : {}),
      });
    }
    if (path === "/me" && request.method === "GET") {
      const walletRows = await deps.db
        .prepare(
          "SELECT json_group_array(json_object('chain',w.chain,'claimId',w.id,'address',w.wallet_address,'authorized',json(CASE WHEN a.claim_id IS NULL THEN 'false' ELSE 'true' END),'activationEligibleAt',CASE WHEN w.supersedes_claim_id IS NOT NULL AND a.authorized_at IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ',max(w.created_at,a.authorized_at),'+1 day') ELSE NULL END)) items FROM wallet_claims w LEFT JOIN payment_wallet_authorizations a ON a.claim_id=w.id WHERE w.github_user_id=? AND NOT EXISTS(SELECT 1 FROM wallet_claims n WHERE n.supersedes_claim_id=w.id)",
        )
        .bind(member.github_id)
        .first<{ items: string }>();
      const paymentRows = await deps.db
        .prepare(
          "SELECT json_group_array(json_object('id',o.id,'projectId',project_id,'network',network,'chain',chain,'grossMicro',gross_micro,'feeMicro',fee_micro,'state',o.state,'transactionId',paid_transaction,'submittedTransactionId',(SELECT transaction_id FROM payment_attempts a WHERE a.obligation_id=o.id AND a.transaction_id IS NOT NULL ORDER BY created_at DESC LIMIT 1),'deliveryState',CASE WHEN o.state='paid' THEN 'paid' WHEN q.state='submitted' THEN 'submitted' WHEN q.state='held' THEN 'held' WHEN q.state IS NULL THEN 'needs_wallet' ELSE 'awaiting_binding' END)) items FROM payment_obligations o LEFT JOIN payment_outbox q ON q.obligation_id=o.id WHERE github_user_id=?",
        )
        .bind(member.github_id)
        .first<{ items: string }>();
      const payments = JSON.parse(
        paymentRows?.items ?? "[]",
      ) as AccountPayment[];
      for (const p of payments)
        p.netMicro = (BigInt(p.grossMicro) - BigInt(p.feeMicro)).toString();
      const balances = ESCROW_CHAINS.map((chain) => ({
        chain,
        netMicro: payments
          .filter((p) => p.chain === chain && p.state === "reserved")
          .reduce((sum, p) => sum + BigInt(p.netMicro), 0n)
          .toString(),
      }));
      const account: PaymentsAccount = {
        githubUserId: member.github_id,
        wallets: JSON.parse(walletRows?.items ?? "[]"),
        payments,
        balances,
        directTransfers: await directTransfers(
          deps.db,
          "github_user_id",
          member.github_id,
        ),
        walletObservations: JSON.parse(
          (
            await deps.db
              .prepare(
                "SELECT json_group_array(json_object('chain',chain,'address',address,'proofLevel',proof_level,'sourceUrl',source_url,'observedAt',observed_at)) items FROM (SELECT * FROM wallet_observations WHERE github_user_id=? ORDER BY observed_at DESC)",
              )
              .bind(member.github_id)
              .first<{ items: string }>()
          )?.items ?? "[]",
        ),
      };
      return json(200, account);
    }
    return json(404, { error: "not_found" });
  } catch {
    return json(503, { error: "payments_unavailable" });
  }
}
