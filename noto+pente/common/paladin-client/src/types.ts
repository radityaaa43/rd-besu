/*
 * The contract between Paladin and the backend: domain-level, one node, one identity.
 * Lives alongside Paladin/common (not replacing it), imported by backend/shared.
 *
 * Per docs/superpowers/sdd/2026-10-05-backend-per-bank-spec.md point 2: the backend never
 * builds ptx_* / pgroup_* payloads itself, and never imports Paladin/bond/src/helpers,
 * lib/platform.ts, or outright.ts -- everything is wrapped here instead.
 *
 * As of 0.3.1 (2026-10-05): every method in this interface is implemented and live-proven --
 * connect/balances/listeners (phase 1), bond series lifecycle/primary subscription (phase 3),
 * and the generic Agreement/Atom-proposal lifecycle (task #8). `sendGroupMessage` was the last
 * PD_NOT_IMPLEMENTED stub, closed in 0.3.1. See CHANGELOG.md for what was proven where.
 *
 * 0.3.2 (config seam, lead decision): the backend must build `PaladinClientConfig` ONLY via
 * `loadClientConfigFile(path, {nodeUrl, wsUrl?, rpcAuth?})` (exported from `./client` and
 * re-exported from `./index`) -- never its own mapping from a contract-data file, which is
 * exactly how the file shape and this interface's real field names drifted apart (task #8/#9
 * finding). That loader also runs `validateClientConfig`, throwing `PD_CLIENT_MISSING_CONFIG`
 * naming the missing field BEFORE a connection is even attempted.
 *
 * 0.4.0 (architecture review, 2026-10-05, BREAKING): unifies the primary-subscription and
 * outright flows onto ONE settlement mechanism -- Agreement + RestrictedAtom -- removing
 * BondSubscription/the old Atom/AtomFactory from the platform path entirely (D1).
 * `createAtom`'s `parties`/`executor` and `proposeAgreement`'s `legs[].from/to` are now
 * LOOKUPS, not addresses, resolved internally (D2). Series registration (`issueSeries`) and
 * reads (`getSeries`) now encode/decode `instrumentType`/`seriesCode`/`isin`/dates/`termsHash`
 * instead of trusting the caller's raw bytes (D3); registry writes (`registerSeries`/
 * `setSeriesStatus`/`updateTerms`) are signed by `bondCustodian`, not `bondIssuer` (D4).
 * `onAtomStatusChanged` listens across every RestrictedAtom instance with one listener, no
 * fixed address (D5). `delegateTradeLeg` verifies the atom's own on-chain operations/
 * cancelOperations/executor against the recorded leg before ever delegating (D6).
 * `verifyDelegatedLeg` gained a required `atomAddress` param and now binds to the real
 * on-chain lock via simulation, not just decoded bytes (D7); `ensureOutrightGroup` always
 * resolves the real custodian as a member and throws (not silently re-creates) on a
 * `knownGroupId` that fails to resume (D8). New: `findGroupsWithMembers`/
 * `ensureInvestorCustodianGroup` (investor+custodian group discovery for the backend),
 * `PD_CLIENT_RECEIPT_TIMEOUT` (retryable, carries `txId` -- distinct from a genuinely failed
 * tx), `PD_CLIENT_WRONG_ROLE` (a BI-only method called by a non-BI client), and the shared
 * `VerifyResult`/`VerifyCode` structured return shape on `verifyDelegatedLeg`/
 * `verifyCancelCall`/`delegateTradeLeg`'s internal check (a stable `code` instead of matching
 * a free-text `reason` string -- see `VerifyCode`'s own doc comment for TRANSIENT vs DEFINITE).
 * `BondSubscription`/`createSubscription`/`resumeSubscription`/`preparePayment`/`prepareBond`/
 * `distributeSubscription` are gone -- see CHANGELOG.md for the full breaking-change list.
 *
 * 0.4.1 (registry v2): `registerSeries` gains a `publicTracker` field and `getSeries` returns
 * it too, closing `PD_CLIENT_UNKNOWN_SERIES` for cross-process/cross-node
 * `getDistributionState`/`getPrice` -- both now resolve the public tracker address via
 * `getSeries(token).publicTracker` (public on-chain via the registry) instead of the in-memory
 * `SeriesContext` cache, which never survived a restart or crossed process/node boundaries. New
 * `resumeSeries` lets BI's backend recover the remaining BI-private half of `SeriesContext`
 * (the issuer+custodian Pente group and its private tracker) after its own process restart, from
 * `groupId`/`privateTracker` it must have persisted from the original `issueSeries` call.
 * `SeriesRegistrationParams`/`IssueSeriesResult` are unchanged; `SeriesRegistryEntry` gained
 * `publicTracker`. Non-breaking except that `issueSeries`'s on-chain `registerSeries` call now
 * requires the v2 registry -- it will revert against the OLD v1 registry ABI/bytecode.
 *
 * 0.4.2 (idempotency bugfix, lead report): a backend DB reset followed by a BI reboot hit
 * "PD012220: idempotencyKey already used ... onboard-primary:bank2:deploy-agreement" --
 * `deployAgreement` called `group.deploy(...).waitForDeploy(...)` directly with no PD012220
 * recovery, so the retry threw instead of returning the ORIGINAL Agreement address.
 * `submitIdempotent`'s recovery logic is now the exported `resolveIdempotentFuture` (client.ts),
 * applied to `deployAgreement` and `issueSeries`'s two deploy substeps (private BondTracker,
 * Noto bond token) -- the only three call sites that deployed via a raw `.waitForDeploy()`
 * with no try/catch. Every other idempotency-keyed method (`propose`/`accept`/`recordLeg`/
 * `recordAtom`/`confirmSettled`/`markFailed`/`cancelAgreement`/`mintTranche`/
 * `sendBondTrackerTx`/`lockToken`/`prepareUnlock`/`delegateLock`/`mintToken`/`addInvestor`)
 * already went through `submitIdempotent` and was already correct -- verified by reading each
 * call site, not assumed, and intentionally untouched here.
 *
 * 0.5.0 (fund-safety fix, live incident): a Pente private contract's address is only unique
 * WITHIN its privacy group -- the same deployer identity + deployment nonce in two DIFFERENT
 * groups produces the SAME address for two completely different contract instances (confirmed
 * live: 6 onboarding Agreement contracts in 6 different groups all deployed to the same
 * address). The client's Agreement cache was keyed by address alone, so a second group's
 * agreement could silently overwrite the first group's cache entry, routing later trade ops
 * into the wrong group's contract. Every method that resolves an Agreement by address now
 * also takes `groupId` as its first parameter -- `acceptAgreement`, `recordLeg`, `recordAtom`,
 * `confirmSettled`, `markFailed`, `cancelAgreement`, `getAgreement`, `delegateTradeLeg` --
 * and `resumeAgreement`'s existing `(agreementAddress, groupId)` params are REORDERED to
 * `(groupId, agreementAddress)` for consistency with every other method (BREAKING). There is
 * no fallback lookup by address alone anywhere.
 *
 * 0.5.1 (group-message sender fix, blocked a real-mode run): `GroupMessage.sender` ("verifier
 * lookup of the sender") is NOT a field Paladin's transport actually produces --
 * pldapi.PrivacyGroupMessage carries no identity-level sender (sdk/go/pkg/pldapi/
 * privacy_group.go:47-62), only `Node`, which the RECEIVING node's transport overwrites from
 * the authenticated mTLS peer (core/go/internal/transportmgr/reliable_msg_handler.go:526) --
 * the raw payload has `sender` undefined at runtime. Every backend check comparing
 * `message.sender` silently dropped every message in real mode. Removed `sender`; added
 * `node: string` (the authenticated sending node) plus `sent`/`received` (ISO timestamps,
 * also present on the real payload and previously discarded). `onGroupMessage` now maps the
 * raw SDK message explicitly instead of casting it as `GroupMessage` directly -- this also
 * fixes a second latent mismatch: the raw field is `group`, not `groupId`.
 *
 * 0.5.2 (D2 -- the backend must never handle a leg's raw on-chain address): new
 * `prepareTradeLeg(groupId, agreementAddress, tradeId, legIndex, recipientLookup,
 * idempotencyKey?)` -- resolves `recipientLookup` to an address itself and asserts it matches
 * the chain's own recorded `leg.to` (`PD_CLIENT_LEG_MISMATCH` otherwise), then locks and
 * prepares the unlock. The backend now calls this ONE method with identities only, never
 * `lockToken`/`prepareUnlock` directly for an Agreement leg. Also: `getAgreement`'s address
 * fields (asset/from/to/atomAddress) are now normalized (`0x` + lowercase) via a single shared
 * `normAddr` -- the old local `norm` added a missing "0x" but never lowercased.
 *
 * 0.5.3 (end-to-end idempotency, blocked the real run's final step): `prepareUnlock`'s
 * client-side `PD_CLIENT_LOCK_ALREADY_PREPARED` guard ran BEFORE a retry with the same
 * `idempotencyKey` ever got a chance at `resolveIdempotentFuture`'s PD012220 recovery -- a
 * redelivered retry (indexer lag made the caller think the leg wasn't prepared yet) hit the
 * guard and dead-lettered instead of recovering the original lockId/unlockCall/cancelCall.
 * Fixed: a call with an `idempotencyKey` now looks up a PRIOR transaction for that exact key
 * FIRST, before the guard runs -- a hit returns the original result unchanged; the guard only
 * ever fires for a genuine re-prepare (no key, or a DIFFERENT key). No signature change.
 * `lockToken`/`recordLeg`/`recordAtom`/`acceptAgreement`/`confirmSettled`/`markFailed` were all
 * checked too -- none have a pre-submit guard of this shape, so they were already end-to-end
 * idempotent via the existing PD012220 recovery path; no code change was needed for those.
 *
 * 0.5.4 (contracts, task #20 -- no TS API change): `BondTracker.sol`'s `_checkTransfer`/
 * `_checkTransfers` now exempt `to == _custodian` from the `InvestorList` registration check.
 * Real incident: BI's `releaseLock`-to-self (recipient = custodian) and redemption's
 * holder->custodian leg both reverted "Investor is not registered", since the custodian is
 * never itself registered on its own series. Scoped narrowly to the custodian recipient only
 * -- every other recipient still goes through the real whitelist unchanged. Also fixed, found
 * by the post-change solidity-auditor delta: `onTransfer`'s sale-notification now excludes
 * `to == _custodian` too (mirrors `onUnlock`'s existing exclusion) -- without it, today's
 * exemption would have made a custodian self-transfer during an active distribution round
 * falsely report a sale to the public tracker. Applies only to series issued with a
 * `BondTracker` deployed from this version or later (no proxy/upgrade path for this private
 * contract) -- `abis/BondTracker.json` rebuilt and copied in from `forge build`.
 *
 * 0.6.0 (task #19 -- coupon / imbalan payment and redemption maturity): adds `getHolders`
 * (BI-only, every holder of a bond token from this node, `available`/`locked` summed from the
 * `NotoCoin`/`NotoLockedCoin` schemas with status "available" so spent/superseded states are
 * never double-counted), `resolveAddress`, `transferCash`/`fundIssuer` (plain Noto
 * transfer/mint on the RD cash token, signed as a configured identity), `cashBalanceOf` (reads
 * the one RD cash token from `config.contractData.cashToken`, no per-call token param), and
 * `burnBond` (Noto has no on-chain `burn` -- it's a Go domain verb; `onlySelf`-gated, so the
 * custodian can only burn its OWN already-received balance, after the redemption bond leg has
 * settled, never before). New `asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"`
 * param on `lockToken`/`prepareUnlock`/`prepareTradeLeg` (plus `prepareTradeLegAs`, a thin
 * wrapper with the identity as a required positional argument) lets a client sign as a
 * DIFFERENT configured same-node identity than its own connection default -- e.g. BI's client,
 * connected as `bondCustodian`, preparing the redemption cash leg owned by `bondIssuer`.
 * Omitting it preserves prior behavior exactly, not a breaking change. New
 * `identities.cashIssuer?: string` config field. Contracts: `BondTracker.sol` now overrides
 * `onBurn` (notifies `BondTrackerPublic` via `PenteExternalCall`, keeping the inherited
 * `onlySelf` gate), and `BondTrackerPublic.sol` gained a matching `onBurn(uint256) onlyOwner`
 * that decrements its own `totalSupply` -- previously never notified of a burn at all, so it
 * only ever grew.
 *
 * 0.6.1 (backend-reported gap): 0.6.0's `asIdentity` act-as-identity mechanism only reached
 * `lockToken`/`prepareUnlock`/`prepareTradeLeg` -- the backend reported that the SAME
 * redemption cash leg (owned by `bondIssuer`, while BI's own client is usually connected as
 * `bondCustodian`) also needs `recordLeg`, `delegateTradeLeg`, and (on a rollback path)
 * `releaseLock` to sign as the leg's actual owner, not just prepare as it. All three gain the
 * same optional trailing `asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"` param,
 * reusing `requireIdentityVerifier` unchanged; `delegateTradeLeg` threads it through to its
 * internal `delegateLock` call, which also gained the param for the same reason. Omitting it
 * preserves prior behavior exactly on every existing call site -- not a breaking change.
 * Separately in this same release (parent session, not this change): a new exported
 * `receiptFailureError` helper (`src/errors.ts`) is now used by `transferCash`/`fundIssuer`/
 * `burnBond`, so their thrown error's `.code` surfaces Paladin's own real failure code (e.g.
 * `PD200005` for insufficient funds) instead of a generic fallback code.
 */

