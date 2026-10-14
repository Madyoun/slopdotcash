#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .local
if [[ ! -f .local/payer.json ]]; then
  solana-keygen new --no-bip39-passphrase --silent --outfile .local/payer.json >/dev/null
fi
npm ci --ignore-scripts --legacy-peer-deps
export ANCHOR_PROVIDER_URL=http://127.0.0.1:18899
export ANCHOR_WALLET="$PWD/.local/payer.json"
validator_pid=""
trap 'if [[ -n "$validator_pid" ]]; then kill "$validator_pid" 2>/dev/null || true; fi' EXIT
start_validator() {
  solana-test-validator --reset --quiet --ledger .local/ledger --rpc-port 18899 --faucet-port 18940 --dynamic-port-range 18901-18930 --bpf-program 4hXeYxsTKbwVKRRn8P1emGNDmVUSx13VMykfUAsbPnnj target/deploy/slop_escrow.so "$@" >.local/validator.log 2>&1 &
  validator_pid=$!
  for attempt in $(seq 1 40); do
    if solana --url "$ANCHOR_PROVIDER_URL" cluster-version >/dev/null 2>&1; then break; fi
    sleep 1
  done
  solana --url "$ANCHOR_PROVIDER_URL" airdrop 100 --keypair "$ANCHOR_WALLET" >/dev/null
}
stop_validator() {
  kill "$validator_pid"
  wait "$validator_pid" 2>/dev/null || true
  validator_pid=""
}
# The deployable build keeps the one-hour delay floor; prove it on the validator first.
bash scripts/build-local.sh
start_validator
node --test --test-force-exit --test-isolation=none integration/production-delay.e2e.mjs
stop_validator
# The main suite waits the binding delay out in seconds, so it builds with the test-only delay floor.
SLOP_ESCROW_FEATURES=short-delay-for-tests bash scripts/build-local.sh
# A project account in the layout from before the rotation fields, which the
# owner-plan suite grows with migrate_project.
legacy_project=$(node integration/legacy-project.mjs)
start_validator --account "$legacy_project" .local/legacy-project-account.json
bun build adapter.ts --target=node --outfile=.local/adapter.mjs
bun build ../../workers/payment-executor/solana.ts --target=node --outfile=.local/executor.mjs
bun build ../../workers/payments/scanner.ts ../../backend/payments/ledger.ts ../../backend/payments/handler.ts --target=node --outdir=.local --entry-naming='[name].mjs'
node --test --test-force-exit --test-isolation=none --test-concurrency=1 integration/escrow.e2e.mjs integration/executor.e2e.mjs integration/owner-plan.e2e.mjs
