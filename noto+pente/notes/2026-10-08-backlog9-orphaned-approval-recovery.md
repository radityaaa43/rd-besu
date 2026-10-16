# BACKLOG #9 — Orphaned approval recovery / group-creation idempotency (design note)

Date: 2026-10-08. Author: paladin agent. Status: DRAFT for lead review — no code written.

## 1. Problem

E11 first attempt: approval `716e58c6-ac61-448d-bd9d-8dbecb3e796b` (`bond-series-create`)
executed its chain work successfully — series `0xe3735e5c1e52572f204384d25ea8bbb3dc7b0a09`
IS on chain and a `bond_series` row exists — but the engine's final `EXECUTING → APPROVED`
write failed with PG `42703` (missing column `resulting_resource`), so the approval row
stayed `EXECUTING` and `resulting_resource` was never stamped (stamped only on the success
path, backend/shared/src/approvals/engine.ts:146). A retry of the same approval correctly
refused: node logged 3x PD012220 "idempotencyKey already used by submitted transaction",
then a gas-estimate revert with selector `0x620eb872` = `SeriesAlreadyRegistered(address)`,
then PD012216 — surfaced as HTTP 422. Correct refusal, but the caller had no path forward:
the series exists, the row is stuck `EXECUTING`, and nothing bridges the two.

## 2. The idempotency gap

Keys are deterministic, derived from the approval id — there is no stored key column:

- Backend: `submissionIdempotencyKey(approvalId, step)` = `` `${approvalId}:${step}` ``
  (backend/shared/src/events/primaryFlow.ts:41-43). Called from
  backend/bi/src/bondSeries/handler.ts:102 (`"issue-series"`), :109 (`"mint-tranche"`),
  :113 (`"begin-distribution"`).
- paladin-client: `issueSeries` builds substep keys `` subKey(s) = `${idempotencyKey}:${s}` ``
  (Paladin/common/paladin-client/src/client.ts:2163): `deploy-public-tracker` (:2188),
  `deploy-private-tracker` (:2194), `deploy-token` (:2213), `register-series` (:2262-2264).
  So the full clash key for the incident is
  `716e58c6…:issue-series:register-series`.

Gaps on a retry of the same `issueSeries` call (client.ts:2158):

- **Group creation has no key at all.** `PenteFactory.newPrivacyGroup` never forwards
  `transactionOptions`, so the issuer+custodian group (client.ts:2170-2176, documented
  in-source) re-creates a NEW group on every retry. `createPrivacyGroup` (client.ts:1529,
  types.ts:588) has no `idempotencyKey` param either.
- **Keyed substeps recover, but too late to help.** `resolveIdempotentFuture`
  (client.ts:665) catches a send-time PD012220, looks the prior tx up via
  `ptx_getTransactionByIdempotencyKey`, and polls its receipt — but only for the substeps
  that carry a key, and only when the PD012220 surfaces at send time (client.ts:695-701).
- **Node-side PD012220 is reject-only.** Reusing a key returns a conflict naming the prior
  tx; it does not return the old result. There IS a lookup-by-key API:
  `ptx_getTransactionByIdempotencyKey` (core/go/internal/txmgr/rpcmodule.go:44,181-187 →
  `GetTransactionByIdempotencyKey`, core/go/internal/txmgr/transaction_query.go:417;
  conflict raised at transaction_submission.go:421-435; code defined
  msgs/en_errors.go:413). One transactions table serves ptx and pgroup sends alike.
- **Engine has no exit from EXECUTING on failure.** States are
  `PENDING_APPROVAL | EXECUTING | APPROVED | REJECTED` (backend/shared/src/approvals/types.ts:11);
  only `approve` (PENDING→EXECUTING, engine.ts:167) and the success path
  (EXECUTING→APPROVED, engine.ts:145) move state; on handler failure the row stays
  `EXECUTING` with `last_error` (engine.ts:132-140). No reconciler existed — hence the row.

Why a retry cannot recover today: the retry re-creates a group (no key), re-resolves the
old substep receipts by key, then hits the registry's `SeriesAlreadyRegistered` — the
registry rejects the second `registerSeries` for the same series, and the engine's failure
path leaves the row at `EXECUTING` forever.