export interface RpcAuthCredentials {
  username: string;
  password: string;
}

export interface PaladinClientConfig {
  /** This bank's OWN node only -- e.g. "http://127.0.0.1:31648". Never another bank's node. */
  nodeUrl: string;
  /** Derived from nodeUrl (http->ws, https->wss) if omitted -- SAME port as nodeUrl. This does
   * NOT match this cluster's port-forward convention (Paladin/scripts/port-forward-start.sh),
   * where the WS port is a SEPARATE port, HTTP port + 1. Omitting `wsUrl` against a
   * port-forwarded node hangs any WS-based listener (onGroupMessage/onBlockchainEvent/
   * onOwnReceipt) on a silent `[405]` WS-upgrade-rejected reconnect loop against the HTTP-only
   * port instead of failing fast (found live writing the task #8 group-resume proof) -- always
   * pass `wsUrl` explicitly against a port-forwarded cluster. */
  wsUrl?: string;
  /** e.g. "node2". This client talks to exactly this node. */
  nodeId: string;
  /** Local name only, e.g. "investor1". The full lookup used on the wire is `${identity}@${nodeId}`. */
  identity: string;
  /** Absent = this node has no rpcAuth configured (today's live-cluster state: no NetworkPolicy, no rpcAuth secret deployed yet). Read from env by the caller, not by this client -- see README. */
  rpcAuth?: RpcAuthCredentials;
  /**
   * Phase-2 bag: Agreement contract template, AtomFactory address, etc. Opaque to phase 1 --
   * stored on the client instance, not interpreted until phase 2's methods are implemented.
   * Typed as `unknown` deliberately rather than guessing field names for contracts (the generic
   * Agreement contract) that do not exist yet.
   */
  contractData?: Record<string, unknown>;
  /**
   * Phase-3 (task #6b) identities/contract addresses this client needs, now that those methods
   * are implemented (no longer left in the opaque `contractData` bag):
   * - `registryAddress`: the one BondSeriesRegistry (task #6), needed by issueSeries/getSeries/etc.
   * - `bondIssuer`/`bondCustodian`: FULL lookups (`name@nodeId`), e.g. "bondIssuer@node1" --
   *   NOT bare local names. BI's identities live on BI's own node regardless of which client is
   *   calling (an INVESTOR's client calling createSubscription still needs bondCustodian on
   *   BI's node, not its own) -- an earlier draft of this doc wrongly assumed same-node
   *   resolution, caught while writing the live proof, corrected here before it shipped wrong.
   * - `investorCustodianGroupId`: the investor+custodian group createSubscription deploys
   *   into. Created ONCE per investor at onboarding and reused -- never a new group per
   *   subscription. Only meaningful on an investor-identity client.
   */
  identities?: {
    registryAddress?: string;
    bondIssuer?: string;
    bondCustodian?: string;
    investorCustodianGroupId?: string;
    /** 0.6.0: the RD cash notary that funds `bondIssuer`'s paying-agent account (`fundIssuer`). */
    cashIssuer?: string;
  };
}

export interface TokenBalance {
  /**
   * Sum of this identity's UNLOCKED Noto Coin states for this token -- exactly what the
   * domain's own `balanceOf` already returns. Verified by reading the Go implementation
   * (domains/noto/internal/noto/states.go:735-759, `getAccountBalance`): it queries only the
   * unlocked Coin schema, never the locked-coin schema, so there is no double-counting risk
   * between `available` and `locked` below.
   */
  available: string;
  /**
   * Sum of this identity's LOCKED Noto Coin states (NotoLockedCoin schema) for this token --
   * funds this identity has locked (e.g. mid-trade) that are not included in `available`.
   * Platform-extensibility binding rule 5 (docs/superpowers/sdd/2026-10-05-platform-extensibility.md):
   * balances must distinguish available from locked; this is the primitive repo/SLB encumbrance
   * will build on later.
   */
  locked: string;
}