## 3. The exact recovery rule

**Exactly ONE recovery path, owned by the backend.** It must NOT parse the revert string
and must NOT depend on `resulting_resource` (NULL in this class of incident). When the
`issue-series` step of a `bond-series-create` approval fails with code `PD012220`, or the
receipt carries `SeriesAlreadyRegistered` / `PD012216`:

1. Look up the series **from our own DB**: `bond_series` by `terms_hash`
   (`computeTermsHash(p.terms)` is deterministic — handler.ts:36; backend is building this
   reconciler now, based on the boot-time series discovery at backend/bi/src/app.ts:176-190).
2. Verify the chain agrees (read-only, node RPC): the token address in `bond_series.token`
   is a live Noto token; `getSeries(token)` resolves in the registry. These are the two
   on-chain-verifiable facts.
3. If both agree, the chain work of THIS approval is done. Let the engine complete the
   interrupted transition: `EXECUTING → APPROVED` via the engine's own success path
   (i.e. mark the step/handler resolved so the normal write runs), then continue the
   remaining keyed steps (`mint-tranche`, `begin-distribution`) — they are idempotent by
   key, so replaying them is safe or they no-op via prior receipts.
4. If the DB row is missing but the chain series exists (older incident shape), the
   recoverer reads the substep receipts by key
   (`${approvalId}:issue-series:deploy-token` → `receipt.contractAddress` = token,
   `:deploy-private-tracker` → `domainReceipt.receipt.contractAddress` = privateTracker)
   and inserts the `bond_series` row before step 3. Verifiable on chain: receipt success
   + addresses. Group id is NOT derivable on chain (handler.ts:96-100 comment) — it must
   come from the DB row or the original call result, never re-created.

What is chain-verifiable vs DB-sourced: series/token address and receipts = chain;
approval state, `terms_hash` → series link, `group_id`/`private_tracker_address` = DB row.

## 4. Split: paladin-client vs backend

- **backend (critical path):** the reconciler + approval-row transition above. Owns the
  recovery rule end to end. Uses only existing paladin-client APIs
  (`ptx_getTransactionByIdempotencyKey` is already reachable through the SDK shape
  `IdempotentRecoverySdk`, client.ts:666-670; `resolveIdempotentFuture` already exists).
- **paladin-client (nice-to-have, NOT on the critical path):** a typed error carrying the
  existing series address (e.g. extend `receiptFailureError`, errors.ts, to attach the
  parsed selector/address) and/or an exported `recoverSubstepReceipt(sdk, key)` helper.
  Convenience for future callers only.
- **Cross-layer contract change needs lead approval** before anything is typed into
  paladin-client's public surface or mapped to a new HTTP status (errors.ts currently
  guides PD012220 → 409, not 422 — the 422 the caller saw is part of the bug surface).

## 5. Tests (smallest set, unit-level, no cluster)

1. paladin-client: one test of `resolveIdempotentFuture`'s by-key recovery against a mocked
   `IdempotentRecoverySdk` (pattern already exists for it) — proves `PD012220` at send time
   resolves the prior receipt without resubmitting.
2. backend `backend/bi/test/bondSeries.test.ts` (existing mock-port pattern): mock the
   `issue-series` step to throw `PD012220`, pre-seed `bond_series` with the matching
   `terms_hash` → run the recoverer → assert exactly one `bond_series` row, approval ends
   `APPROVED`, `mint-tranche`/`begin-distribution` called with the same keys at most once.
3. Same test with NO `bond_series` row but mocked substep receipts by key → row inserted
   from receipts, then `APPROVED`.

## 6. Explicit non-changes

- No automatic rollback or compensation of orphaned groups/trackers/tokens (gas-only
  orphans; client.ts:2229 ponytail note).
- No group deletion, no new idempotencyKey on `createPrivacyGroup` / `newPrivacyGroup`
  (SDK wrapper limitation stays documented, client.ts:2170-2172).
- No DB schema migration (`resulting_resource` fix is backend's own, already known to the
  lead; this note assumes the column exists post-fix, no ALTER here).
- No contract change, no redeploy, no change to node-side PD012220 semantics.
- No second recovery path besides the backend reconciler in section 3.