export interface OwnReceipt {
  id: string;
  domain: string;
  success: boolean;
  transactionHash?: string;
  failureMessage?: string;
  /** Domain-specific receipt detail (Noto lock info, Pente deploy address, ...). Left as `unknown` -- callers that need a specific shape narrow it themselves; this client does not re-declare the SDK's own `INotoDomainReceipt`/`IPenteDomainReceipt` unions. */
  domainReceipt?: unknown;
}

export interface BlockchainEvent {
  address: string;
  /** Human Solidity event signature as it was registered, e.g. "AtomDeployed(address addr)". */
  soliditySignature: string;
  data: unknown;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  domain: string;
  topic?: string;
  correlationId?: string;
  data: unknown;
  /**
   * The sending node, set by the RECEIVING node's transport from the authenticated mTLS peer
   * (core/go/internal/transportmgr/reliable_msg_handler.go:526 overwrites this from the peer
   * connection, not from the payload) -- trustworthy at the node level. There is NO
   * identity-level sender available from Paladin: pldapi.PrivacyGroupMessage carries no such
   * field (sdk/go/pkg/pldapi/privacy_group.go:47-62). Do not reintroduce a `sender` field.
   */
  node: string;
  /** ISO timestamp the sending node recorded when it sent the message. */
  sent: string;
  /** ISO timestamp the receiving node recorded when it received the message. */
  received: string;
}

export type ReceiptHandler = (receipt: OwnReceipt) => Promise<void>;
export type BlockchainEventHandler = (event: BlockchainEvent) => Promise<void>;

export interface AtomStatusEvent {
  atomAddress: string;
  status: "Pending" | "Executed" | "Cancelled";
  txHash: string;
  blockNumber: number;
}
export type AtomStatusChangedHandler = (event: AtomStatusEvent) => Promise<void>;
export type GroupMessageHandler = (message: GroupMessage) => Promise<void>;

/**
 * Shared result code for verifyDelegatedLeg / verifyCancelCall / delegateTradeLeg's internal
 * atom-match check (lead requirement, 2026-10-05): matching a free-text `reason` string is
 * fragile for a backend to branch retry-vs-fail logic on, so every rejection also carries a
 * stable `code`.
 *
 * TRANSIENT (`NOT_DELEGATED`, `STATE_NOT_FOUND`) -- an eventual-consistency condition that can
 * resolve on its own; the backend should nack and retry (same idempotencyKey), not fail the
 * trade. `NOT_DELEGATED` means the lock has not been delegated to anyone yet (spender ==
 * owner) -- it may be delegated moments later. `STATE_NOT_FOUND` means a referenced state has
 * not propagated to this node yet (a successful receipt does not mean peer nodes already hold
 * the resulting states).
 *
 * DEFINITE (every other value) -- a real mismatch between what was recorded/delegated and what
 * the contract/lock actually contains. Retrying will not fix it; the backend should cancel the
 * leg/trade and mark it FAILED.
 */
export type VerifyCode =
  | "NOT_DELEGATED"
  | "SPENDER_NOT_ATOM"
  | "LOCKID_MISMATCH"
  | "COMMITMENT_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "RECIPIENT_MISMATCH"
  | "FOREIGN_OUTPUT"
  | "STATE_NOT_FOUND";

export const TRANSIENT_VERIFY_CODES: ReadonlySet<VerifyCode> = new Set(["NOT_DELEGATED", "STATE_NOT_FOUND"]);

export interface VerifyResult {
  ok: boolean;
  /** Absent on ok:true, and on a handful of malformed-input rejections (bad calldata that
   * can't decode at all -- a caller bug, not one of the 8 modeled conditions) that predate any
   * of the 8 checks below and have no natural code of their own; treat a missing code the same
   * as a DEFINITE one (fail, don't retry). */
  code?: VerifyCode;
  reason?: string;
  outputs?: string[];
}

export interface ListenerHandle {
  /** Closes the underlying websocket. Does not delete the server-side named listener -- reconnecting with the same name resumes it. */
  stop(): Promise<void>;
}

/**
 * All three `on*` methods below share these semantics, proven against the live protocol
 * (sdk/typescript/src/websocket.ts, ptx_subscribe/_ack/_nack and pgroup_subscribe/_ack/_nack):
 *
 * - `listenerName` MUST be a stable value from config, never randomly generated per process
 *   start. Paladin checkpoints delivery per listener name server-side, so the same name across
 *   restarts resumes from where it left off; a fresh random name every start would mean
 *   replaying (if a new listener defaults to "from genesis") or silently skipping everything
 *   that happened before this process existed.
 * - Delivery is a BATCH per websocket message (one or more receipts/events/messages at once).
 *   The handler passed to these methods is invoked once per ITEM in the batch, in order, and
 *   is awaited; the batch is ACKed only once every item's handler has resolved. If any item's
 *   handler throws or its promise rejects, the batch is NACKed (not partially acked -- the
 *   protocol has no finer grain than one ack/nack per batch) and Paladin redelivers the whole
 *   batch. This is at-least-once delivery, at BATCH granularity -- handlers must be idempotent.
 *   The backend's own `idempotency_keys` table (docs/superpowers/sdd/2026-10-05-backend-per-bank-spec.md)
 *   already assumes this.
 */
export interface PaladinClient {
  // ---------------------------------------------------------------------------
  // PHASE 1 -- implemented, live-tested
  // ---------------------------------------------------------------------------

  balances(tokenAddress: string): Promise<TokenBalance>;

  /**
   * For the backend's own /health endpoint. `nodeName` from `transport_nodeName`;
   * `indexerHeight` from `bidx_getConfirmedBlockHeight` -- both come back as HEX over the wire
   * despite the underlying SDK typing one of them `number`; this method normalizes both to
   * plain numbers/strings so the caller never has to know that. `chainHeight` is not populated
   * here (no direct Besu RPC wired through this client) -- left undefined, not guessed.
   */
  health(): Promise<{ nodeName: string; indexerHeight: number; chainHeight?: number }>;

  /**
   * Receipts of transactions THIS node originated only -- confirmed
   * (core/go/internal/sequencer/syncpoints/finalize.go:117-120) that a receipt is routed back to
   * the ORIGINATING node, never broadcast to other parties. Never use this to detect another
   * party's action.
   *
   * A BRAND NEW `listenerName` (one Paladin has never seen before) replays this node's entire
   * historical receipt log from genesis, not just receipts from now on -- confirmed live
   * against a long-lived node with 12,000+ historical receipts (2026-10-05 smoke test), where a
   * fresh listener took over 60 seconds to reach a receipt submitted seconds earlier. This is
   * correct behavior for a backend's first-ever startup (nothing should be missed), but a
   * backend that has run before should reuse the SAME `listenerName` every restart so Paladin
   * resumes from its own checkpoint instead of re-replaying history every time.
   */
  onOwnReceipt(
    listenerName: string,
    handler: ReceiptHandler,
    /** `startFromLatest` (default false): skip this node's receipt history and only deliver receipts from the moment the listener is first created. Use for a node with a long pre-existing history the caller doesn't need to reconcile against (proven live: a fresh listener on a 39,000+-receipt node took over a minute to catch up without this). Leave false for a genuinely first-ever startup, where nothing should be skipped. Has no effect once the listener already exists (the floor only applies at creation; see createListenerIdempotent's doc comment in client.ts). */
    options?: { startFromLatest?: boolean }
  ): Promise<ListenerHandle>;

  /** A public base-ledger event on one contract address. Every node sees these regardless of privacy-group membership. */
  onBlockchainEvent(
    listenerName: string,
    address: string,
    eventSignature: string,
    handler: BlockchainEventHandler
  ): Promise<ListenerHandle>;

  /**
   * D5 (architecture review, 2026-10-05): the ONE correct way to learn an atom's settlement
   * outcome -- covers EVERY RestrictedAtom instance (no address filter), decodes the real
   * `AtomStatusChanged(uint8 status)` event (not a hand-written, wrong signature -- C2's
   * finding), and resolves `status` to the friendly enum name. The backend never hand-writes
   * an event signature or listens on a single fixed address for this.
   *
   * A BRAND NEW `listenerName` replays AtomStatusChanged from the chain's earliest history by
   * default -- every RestrictedAtom ever created, not just new ones -- same `startFromLatest`
   * pattern as `onOwnReceipt` (confirmed live, 2026-10-05: a backlog of dozens of historical
   * atoms took over 120s to drain before a just-created one's own event surfaced). Correct for
   * a backend's genuinely first-ever startup; a backend that has run before should either reuse
   * the SAME `listenerName` (resumes from its own checkpoint) or pass `startFromLatest: true`.
   */
  onAtomStatusChanged(listenerName: string, handler: AtomStatusChangedHandler, options?: { startFromLatest?: boolean }): Promise<ListenerHandle>;

  /** pgroup_sendMessage payloads sent to a privacy group this identity is a member of. The only PUSH channel for another party's private-state progress -- pstate has no listener, query-only (confirmed live, cash-leg + correlation spikes, 2026-10-05). */
  onGroupMessage(listenerName: string, groupId: string, handler: GroupMessageHandler): Promise<ListenerHandle>;

  disconnect(): Promise<void>;

  /**
   * Wraps the lock step of bond/src/lib/outright.ts's flow for this identity's own leg.
   * `idempotencyKey` (task #6b, every submit method): passed through to Paladin's own
   * sendTransaction. Paladin REJECTS a reused key (PD012220) rather than returning the
   * original transaction -- client.ts resolves that rejection to the ORIGINAL transaction's
   * receipt via ptx_getTransactionByIdempotencyKey, so a backend redelivery (DB commit failed
   * after Paladin already succeeded) is idempotent end-to-end, not just at the Paladin layer.
   * `asIdentity` (0.6.0): sign as a different configured same-node identity, see `prepareTradeLeg`.
   */
  lockToken(tokenAddress: string, amount: string, idempotencyKey?: string, asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"): Promise<{ lockId: string }>;

  /**
   * `preparedStateId` is the correlation key proven live in Paladin/spikes/correlation/spike.ts
   * (2026-10-05): the exact `domainReceipt.states.preparedOutputs[].id` entry whose `data.owner`
   * matches the first recipient -- NOT `lockId` (which only ever appears on the locked INPUT
   * coin, never on the prepared output; this was a real mistake in an earlier draft of the
   * outright-trade-contract.md design doc, corrected the same day).
   *
   * Throws `PD_CLIENT_LOCK_ALREADY_PREPARED` BEFORE sending anything if this lockId already has
   * a prepared unlock (its `spendCommitment` is already set) -- re-preparing is allowed on-chain
   * pre-delegation but changes the spendCommitment, invalidating any unlockCall/cancelCall a
   * caller already stored from the first prepare (the preparePayment/prepareBond bug this guard
   * closes at the client layer). Pass `{ allowRePrepare: true }` for an intentional re-prepare.
   *
   * Task #17 (BREAKING-adjacent behavior fix, not a signature change): this guard only applies
   * to a GENUINE re-prepare (no `idempotencyKey`, or a DIFFERENT one). A call with the SAME
   * `idempotencyKey` as an earlier successful call is a retry, not a re-prepare -- it looks up
   * that earlier call's own result FIRST and returns it unchanged, never reaching the guard.
   * Real incident: a redelivered retry (indexer lag made the caller think the leg wasn't
   * prepared yet) hit this guard and dead-lettered instead of recovering.
   *
   * `recipients[].to` is a Paladin LOOKUP (`name@nodeId`), NOT a raw 0x address -- the
   * implementation resolves it via `sdk.getVerifiers(r.to)[0]`. A raw address here USED TO
   * silently resolve to a different, unrelated identity (confirmed live while writing the
   * task #8 live proof: the prepared output ended up owned by neither party) -- now throws
   * `PD_CLIENT_INVALID_RECIPIENT` BEFORE sending anything instead (fund-safety fix,
   * 2026-10-05). This is the opposite convention from `AgreementLeg.from`/`to`/
   * `delegateLock`'s `delegateAddress`, which DO take raw addresses -- don't mix them up.
   */
  prepareUnlock(
    tokenAddress: string,
    lockId: string,
    recipients: { to: string; amount: string }[],
    idempotencyKey?: string,
    options?: { allowRePrepare?: boolean },
    asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"
  ): Promise<{ lockId: string; unlockCall: string; cancelCall: string; preparedStateId: string }>;

  /**
   * REQUIRED ORDER for a task #8 Agreement trade leg (lead decision, 2026-10-05): never
   * delegate a leg's lock to a trade atom until `getAgreement(agreementAddress, tradeId)
   * .atomAddress` is non-zero (state ATOM_CREATED) -- i.e. only AFTER `recordAtom` has already
   * been called. recordAtom now runs right after `createAtom`, before any leg delegates, so
   * `delegateAddress` here should always be a value read back from `getAgreement`, never one
   * the caller assembled itself ahead of recordAtom. This isn't enforced on-chain (Agreement
   * and Noto are different domains -- Noto's delegateLock has no way to check Agreement's
   * state), so it's a hard backend/client rule, not a contract guarantee: delegating early
   * reopens the exact deadlock task #8 exists to fix, since before ATOM_CREATED,
   * `Agreement.cancel()` is only an attestation and was never able to release a delegated lock
   * (see Agreement.sol's own cancel() doc comment).
   *
   * `asIdentity` (0.6.1): sign as a different configured same-node identity, see
   * `prepareTradeLeg` -- delegateLock's own on-chain owner check requires the signer to be the
   * lock's actual owner.
   */
  delegateLock(tokenAddress: string, lockId: string, delegateAddress: string, idempotencyKey?: string, asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"): Promise<void>;

  /**
   * D6 (architecture review, 2026-10-05): the SAFE way to delegate a trade leg -- C3's
   * finding: a group-message `data.atomAddress` with no authentication was being delegated to
   * directly. Reads the real atom address from `getAgreement` (never from a message), then
   * reads the ATOM'S OWN on-chain `operations`/`cancelOperations`/`executor` and refuses
   * (`PD_CLIENT_ATOM_MISMATCH`) unless this leg's recorded `unlockCall`/`cancelCall` genuinely
   * appear in them and the executor is bondCustodian (if configured). Only then calls
   * `delegateLock`. Group messages remain notifications only -- never authority for what
   * actually gets delegated.
   *
   * The unlockCall/cancelCall match check (lead requirement, 2026-10-05) is internally built
   * on the same `VerifyResult`/`VerifyCode` shape as `verifyDelegatedLeg`/`verifyCancelCall`
   * (reusing `LOCKID_MISMATCH` for a leg whose recorded call doesn't appear in the atom's
   * operations/cancelOperations) before being thrown as `PD_CLIENT_ATOM_MISMATCH` -- this
   * method still returns `Promise<void>` (it performs the delegation, not just a check), so
   * the structured result is an implementation detail of how the mismatch is classified, not a
   * new return shape on this method itself.
   *
   * `asIdentity` (0.6.1): sign as a different configured same-node identity, see
   * `prepareTradeLeg` -- threaded through to the internal `delegateLock` call.
   */
  delegateTradeLeg(groupId: string, agreementAddress: string, tradeId: string, legIndex: number, idempotencyKey?: string, asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"): Promise<void>;

  /**
   * Releases a lock that has NOT been delegated (a rejected subscription, or a trade cancelled
   * before delegation) back to its own owner -- prepareUnlock-to-self + a single-leg cancel
   * atom (delegate to it, execute), the same proven mechanism as
   * `bond/src/lib/outright.ts`'s `rollback()`/`recoverTrade()`, just for one leg instead of N.
   * Replaces the backend's `cancelPreparedPayment` placeholder.
   * If the lock has ALREADY been delegated, throws `PD_CLIENT_LOCK_DELEGATED` BEFORE sending
   * any transaction -- recovery for a delegated lock goes through the trade atom's own
   * `cancel()` (task #8's RestrictedAtom fix), never this method.
   *
   * `asIdentity` (0.6.1): sign as a different configured same-node identity, see
   * `prepareTradeLeg` -- threaded through to the internal prepareUnlock-to-self and
   * delegateLock-to-atom calls (both have their own on-chain owner check). The final
   * createAtom/executeAtom steps are unaffected -- they pick who is allowed to EXECUTE the
   * self-release atom, not who owns the lock being released.
   */
  releaseLock(tokenAddress: string, lockId: string, idempotencyKey?: string, asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"): Promise<void>;

  /** BI-only in practice (this node's identity must be the token's notary), not enforced by this client -- Paladin itself will reject the transaction if the calling identity isn't the notary. Not in the lead's idempotencyKey list (task #6b) -- no param here, unlike every other submit method. `to` is a lookup (`name@node`), not a raw address -- throws `PD_CLIENT_INVALID_RECIPIENT` BEFORE sending anything if it looks like one (fund-safety fix, 2026-10-05: a raw address used to silently resolve to a different identity). */
  mintToken(tokenAddress: string, to: string, amount: string, idempotencyKey?: string): Promise<void>;

  /**
   * 0.6.0: every holder of `token`, as seen from THIS node. BI-only in practice -- throws
   * `PD_CLIENT_WRONG_ROLE` if this client's own identity is not the configured
   * `bondCustodian` (the token's notary; same hard gate as `deployAgreement`), because a
   * non-notary node only sees its own states and would otherwise return a silently incomplete
   * result instead of a visibly-refused one. `available`/`locked` are summed separately (two
   * different Noto state schemas, NotoCoin vs NotoLockedCoin, both queried with status
   * "available" so spent/superseded states are never double-counted). `owner` is a raw
   * address (0x + lowercase, via `resolveAddress`'s same normalization) -- there is no
   * address-to-lookup reverse API in Paladin; mapping it to a participant is the caller's job.
   * `blockHeight` is read after both state queries, so it never predates the states it
   * describes -- still a live read under a short hold, not a true historical snapshot (Paladin
   * has no such API).
   */
  getHolders(token: string): Promise<{ holders: { owner: string; available: string; locked: string }[]; blockHeight: string }>;

  /** 0.6.0: `name@node` -> address, normalized (0x + lowercase) the same way `getHolders`' `owner` is. */
  resolveAddress(lookup: string): Promise<string>;

  /**
   * 0.6.0: plain Noto transfer on the RD cash token (deployed notaryMode "hooks" with a plain
   * ERC20 tracker, bootstrap-platform.ts:273 -- balance mirror only, no whitelist), signed as a configured identity other than this client's own default --
   * e.g. coupon/imbalan payment or redemption principal, `bondIssuer@node1 -> holder`. Returns
   * the pending transaction's id, captured before the receipt is awaited.
   */
  transferCash(fromIdentity: "bondIssuer" | "bondCustodian" | "cashIssuer", toLookup: string, amount: string, idempotencyKey?: string): Promise<{ txId: string }>;

  /** 0.6.0: `cashIssuer@node1` mints RD to `bondIssuer@node1`, funding the paying-agent account. Plain mint, same shape as `transferCash`. */
  fundIssuer(amount: string, idempotencyKey?: string): Promise<{ txId: string }>;

  /** 0.6.0: RD balance of an arbitrary BI-hosted identity, against this deployment's one RD cash token (`config.contractData.cashToken`). */
  cashBalanceOf(identity: string): Promise<{ available: string; locked: string; balance: string }>;

  /**
   * 0.6.0: burn by the custodian. Noto has no on-chain `burn` function -- it is a
   * domain-level verb implemented in Go, same shape as `mint`/`transfer`. `onBurn` is
   * `onlySelf`-gated (inherited unmodified from `NotoTrackerERC20`): the custodian can only
   * ever burn its OWN already-received balance, never an arbitrary holder's directly -- for
   * redemption, the bond leg (holder -> custodian) MUST settle before this is called, never
   * the reverse.
   */
  burnBond(token: string, amount: string, idempotencyKey?: string): Promise<{ txId: string }>;

  /**
   * 0.6.0: `prepareTradeLeg`, signed as a configured identity other than this client's own
   * default -- e.g. redemption's cash leg, owned by `bondIssuer@node1`. Thin wrapper over
   * `prepareTradeLeg`'s own `asIdentity` param, with the identity moved to a required
   * positional argument instead of a trailing optional one.
   */
  prepareTradeLegAs(
    identity: "bondIssuer" | "bondCustodian" | "cashIssuer",
    groupId: string,
    agreementAddress: string,
    tradeId: string,
    legIndex: number,
    recipientLookup: string,
    idempotencyKey?: string
  ): Promise<{ lockId: string; unlockCall: string; cancelCall: string; preparedStateId: string }>;

  /** `members[]` are lookups (`name@node`), not raw addresses -- throws `PD_CLIENT_INVALID_RECIPIENT` on any that look like one, same fund-safety fix as `mintToken`. */
  createPrivacyGroup(members: string[]): Promise<{ groupId: string; groupAddress: string }>;
  resumePrivacyGroup(groupId: string): Promise<{ groupId: string; groupAddress: string }>;

  /**
   * 0.4.0 backend addition (2026-10-05): group ids are random (D8's own finding, same root
   * cause) -- this is the real replacement for the backend's deterministic
   * `group-investor-custodian-<bankId>` string. Filters to groups whose member SET is exactly
   * `memberLookups` (no extras, none missing), not just "contains these members".
   */
  findGroupsWithMembers(memberLookups: string[]): Promise<{ groupId: string; members: string[]; name?: string; createdAt: string }[]>;
  /**
   * Role-dependent: BI (this client's own identity == config.identities.bondCustodian)
   * creates the group if it's not there yet; any other identity only finds it, throwing
   * `PD_CLIENT_GROUP_NOT_FOUND` if BI hasn't created it yet (the backend's job to retry).
   * Persists nothing -- BI calls this once per investor, for potentially many investors,
   * unlike `ensurePrimaryGroup` (this client's own single relationship).
   */
  ensureInvestorCustodianGroup(investorLookup: string): Promise<{ groupId: string }>;
  /**
   * pgroup_sendMessage, implemented in 0.3.1 (was the last PD_NOT_IMPLEMENTED stub -- the
   * whole backend outbox flow, primary and outright, depends on it). `idempotencyKey` is
   * accepted for signature consistency with every other submit method but is NOT forwarded
   * anywhere -- `correlationId` is the only related wire field, and (confirmed LIVE, not just
   * from the type def) it's validated server-side as a real UUID, not free-form metadata
   * (`PD020704: invalid UUID length` on anything else, e.g. a `tradeId:topic` string). There
   * is no RPC-level reused-key rejection the way `submitIdempotent` gets for transactions. The
   * receiver is the real dedup boundary: it must dedupe by `tradeId:topic` (or equivalent)
   * itself.
   */
  sendGroupMessage(groupId: string, topic: string, data: unknown, idempotencyKey?: string): Promise<void>;

  /**
   * Generic Agreement contract (task #8, docs/superpowers/sdd/2026-10-05-outright-trade-
   * contract.md): productType + legs[], outright is the first productType value. ONE Agreement
   * contract per relationship (per 3-party group), reused across every future trade between
   * that pair via a tradeId-keyed mapping inside the contract -- NOT one deploy per trade
   * (matches the doc's own "group created once per relationship" reasoning, and
   * BondSeriesRegistry's one-registry-many-series pattern, not BondSubscription's
   * one-deploy-per-instance pattern).
   */
  /**
   * No deterministic group id (lead question, 2026-10-05, answered by reading Paladin's own
   * groupmgr.CreateGroup source): the genesis salt is ALWAYS randomly generated server-side on
   * every call, with no input field to override it, so the SAME members+name NEVER produces
   * the same group id twice, and re-creating is never idempotent -- every call makes a brand
   * new group. Use `ensureOutrightGroup` to get a real group id for a bank pair (creates it
   * once, cached after) instead of trying to compute or guess one.
   *
   * `bankALookup`/`bankBLookup` are lookups (`name@node`), not raw addresses -- same
   * `PD_CLIENT_INVALID_RECIPIENT` fund-safety guard as `mintToken`/`prepareUnlock`.
   */
  ensureOutrightGroup(bankALookup: string, bankBLookup: string, knownGroupId?: string): Promise<{ groupId: string }>;
  /** Deploys the Agreement contract once into an EXISTING 3-party group -- get `groupId` from
   * `ensureOutrightGroup` first, not a self-computed id. */
  deployAgreement(groupId: string, idempotencyKey?: string): Promise<{ agreementAddress: string }>;
  /**
   * Resolves this client instance's in-memory agreement/group cache WITHOUT deploying or
   * proposing -- for a counterparty who knows `agreementAddress`+`groupId` (e.g. from the
   * backend, out of band) but never called deployAgreement/proposeAgreement itself. Same
   * resumability role as resumePrivacyGroup/resumeSubscription; same in-memory-only caveat as
   * every other *Context map in this client (see SeriesContext's doc comment). Call before
   * acceptAgreement/recordLeg/recordAtom/confirmSettled/markFailed/cancelAgreement/getAgreement
   * if this client has not already seen the agreement in its own process lifetime.
   *
   * 0.5.0: param order swapped to `(groupId, agreementAddress)` -- consistent with every other
   * method here, which all take `groupId` first. BREAKING.
   */
  resumeAgreement(groupId: string, agreementAddress: string): Promise<void>;
  /**
   * 0.6.7 (D31): presence check for an Agreement, via a real view function call (`bi()`) --
   * never reverts-as-signal. Resolves `true` if deployed, `false` only when the group/address
   * has no contract there ("no contract deployed"); anything else throws.
   */
  agreementExists(groupId: string, agreementAddress: string): Promise<boolean>;
  /**
   * `tradeId` is generated by the BACKEND (uuidv7-based, `<bondAddress>:<originBank>:<uuidv7>`
   * per the backend's own source of truth) and passed IN -- lead correction: it is already the
   * base of the backend's own idempotencyKey and persisted in its outbox/DB before this call,
   * so generating a different one here would break retry/idempotency. `legs` here are the
   * PROPOSED terms only (`asset`/`from`/`to`/`amount`); `lockId`/`preparedStateId`/`unlockCall`/
   * `cancelCall` are empty until `recordLeg`.
   */
  proposeAgreement(
    groupId: string,
    agreementAddress: string,
    tradeId: string,
    productType: string,
    legs: AgreementLeg[],
    idempotencyKey?: string
  ): Promise<void>;
  acceptAgreement(groupId: string, agreementAddress: string, tradeId: string, idempotencyKey?: string): Promise<void>;
  /**
   * `cancelCall` (new, task #8 recovery-path fix) comes from the SAME prepareUnlock receipt as
   * `unlockCall` -- BI verifies it too, via `verifyCancelCall`, before `recordAtom`. Both come
   * from this leg's OWN prepareUnlock, BEFORE delegation (see delegateLock's doc comment for
   * the required order: recordAtom now runs before any leg delegates, not after).
   *
   * `asIdentity` (0.6.1): sign as a different configured same-node identity, see
   * `prepareTradeLeg` -- recordLeg signs as the leg's owner, which may differ from this
   * client's connection default.
   */
  recordLeg(
    groupId: string,
    agreementAddress: string,
    tradeId: string,
    legIndex: number,
    lockId: string,
    preparedStateId: string,
    unlockCall: string,
    cancelCall: string,
    idempotencyKey?: string,
    asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"
  ): Promise<void>;
  /**
   * BI-only. REORDERED (lead decision, 2026-10-05): this now runs right after `createAtom`,
   * BEFORE any leg delegates -- not after, as task #8's original design had it. Caller (BI's
   * backend) MUST have already called `verifyCancelCall` for every leg (cancelCall only ever
   * returns a leg's OWN funds to its OWN owner, so it needs no delegation precondition
   * anymore -- see verifyCancelCall's own doc comment). `verifyDelegatedLeg` is NOT a
   * precondition of this call -- it's called separately, per leg, AFTER that leg delegates
   * (reading the now-recorded `atomAddress` from `getAgreement` as the delegation target) and
   * right before `executeAtom`, since unlockCall moves funds to the counterparty and still
   * needs the LockImmutable/delegation guarantee the #5b binding rule established. This method
   * does not call either verify function itself (both are reads against Noto's state store, a
   * different domain than this Pente contract, so the contract cannot enforce either
   * on-chain) -- it only records the atom address BI already built. The atom BI builds MUST
   * include a `cancelOperations` entry per leg (RestrictedAtomFactory.create's new param) so a
   * later cancel() can actually release any leg once it delegates.
   */
  recordAtom(groupId: string, agreementAddress: string, tradeId: string, atomAddress: string, idempotencyKey?: string): Promise<void>;
  /**
   * BI-only -- an ATTESTATION, not an on-chain read (lead correction: a private Pente contract
   * cannot read the public RestrictedAtom's status at all). BI calls this after observing
   * `AtomStatusChanged(Executed)` via its own blockchain event listener (onBlockchainEvent,
   * phase 1).
   */
  confirmSettled(groupId: string, agreementAddress: string, tradeId: string, idempotencyKey?: string): Promise<void>;
  /**
   * BI-only -- an attestation, called after BI (or any party) has already cancelled the
   * underlying RestrictedAtom (which releases any delegated legs, task #8's recovery-path fix)
   * and observed it did not execute.
   */
  markFailed(groupId: string, agreementAddress: string, tradeId: string, idempotencyKey?: string): Promise<void>;
  /**
   * Any party in legs[], or BI. Only while PROPOSED/ACCEPTED/LEGS_PREPARED -- never after
   * ATOM_CREATED (that exit is markFailed, after cancelling the underlying atom directly).
   *
   * Lead decision (2026-10-05): this is safe as a pure attestation (it never moves or
   * releases funds -- Agreement is never a Noto lock's spender) PROVIDED the required order is
   * followed: recordAtom runs before any leg delegates (see delegateLock's doc comment), so
   * every delegation happens strictly inside ATOM_CREATED, where this function is already
   * unreachable (`WrongState`). If a caller ever delegates before recordAtom despite that rule,
   * this function cannot release that leg -- there is no on-chain way for Agreement to know or
   * reach a not-yet-recorded atom. Don't rely on this call for fund safety; rely on the order.
   */
  cancelAgreement(groupId: string, agreementAddress: string, tradeId: string, idempotencyKey?: string): Promise<void>;
  getAgreement(groupId: string, agreementAddress: string, tradeId: string): Promise<AgreementTrade>;

  /**
   * Task #15: the backend must never handle a leg's raw on-chain address (D2) -- this does the
   * whole prepare step from an identity alone. Reads the leg from the chain, asserts the
   * caller IS the leg's recorded owner (`leg.from`) and that `recipientLookup` resolves to
   * EXACTLY the chain's recorded `leg.to` (PD_CLIENT_LEG_MISMATCH otherwise -- never silently
   * substitutes the resolved address for what the chain says), then locks `leg.asset` for
   * `leg.amount` and prepares the unlock to `recipientLookup`. Throws PD_CLIENT_WRONG_ROLE if
   * the caller is not the leg owner.
   *
   * 0.6.0: `asIdentity` lets a client sign as a DIFFERENT configured same-node identity than
   * its own connection default (e.g. BI's client, connected as bondCustodian, preparing a leg
   * owned by bondIssuer for the coupon/redemption cash leg) -- reuses `requireIdentityVerifier`
   * unchanged. Omitting it preserves today's behavior exactly (signs as the client's own
   * identity). See also `prepareTradeLegAs`, a thin wrapper with the identity moved to a
   * required positional argument.
   */
  prepareTradeLeg(
    groupId: string,
    agreementAddress: string,
    tradeId: string,
    legIndex: number,
    recipientLookup: string,
    idempotencyKey?: string,
    asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"
  ): Promise<{ lockId: string; unlockCall: string; cancelCall: string; preparedStateId: string }>;

  /**
   * RestrictedAtom / RestrictedAtomFactory (Paladin/contracts/src, tasks #2/#3, #8's
   * recovery-path fix). `cancelOperations` (task #8, new) is the per-leg release list --
   * EVERY leg that gets delegated to this atom needs a matching entry here (`contractAddress`
   * = the Noto token, `lockId` = that leg's lock, `callData` = that leg's `cancelCall`, already
   * verified by `verifyCancelCall`) or `RestrictedAtom.cancel()` has nothing to release for it.
   * An empty array is valid (e.g. a trade with no delegatable legs), matching the old #2/#3
   * behavior before this param existed.
   *
   * D2 (architecture review, 2026-10-05): `parties`/`executor` are LOOKUPS (`name@node`), not
   * addresses -- resolved internally via getVerifiers before the on-chain call. Matches
   * prepareUnlock's existing convention; one rule everywhere identity flows through this
   * client, no mixed forms (C5's finding).
   */
  createAtom(
    operations: { contractAddress: string; callData: string }[],
    cancelOperations: { contractAddress: string; lockId: string; callData: string }[],
    parties: string[],
    executor: string,
    idempotencyKey?: string
  ): Promise<{ atomAddress: string }>;
  /** executor-only on-chain (RestrictedAtom.execute) -- signed by whichever identity this client is; the on-chain `onlyExecutor` gate is what actually enforces correctness, not the signer. Used to settle both primary and outright trade atoms (D1: one settlement mechanism for every product). */
  executeAtom(atomAddress: string, idempotencyKey?: string): Promise<void>;
  /** Retries one leg's release (RestrictedAtom.retryRelease) after a first cancel() attempt failed for that leg -- see RestrictedAtom.sol's own doc comment. Executor-or-party on-chain, same gate as cancelAtom. */
  retryReleaseAtom(atomAddress: string, legIndex: number, idempotencyKey?: string): Promise<void>;
  /** executor-or-party on-chain (RestrictedAtom.cancel, task #3 correction). Releases any delegated leg with a matching cancelOperations entry (task #8's recovery-path fix) -- see RestrictedAtom.sol's own cancel() doc comment. */
  cancelAtom(atomAddress: string, idempotencyKey?: string): Promise<void>;

  /**
   * Productized task #5b binding check (lead requirement, 2026-10-05): the ONLY safe way to
   * trust an `unlockCall` a counterparty hands over before building/executing an Atom around
   * it. Checks, in order: (1) the lock is ALREADY DELEGATED (getLock(lockId).spender != owner)
   * -- re-prepareUnlock is impossible once delegated (Noto.sol:478-479's `LockImmutable`
   * revert), which is what makes this check unable to be invalidated by a later re-prepare;
   * calling this on a NOT-YET-delegated lock returns `ok: false, reason: "not delegated"`
   * rather than a false pass. (2) decodes `unlockCall` as `spendLock(lockId, spendArgs, data)`
   * and confirms the embedded lockId matches. (3) decodes `spendArgs` as `NotoSpendLockArgs`
   * to get the real, on-chain-enforced `outputs` the call will produce, reads each from this
   * node, and requires the total to `expected.recipient` == `expected.amount` and every other
   * output belongs only to `expected.owner` (legitimate change), never a third party. Used by
   * both the primary-subscription flow (BI verifies the investor's cash leg after
   * preparePayment's delegate step, before executeAtom) and task #8's outright Agreement.
   *
   * `expected.recipient`/`expected.owner` accept EITHER a raw address OR a Paladin lookup
   * (`name@node`) -- fixed in 0.3.1 (lead-found bug matching against the real backend, which
   * always passes lookups): a lookup is resolved to an address via `getVerifiers` on the node
   * that's doing the verifying before comparing against NotoCoin's stored (raw address) owner
   * field. Before this fix, a lookup NEVER matched, so every real-mode call failed closed
   * (every subscription/outright incorrectly rejected).
   *
   * D7 (architecture review, 2026-10-05, BREAKING -- new required `atomAddress` param): bound
   * to the ACTUAL on-chain lock, not just the decoded bytes -- requires `spender ==
   * atomAddress` specifically (a real on-chain read via `getLock`), not just "delegated to
   * someone" (the old check), which would have passed for a lock delegated to the wrong atom.
   *
   * D7 ALSO originally planned a step 4 -- simulating the atom's own `spendLock` call with
   * `from: atomAddress` to bind the verification to the lock's real EIP-712 commitment without
   * reimplementing Noto's server-side hash. REMOVED (live-proof finding, same date): Paladin's
   * `ptx.call` always resolves `from` through the key manager's identity derivation (confirmed
   * against the real cluster and the Go source -- `core/go/internal/txmgr/
   * transaction_submission.go`'s `callTransactionPublic`, `core/go/internal/keymanager/
   * manager.go:241-264`) -- a contract address is not a resolvable signing identity, so this
   * always reverted with Noto's `LockUnauthorized`, regardless of whether the real commitment
   * matched, making it a permanent false reject rather than the intended proof. Unlike a plain
   * Ethereum node's `eth_call`, there is no way to spoof an arbitrary `from` for a read-only
   * simulation here, and no raw eth_call passthrough exists in this SDK either.
   *
   * This is NOT a reopened gap: the `spender == atomAddress` check above (a real read, not a
   * simulation), D6's `delegateTradeLeg` (which already refuses to delegate unless the atom's
   * OWN on-chain `operations`/`cancelOperations` genuinely contain this leg's recorded
   * unlockCall/cancelCall bytes), and recordLeg's one-shot guard (which makes those recorded
   * bytes immutable once genuinely set -- solidity-auditor fix, same date) together already
   * pin the exact bytes that will run at executeAtom time, before this check ever runs. A real
   * commitment mismatch (e.g. a stale lock) still surfaces, just at executeAtom time (via
   * `onAtomStatusChanged`/`confirmSettled` vs `markFailed`), not pre-emptively here.
   * `COMMITMENT_MISMATCH` remains in `VerifyCode` for the lead-specified enum, but this
   * implementation never produces it.
   */
  verifyDelegatedLeg(
    tokenAddress: string,
    lockId: string,
    unlockCall: string,
    expected: { recipient: string; amount: string; owner: string },
    atomAddress: string
  ): Promise<VerifyResult>;

  /**
   * Mirror of verifyDelegatedLeg for the CANCEL path (task #8, lead requirement #3): BI must
   * verify a leg's `cancelCall` too, before createAtom/recordAtom, since it's what actually
   * runs if the trade atom is ever cancelled. Unlike verifyDelegatedLeg, ALL outputs must
   * belong to the single `owner` -- a refund has no "recipient" to split with, and no
   * separately-agreed amount to check against (the point is "give everything back to whoever
   * it came from").
   *
   * NO delegation precondition (lead decision, 2026-10-05, REORDERED from the original task
   * #8 design): this runs BEFORE delegation now (recordAtom, which this gates, runs before any
   * leg delegates -- see delegateLock's doc comment). Safe without it because cancelCall only
   * ever returns a leg's OWN funds to its OWN owner, never a counterparty -- a leg owner who
   * re-prepares after this check just makes their OWN cancelCall stale (it reverts on-chain
   * later, self-harm only), unlike unlockCall, which moves funds to the counterparty and must
   * stay gated on delegation (verifyDelegatedLeg, called separately right before executeAtom).
   *
   * `owner` accepts EITHER a raw address OR a Paladin lookup -- same 0.3.1 fix and reasoning
   * as `verifyDelegatedLeg`'s `expected.recipient`/`expected.owner`.
   */
  verifyCancelCall(tokenAddress: string, lockId: string, cancelCall: string, owner: string): Promise<VerifyResult>;

  // ---------------------------------------------------------------------------
  // PHASE 3 (task #6b) -- registry/series lifecycle, investor list, primary subscription.
  // Lead-confirmed shapes (2026-10-05) -- backend orchestrates the lifecycle-step sequence;
  // this stays per-step, not re-bundled.
  // ---------------------------------------------------------------------------

  /**
   * BI: deploy the issuer+custodian group (members from `PaladinClientConfig.identities
   * .bondIssuer`/`.bondCustodian`), BondTrackerPublic, BondTracker, the Noto bond token, then
   * `BondSeriesRegistry.registerSeries` -- WITHOUT a first mint (that's `mintTranche`, a
   * separate step). `p` is the registry's 10 fields minus the key.
   * ponytail: if this fails halfway, the already-deployed contracts are orphaned (harmless,
   * costs only gas) -- the backend just retries issueSeries from scratch, no partial-state
   * cleanup needed.
   * `idempotencyKey` (multi-step, per the lead's own instruction): derived into a per-substep
   * key (`${key}:deploy-public-tracker`, `:deploy-private-tracker`, `:deploy-token`,
   * `:register-series`) -- group creation itself has no idempotencyKey support in the SDK
   * wrapper used here, so a retry that doesn't get past it still re-creates a new group.
   */
  issueSeries(p: SeriesRegistrationParams, idempotencyKey?: string): Promise<IssueSeriesResult>;
  /**
   * 0.4.1: rebuilds the BI-private half of SeriesContext (the issuer+custodian Pente group and
   * its private BondTracker) after a backend process restart, for a token this client's
   * identity already issued. `groupId` and `privateTrackerAddress` MUST come from BI's own DB --
   * specifically persisted from the ORIGINAL issueSeries call's returned IssueSeriesResult
   * (`groupId`, `privateTracker`) -- because neither value is derivable from any on-chain state
   * Paladin exposes: there is no on-chain mapping from a Noto token to the Pente group that
   * privately hosts its hooks, and no way to enumerate a Pente group's deployed contracts from
   * its id alone. `publicTracker` is deliberately NOT a param here -- v2's whole point is that
   * it's now derivable via `getSeries(token).publicTracker` instead of needing to be cached or
   * persisted at all.
   */
  resumeSeries(token: string, groupId: string, privateTrackerAddress: string): Promise<void>;
  mintTranche(token: string, amount: string, idempotencyKey?: string): Promise<void>;
  beginDistribution(token: string, p: { price: string; minimumDenomination: string }, idempotencyKey?: string): Promise<void>;
  closeDistribution(token: string, idempotencyKey?: string): Promise<void>;
  setActive(token: string, idempotencyKey?: string): Promise<void>;
  /** Write off a stuck/dust round (task #7's forceCompleteDistribution) -- custodian-gated. */
  forceCompleteDistribution(token: string, idempotencyKey?: string): Promise<void>;

  getSeries(token: string): Promise<SeriesRegistryEntry>;
  /** D4: signed by bondCustodian (the registry's onlyOwner), not bondIssuer -- C4's finding: the old signer made every call revert. */
  setSeriesStatus(token: string, status: SeriesRegistryEntry["status"], idempotencyKey?: string): Promise<void>;
  /** D4: same signer fix as setSeriesStatus. `newTermsHash` is normalized to a 0x-prefixed bytes32 hash, never text-encoded (D3). */
  updateTerms(token: string, newTermsHash: string, idempotencyKey?: string): Promise<void>;

  /**
   * The pre-trade guard the lead specified (bond-data-model.md, "paladin #6b: distribution
   * guard"): BI must check this BEFORE prepareBond / distributeSubscription for any
   * subscription, never rely on `TokenDistribution.purchase()`'s revert after the fact.
   * Backed by `BondTrackerPublic.status()`/`availableUnits()`/`trancheCount()`.
   */
  getDistributionState(token: string): Promise<DistributionState>;
  /**
   * TokenDistribution.getPrice(units) (lead addition, 0.3.0) -- reverts InvalidDenomination
   * on-chain if `units * purchasePrice` isn't a multiple of minimumDenomination, same check
   * `purchase()` itself would apply. Throws `PD_CLIENT_NO_DISTRIBUTION_ROUND` if no round has
   * ever started on this token (distribution address still zero).
   */
  getPrice(token: string, units: string): Promise<string>;

  /** InvestorList (the per-bond whitelist, a child contract of BondTracker). bondAddress
   * scoping confirmed by the lead -- one client talks to many bonds over its lifetime.
   * `lookup` is a lookup (`name@node`), not a raw address -- same `PD_CLIENT_INVALID_RECIPIENT`
   * fund-safety guard as `mintToken`/`prepareUnlock`. */
  addInvestor(bondAddress: string, lookup: string, idempotencyKey?: string): Promise<void>;
  setInvestorStatus(bondAddress: string, lookup: string, status: "approved" | "revoked", idempotencyKey?: string): Promise<void>;

  /**
   * D1 (architecture review, 2026-10-05): ONE settlement mechanism for every product --
   * BREAKING CHANGE, 0.4.0. `createSubscription`/`resumeSubscription`/`preparePayment`/
   * `prepareBond`/`distributeSubscription` and BondSubscription.sol are REMOVED. C1: the
   * primary flow settled through the upstream unrestricted `Atom` (via `getOrDeployAtomFactory`),
   * whose `cancel()` has no access control at all -- anyone on chain could strand both legs
   * forever once delegated. The primary subscription now uses the EXACT same generic
   * Agreement + RestrictedAtom primitives outright already proved (task #8), just with
   * `productType = "PRIMARY"`, 2 legs (cash: investor -> custodian; bond: custodian ->
   * investor), in the EXISTING investor+custodian group (`ensurePrimaryGroup`, not
   * `ensureOutrightGroup`). Composed entirely from already-typed methods -- no new
   * "subscription"-specific method is needed:
   *   ensurePrimaryGroup() -> deployAgreement/resumeAgreement -> proposeAgreement(productType
   *   "PRIMARY") -> acceptAgreement -> lockToken+prepareUnlock (each party's own leg) ->
   *   recordLeg x2 -> verifyCancelCall x2 -> createAtom+recordAtom -> delegateTradeLeg x2 (D6)
   *   -> verifyDelegatedLeg x2 -> executeAtom -> confirmSettled.
   * BondTracker hooks (whitelist, distribution accounting via `handleDelegateUnlock`) keep
   * applying unchanged -- the bond leg is still a hooked Noto unlock, domain-level, unaffected
   * by which atom contract calls `spendLock`. `releaseLock` also now goes through
   * `createAtom`/`executeAtom` (RestrictedAtomFactory), not the old AtomFactory/Atom.
   */
  ensurePrimaryGroup(): Promise<{ groupId: string }>;
}

export interface IssueSeriesResult {
  token: string;
  privateTracker: string;
  publicTracker: string;
  groupId: string;
}

/**
 * D3 (architecture review, 2026-10-05): every field here is the HUMAN value -- the client
 * encodes to what the contract actually needs (bytes32/bytes12/unix-seconds uint64) before
 * sending. `instrumentType`/`seriesCode` <= 31 UTF8 bytes (bytes32), `isin` <= 12 UTF8 bytes
 * (the standard ISIN length, bytes12). `issueDate`/`maturityDate` are ISO 8601 date strings
 * (parsed via `Date.parse`, converted to unix seconds). `termsHash` is a hex hash (32 bytes,
 * `0x` prefix optional -- normalized either way, never text-encoded like the others since
 * it's already a hash, not a human string).
 */
export interface SeriesRegistrationParams {
  instrumentType: string;
  seriesCode: string;
  isin: string;
  currencyToken: string;
  faceValue: string;
  issueDate: string;
  maturityDate: string;
  transferRestricted: boolean;
  termsHash: string;
}

/** D3: every registry field, decoded back to human form (previously missing instrumentType/seriesCode/termsVersion entirely). `issueDate`/`maturityDate` come back as ISO 8601 strings. */
export interface SeriesRegistryEntry {
  instrumentType: string;
  seriesCode: string;
  isin: string;
  currencyToken: string;
  faceValue: string;
  issueDate: string;
  maturityDate: string;
  status: "ACTIVE" | "MATURED" | "REDEEMED" | "SUSPENDED";
  transferRestricted: boolean;
  termsHash: string;
  termsVersion: string;
  /** v2 registry field (0.4.1): the public BondTrackerPublic address, already on-chain via the registry itself -- see PaladinClient's resumeSeries doc comment for why this replaced caching it client-side. */
  publicTracker: string;
}

export interface DistributionState {
  status:
    | "INITIALIZED"
    | "ISSUED"
    | "DISTRIBUTION_STARTED"
    | "DISTRIBUTION_COMPLETE"
    | "DISTRIBUTION_CLOSED"
    | "ACTIVE";
  availableUnits: string;
  trancheCount: string;
  /**
   * From the public TokenDistribution behind BondTrackerPublic.distribution() (lead addition,
   * 0.3.0): the investor must be able to read the on-chain price trustlessly, to lock the right
   * amount before BI verifies against the same number. `undefined` before any round has ever
   * started (distribution address still zero -- see BondTrackerPublic.beginDistribution).
   */
  purchasePrice?: string;
  minimumDenomination?: string;
  paymentToken?: string;
}

export interface AgreementLeg {
  /** Noto token (series) address. Lead decision 2026-10-05: `address`, not `bytes32` -- instrument type lives in the series registry, not the leg. This one IS always a contract address, never a lookup (no Paladin identity resolves to a token's own address). */
  asset: string;
  /**
   * D2 (architecture review, 2026-10-05, BREAKING from the 0.3.x convention): a Paladin LOOKUP
   * (`name@node`), NOT a raw address -- `proposeAgreement` resolves it internally via
   * getVerifiers before the on-chain call (C5's finding: requiring a raw address here while
   * `prepareUnlock` required a lookup was exactly the mixed-forms bug). `getAgreement`'s
   * returned legs still come back as addresses (the contract only ever stores addresses --
   * there is no on-chain reverse lookup from address back to identity name). Task #15:
   * `getAgreement` normalizes every address field (asset/from/to/atomAddress) to
   * `0x` + lowercase before returning -- Paladin's own ABI decode of a `pgroup_call` result is
   * NOT consistent about the "0x" prefix or case, so a caller must never compare a raw
   * un-normalized value from here against its own resolved address.
   */
  from: string;
  /** Same as `from` -- a lookup on write, an address on read back from getAgreement. */
  to: string;
  amount: string;
  /** Empty ("") until recordLeg. Logs/UI only -- NOT the correlation key, see preparedStateId. */
  lockId?: string;
  /** Empty until recordLeg. The real correlation key (task #3: domainReceipt.states.preparedOutputs[].id). */
  preparedStateId?: string;
  /** Empty until recordLeg. BI decodes this via verifyDelegatedLeg -- never trust preparedStateId alone (task #5b). */
  unlockCall?: string;
  /** Empty until recordLeg. BI decodes this via verifyCancelCall before recordAtom -- the recovery-path fix (task #8): what runs if the trade atom is ever cancelled after this leg delegates. */
  cancelCall?: string;
  /**
   * 0.6.6 (real incident, task #27b): true only when `preparedStateId` is a real, non-zero
   * value -- i.e. recordLeg actually ran for this leg. Added because a caller checking
   * `!leg.unlockCall` to mean "not recorded yet" got it wrong: an unrecorded leg's `unlockCall`
   * comes back as the string `"0x"` (Solidity's default empty-bytes encoding), which is
   * TRUTHY in JS, so that check silently treated an un-prepared leg as prepared. Use this field
   * instead of inferring recorded-ness from any other field's truthiness.
   */
  prepared: boolean;
}

export interface AgreementTrade {
  tradeId: string;
  productType: string;
  legs: AgreementLeg[];
  state: "PROPOSED" | "ACCEPTED" | "LEGS_PREPARED" | "ATOM_CREATED" | "SETTLED" | "FAILED" | "CANCELLED";
  atomAddress?: string;
}
