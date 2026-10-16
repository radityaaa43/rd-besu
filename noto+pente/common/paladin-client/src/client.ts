import PaladinClientSdk, {
  INotoDomainReceipt,
  IPrivacyGroupMessage,
  NotoFactory,
  NotoInstance,
  PaladinVerifier,
  PaladinWebSocketClient,
  PenteFactory,
  PentePrivacyGroup,
  PentePrivateContract,
  PrivacyGroupWebSocketClient,
  TransactionType,
} from "@lfdecentralizedtrust/paladin-sdk";
import { ethers } from "ethers";
import { readFileSync } from "fs";
import {
  AgreementLeg,
  AgreementTrade,
  AtomStatusChangedHandler,
  BlockchainEvent,
  BlockchainEventHandler,
  DistributionState,
  GroupMessage,
  GroupMessageHandler,
  IssueSeriesResult,
  ListenerHandle,
  OwnReceipt,
  PaladinClient,
  PaladinClientConfig,
  ReceiptHandler,
  SeriesRegistrationParams,
  SeriesRegistryEntry,
  TokenBalance,
  VerifyResult,
} from "./types";
import { PaladinClientError, lockRecoveryError, receiptFailureError, receiptTimeoutError, toPaladinClientError, withReceiptDeadline } from "./errors";
// Artifact JSON files COPIED into src/abis/ (not imported across package boundaries): a
// relative import reaching outside this package (e.g. "../../../contracts/out/...") pulls
// those files into tsc's rootDir inference, which broke `tsc`'s flat build/ output structure
// (nested build/bond/, build/contracts/ instead of build/client.js) -- found while rebuilding
// for the lead's build-staleness report. Re-copy from Paladin/contracts/out/ after any
// BondTracker/BondTrackerPublic/BondSeriesRegistry/InvestorList rebuild; from Paladin/bond/src/
// abis/ for the unchanged upstream ones (AtomFactory/Atom/BondSubscription, never forked).
import bondTrackerArtifact from "./abis/BondTracker.json";
import bondTrackerPublicArtifact from "./abis/BondTrackerPublic.json";
// Public tracker ABI of series deployed before 0.7.0 (upstream-shaped: distribution(), availableUnits(), totalSupply()).
import bondTrackerPublicLegacyArtifact from "./abis/BondTrackerPublicLegacy.json";
import bondSeriesRegistryArtifact from "./abis/BondSeriesRegistry.json";
import investorListArtifact from "./abis/InvestorList.json";
import INotoAbi from "./abis/INoto.json";
import agreementArtifact from "./abis/Agreement.json";
import restrictedAtomArtifact from "./abis/RestrictedAtom.json";
import restrictedAtomFactoryArtifact from "./abis/RestrictedAtomFactory.json";
import tokenDistributionArtifact from "./abis/TokenDistribution.json";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const RAW_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Fund-safety fix (lead-required, 2026-10-05): `sdk.getVerifiers(lookup)` resolves ANY string
// into a verifier, including a raw address -- which it resolves to a DIFFERENT, unrelated
// identity rather than erroring (found live writing the task #8 proof: a raw address silently
// became someone else's funds destination). Every caller-supplied `name@node` lookup that gets
// passed to getVerifiers goes through this guard first, so a raw-address mistake throws
// immediately instead of silently misdirecting funds.
export function requireLookup(value: string, paramName: string): string {
  if (RAW_ADDRESS_RE.test(value)) {
    throw new PaladinClientError("PD_CLIENT_INVALID_RECIPIENT", `${paramName} must be a Paladin lookup ("name@node"), not a raw address -- got ${value}`);
  }
  return value;
}

// 0.6.0: transferCash/fundIssuer/cashBalanceOf all need the RD cash token's address but take
// no token param (confirmed with the backend: this deployment only ever has one) -- it lives
// in contractData.cashToken, the same bootstrap-written field used elsewhere already.
export function requireCashToken(config: PaladinClientConfig): string {
  const cashToken = (config.contractData as { cashToken?: string } | undefined)?.cashToken;
  if (!cashToken) throw new PaladinClientError("PD_CLIENT_MISSING_CONFIG", "config.contractData.cashToken is not set");
  return cashToken;
}

const NOTO_COIN_SCHEMA = "NotoCoin";
const NOTO_LOCKED_COIN_SCHEMA = "NotoLockedCoin";
const DEFAULT_POLL_TIMEOUT = 60000;

// D3 (architecture review, 2026-10-05): encoding belongs in paladin-client, not the backend
// (C6's finding: an ISO date string was being sent raw where a uint64 was expected, plain
// strings raw where bytes12/bytes32 were expected, and termsHash without a 0x prefix --
// Paladin's ABI codec does NOT auto-encode a plain JS string into a Solidity bytesN, unlike
// numeric/address/bool fields). These helpers match Solidity's own bytesN string-literal
// convention exactly (UTF8 bytes left-aligned, zero-padded at the END) -- confirmed against
// the existing BondSeriesRegistry.t.sol fixtures (e.g. `bytes12("FR0100XXXXX")`).
export function toFixedBytes(str: string, byteLen: number): string {
  const bytes = ethers.toUtf8Bytes(str);
  if (bytes.length > byteLen) throw new PaladinClientError("PD_CLIENT_ENCODING_FAILED", `"${str}" is ${bytes.length} bytes, too long for bytes${byteLen}`);
  const padded = new Uint8Array(byteLen);
  padded.set(bytes);
  return ethers.hexlify(padded);
}
export function fromFixedBytes(hex: string): string {
  const bytes = ethers.getBytes(hex.startsWith("0x") ? hex : "0x" + hex);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return ethers.toUtf8String(bytes.slice(0, end));
}
export function toUnixSeconds(isoDate: string): string {
  const ms = Date.parse(isoDate);
  if (Number.isNaN(ms)) throw new PaladinClientError("PD_CLIENT_ENCODING_FAILED", `"${isoDate}" is not a valid date`);
  return String(Math.floor(ms / 1000));
}
export function fromUnixSeconds(unixSeconds: string | number): string {
  return new Date(Number(unixSeconds) * 1000).toISOString();
}
// termsHash is already a hash (backend-computed, e.g. keccak256 of a terms document) -- never
// text-encoded, only normalized to a real 0x-prefixed bytes32.
export function toBytes32Hash(hash: string, paramName: string): string {
  const normalized = hash.startsWith("0x") ? hash : "0x" + hash;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new PaladinClientError("PD_CLIENT_ENCODING_FAILED", `${paramName} must be a 32-byte hex hash, got "${hash}"`);
  }
  return normalized;
}

// BACKLOG #10: issueSeries deploys group + 2 trackers + Noto token BEFORE registerSeries assembles
// its payload, so a bad ISIN/date/hash used to throw mid-way and orphan all of it (two real
// orphaned-approval incidents: tx cc982051, 5bf41ebf). issueSeries calls this FIRST, before any
// deploy, so bad input fails fast with zero on-chain side effects; the caller reuses the
// pre-encoded values instead of re-encoding. One place, no drift between the two payload sites.
export function encodeSeriesFields(p: SeriesRegistrationParams) {
  return {
    instrumentType: toFixedBytes(p.instrumentType, 32),
    seriesCode: toFixedBytes(p.seriesCode, 32),
    isin: toFixedBytes(p.isin, 12),
    issueDate: toUnixSeconds(p.issueDate),
    maturityDate: toUnixSeconds(p.maturityDate),
    termsHash: toBytes32Hash(p.termsHash, "termsHash"),
  };
}

// Bond-series bookkeeping a Noto token address alone can't recover: which Pente group/private
// tracker it lives in. issueSeries populates this; every later per-token phase-3 method reads
// it. 0.4.1 fix (registry v2 adds a public `publicTracker` field): the public tracker address
// no longer lives here at all -- it's derivable from ANY process/node via getSeries(token)
// .publicTracker, so getDistributionState/getPrice read it that way instead of caching it. The
// 3 fields that remain ARE genuinely BI-private (the issuer+custodian Pente group and what lives
// inside it) with no on-chain equivalent to derive them from, so they stay an in-memory cache --
// KNOWN LIMITATION: does NOT survive a backend process restart. resumeSeries (0.4.1) closes that
// remaining gap: given a token this client's identity already issued, plus the groupId and
// privateTrackerAddress BI's own backend persisted from the original issueSeries call, it
// rebuilds this cache without needing a fresh issueSeries.
interface SeriesContext {
  group: PentePrivacyGroup;
  privateTracker: BondTracker;
  investorListAddress: string;
}

// Minimal Pente-hosted wrapper for the forked BondTracker -- same pattern as
// Paladin/bond/src/helpers/bondtracker.ts and Paladin/spikes/reopening/live-proof.ts, but for
// the CURRENT fork's full ABI (onMint/onUnlock/handleDelegateUnlock/forceCompleteDistribution),
// not the old pre-fork artifact bond/src/helpers still points at.
class BondTracker extends PentePrivateContract<unknown> {
  constructor(protected evm: PentePrivacyGroup, public readonly address: string) {
    super(evm, bondTrackerArtifact.abi, address);
  }
  using(paladin: PaladinClientSdk) {
    return new BondTracker(this.evm.using(paladin), this.address);
  }
}

// Same pattern for a bond's InvestorList (a child contract of its BondTracker).
class InvestorList extends PentePrivateContract<unknown> {
  constructor(protected evm: PentePrivacyGroup, public readonly address: string) {
    super(evm, investorListArtifact.abi, address);
  }
  using(paladin: PaladinClientSdk) {
    return new InvestorList(this.evm.using(paladin), this.address);
  }
}

// Same Pente-hosted pattern for task #8's generic Agreement contract.
class Agreement extends PentePrivateContract<unknown> {
  constructor(protected evm: PentePrivacyGroup, public readonly address: string) {
    super(evm, agreementArtifact.abi, address);
  }
  using(paladin: PaladinClientSdk) {
    return new Agreement(this.evm.using(paladin), this.address);
  }
}

// Mirrors the Solidity enum order in Agreement.sol exactly -- index 0 (NONE) never comes back
// from getAgreement (the contract itself reverts TradeNotFound on it).
const AGREEMENT_STATE = ["NONE", "PROPOSED", "ACCEPTED", "LEGS_PREPARED", "ATOM_CREATED", "SETTLED", "FAILED", "CANCELLED"] as const;

// WebSocketSender (sdk/typescript/src/interfaces/websocket.ts) only types `send`/`ack`/
// `getSubscriptionName`, but the concrete classes passed as `sender` (PaladinWebSocketClient /
// PrivacyGroupWebSocketClient, websocket.ts:270-293) both really implement `nack` too -- the
// interface is just narrower than the implementation. Verified by reading the SDK source
// directly rather than assuming.
export interface AckNackSender {
  ack(subscription: string): void;
  nack(subscription: string): void;
}

// `ptx_createReceiptListener` / `ptx_createBlockchainEventListener` / `pgroup_createMessageListener`
// all ERROR on a name that already exists (confirmed by reading the Go source directly --
// core/go/internal/txmgr/receipt_listeners.go:209-222, `MsgTxMgrDuplicateReceiptListenerName`
// "PD012237", and the matching "PD012246"/"PD012507" codes for the other two) -- they are NOT
// idempotent create-or-resume on their own. types.ts's doc comment promises the backend that
// reusing the same `listenerName` across restarts resumes from Paladin's own checkpoint; without
// this, a restart calling onOwnReceipt/onBlockchainEvent/onGroupMessage with the SAME durable
// name it used last time would throw instead of resuming. Treats the specific "already exists"
// code as success -- but ONLY after `verifyExisting` confirms the already-existing listener's
// source/filters actually match what THIS call asked for. Task #4b fix (lead review): swallowing
// "already exists" unconditionally would let a listener name reused for a DIFFERENT
// address/eventSignature/groupId silently attach to the wrong source instead of erroring.
export async function createListenerIdempotent(
  duplicateCode: string,
  create: () => Promise<unknown>,
  verifyExisting: () => Promise<void>
): Promise<void> {
  try {
    await create();
  } catch (err) {
    const wrapped = toPaladinClientError(err);
    if (wrapped.code !== duplicateCode) throw wrapped;
    await verifyExisting();
  }
}

// An event's on-chain identity (its topic hash) is name + input TYPES only -- param names,
// `anonymous`, and `outputs` never affect it. Comparing raw JSON.stringify output was WRONG
// (caught live, task #4b resume test): Paladin's own getBlockchainEventListener echoes the
// stored ABI fragment back with a different key order and an added `outputs: null`, so a
// byte-for-byte comparison flagged a real resume (identical event, identical address) as a
// PD_LISTENER_CONFIG_MISMATCH false positive.
export function eventSignatureOf(fragment: ethers.JsonFragment): string {
  const inputs = (fragment.inputs ?? []).map((i) => i.type).join(",");
  return `${fragment.name}(${inputs})`;
}

export function mismatch(listenerName: string, kind: string, detail: string): never {
  throw new PaladinClientError(
    "PD_LISTENER_CONFIG_MISMATCH",
    `${kind} listener "${listenerName}" already exists with a different configuration: ${detail}`
  );
}

// Client-side guard (lead requirement, found live): a lock-owner-sensitive op (delegateLock,
// prepareUnlock) submitted by an identity that does NOT actually own the lock gets stuck --
// Paladin's endorsement rejects it (PD200018 "State ... is not owned by ...") and the
// coordinator retries that endorsement forever rather than failing the transaction outright,
// which exhausted node1's resources into a CrashLoopBackOff after a few such stuck calls
// (confirmed live, task #6b). This refuses BEFORE any ptx_sendTransaction/pgroup_sendTransaction
// call, so this class of wedge can never be submitted again. Exported (not a class method) so
// it's unit-testable against a mocked sdk without a live cluster -- same pattern as
// createListenerIdempotent/eventSignatureOf/mismatch above.
// Task #6c addition (releaseLock): the SAME delegation check verifyDelegatedLeg's step 1 does,
// extracted standalone since releaseLock needs the OPPOSITE outcome (refuse if DELEGATED,
// rather than refuse if NOT) -- exported so it's unit-testable without a live cluster, same
// pattern as verifyLockOwner/verifyDelegatedLeg.
export interface LockDelegationCheckSdk {
  ptx: {
    call(transaction: any): Promise<unknown>;
  };
}
export async function isLockDelegated(sdk: LockDelegationCheckSdk, fromLookup: string, tokenAddress: string, lockId: string): Promise<{ delegated: boolean; spender: string; owner: string }> {
  const lockInfoResult = (await sdk.ptx.call({
    type: TransactionType.PUBLIC,
    abi: INotoAbi.abi,
    function: "getLock",
    to: tokenAddress,
    from: fromLookup,
    data: { lockId },
  })) as any;
  const lockInfo = lockInfoResult.info ?? lockInfoResult["0"];
  const norm = (a: string) => (a.startsWith("0x") ? a : "0x" + a).toLowerCase();
  return { delegated: norm(lockInfo.spender) !== norm(lockInfo.owner), spender: lockInfo.spender, owner: lockInfo.owner };
}

export async function isLockPrepared(sdk: LockDelegationCheckSdk, fromLookup: string, tokenAddress: string, lockId: string): Promise<boolean> {
  const lockInfoResult = (await sdk.ptx.call({
    type: TransactionType.PUBLIC,
    abi: INotoAbi.abi,
    function: "getLock",
    to: tokenAddress,
    from: fromLookup,
    data: { lockId },
  })) as any;
  const lockInfo = lockInfoResult.info ?? lockInfoResult["0"];
  const norm = (b: string) => (b.startsWith("0x") ? b : "0x" + b).toLowerCase();
  return !/^0x0+$/.test(norm(lockInfo.spendCommitment));
}

// BondTrackerPublic.distribution() -- the public TokenDistribution's address, zero before any
// round has ever started. Standalone/exported (not a class method) so getDistributionState's
// and getPrice's shared lookup is unit-testable against a mocked sdk.ptx.call, same pattern as
// isLockDelegated/isLockPrepared.
export async function readDistributionAddress(sdk: LockDelegationCheckSdk, fromLookup: string, publicTrackerAddress: string): Promise<string> {
  const result = (await sdk.ptx.call({
    type: TransactionType.PUBLIC,
    abi: bondTrackerPublicLegacyArtifact.abi,
    function: "distribution",
    to: publicTrackerAddress,
    from: fromLookup,
    data: {},
  })) as any;
  const raw = result["0"] as string;
  return raw.startsWith("0x") ? raw : "0x" + raw;
}

export type PublicTrackerSchema = "legacy" | "status-only";

// 0.7.0: series deployed before it have the upstream-shaped public tracker (amounts, price and
// totalSupply public); newer ones have the status-only tracker, which answers schema(). A failed
// schema() call means "legacy" only if the legacy distribution() getter then answers --
// otherwise the original error is rethrown, so an unreachable node is never mistaken for a
// legacy series.
export async function detectPublicTrackerSchema(sdk: LockDelegationCheckSdk, fromLookup: string, publicTrackerAddress: string): Promise<PublicTrackerSchema> {
  try {
    const result = (await sdk.ptx.call({
      type: TransactionType.PUBLIC,
      abi: bondTrackerPublicArtifact.abi,
      function: "schema",
      to: publicTrackerAddress,
      from: fromLookup,
      data: {},
    })) as any;
    if (result["0"] === STATUS_ONLY_SCHEMA) return "status-only";
    throw new PaladinClientError("PD_CLIENT_UNKNOWN_TRACKER_SCHEMA", `${publicTrackerAddress} reports schema "${String(result["0"])}", this client knows "${STATUS_ONLY_SCHEMA}"`);
  } catch (err) {
    if (err instanceof PaladinClientError && err.code === "PD_CLIENT_UNKNOWN_TRACKER_SCHEMA") throw err;
    try {
      await readDistributionAddress(sdk, fromLookup, publicTrackerAddress);
      return "legacy";
    } catch {
      throw err;
    }
  }
}

const STATUS_ONLY_SCHEMA = "status-only-v1";

// Legacy series: everything comes from the public tracker and its public TokenDistribution.
export async function readLegacyDistributionState(sdk: LockDelegationCheckSdk, fromLookup: string, publicTrackerAddress: string): Promise<DistributionState> {
  const call = async (fn: string) =>
    ((
      await sdk.ptx.call({
        type: TransactionType.PUBLIC,
        abi: bondTrackerPublicLegacyArtifact.abi,
        function: fn,
        to: publicTrackerAddress,
        from: fromLookup,
        data: {},
      })
    ) as any)["0"];
  const [status, availableUnits, trancheCount] = await Promise.all([call("status"), call("availableUnits"), call("trancheCount")]);
  const result: DistributionState = { status: DISTRIBUTION_STATUS[Number(status)], availableUnits: String(availableUnits), trancheCount: String(trancheCount) };

  const distributionAddress = await readDistributionAddress(sdk, fromLookup, publicTrackerAddress);
  if (distributionAddress.toLowerCase() !== ZERO_ADDRESS) {
    const callDistribution = async (fn: string) =>
      ((
        await sdk.ptx.call({
          type: TransactionType.PUBLIC,
          abi: tokenDistributionArtifact.abi,
          function: fn,
          to: distributionAddress,
          from: fromLookup,
          data: {},
        })
      ) as any)["0"];
    const [purchasePrice, minimumDenomination, paymentToken] = await Promise.all([
      callDistribution("purchasePrice"),
      callDistribution("minimumDenomination"),
      callDistribution("paymentToken") as Promise<string>,
    ]);
    result.purchasePrice = String(purchasePrice);
    result.minimumDenomination = String(minimumDenomination);
    result.paymentToken = paymentToken.startsWith("0x") ? paymentToken : "0x" + paymentToken;
  }
  return result;
}

// Round terms held by the private BondTracker; only reachable by privacy-group members (BI).
export interface PrivateRoundReader {
  availableUnits(): Promise<string>;
  discountPrice(): Promise<string>;
  minimumDenomination(): Promise<string>;
}

// Status-only series: the public tracker has status, tranche count and currency token only.
// Units and price come from the private tracker when this client can read it (BI); otherwise
// those fields are left out -- an investor learns the price from BI, not from the chain.
export async function readStatusOnlyDistributionState(sdk: LockDelegationCheckSdk, fromLookup: string, publicTrackerAddress: string, priv?: PrivateRoundReader): Promise<DistributionState> {
  const call = async (fn: string) =>
    ((
      await sdk.ptx.call({
        type: TransactionType.PUBLIC,
        abi: bondTrackerPublicArtifact.abi,
        function: fn,
        to: publicTrackerAddress,
        from: fromLookup,
        data: {},
      })
    ) as any)["0"];
  const [status, trancheCount, currencyToken] = await Promise.all([call("status"), call("trancheCount"), call("currencyToken") as Promise<string>]);
  const result: DistributionState = { status: DISTRIBUTION_STATUS[Number(status)], trancheCount: String(trancheCount) };
  if (!priv) return result;
  const [availableUnits, discountPrice, minimumDenomination] = await Promise.all([priv.availableUnits(), priv.discountPrice(), priv.minimumDenomination()]);
  result.availableUnits = availableUnits;
  // minimumDenomination is 0 until the first round has begun (same as legacy: no terms before then).
  if (BigInt(minimumDenomination) !== 0n) {
    result.purchasePrice = discountPrice;
    result.minimumDenomination = minimumDenomination;
    result.paymentToken = currencyToken.startsWith("0x") ? currencyToken : "0x" + currencyToken;
  }
  return result;
}

// Price for `units` under the private round terms; same two rules as TokenDistribution.getPrice
// (whole price divisible by minimumDenomination), plus "a round has begun".
export function statusOnlyPrice(units: string, discountPrice: string, minimumDenomination: string): string {
  if (BigInt(minimumDenomination) === 0n) {
    throw new PaladinClientError("PD_CLIENT_NO_DISTRIBUTION_ROUND", "no distribution round yet -- call beginDistribution first");
  }
  const total = BigInt(units) * BigInt(discountPrice);
  if (total % BigInt(minimumDenomination) !== 0n) {
    throw new PaladinClientError("PD_CLIENT_INVALID_DENOMINATION", `${units} units x ${discountPrice} = ${total} is not a multiple of the minimum denomination ${minimumDenomination}`);
  }
  return total.toString();
}

export interface SendGroupMessageSdk {
  pgroup: {
    sendMessage(input: { domain: string; group: string; topic: string; data: unknown; correlationId?: string }): Promise<unknown>;
  };
}
// Last remaining PD_NOT_IMPLEMENTED stub, closed per the lead's 0.3.1 requirement: the whole
// backend outbox flow (primary + outright) depends on this. pgroup_sendMessage has NO
// idempotencyKey field on the wire -- only `correlationId`, which (found LIVE, not just from
// the type def: a free-form string like "tradeId:topic" fails with "PD020704: invalid UUID
// length") is validated server-side as a real UUID, not free-form metadata. A caller's own
// idempotencyKey (e.g. a tradeId-derived string) is essentially never a UUID, so it is NOT
// forwarded as correlationId -- doing so would make sendGroupMessage throw on exactly the
// inputs it's meant to support. There is no RPC-level reused-key rejection the way
// submitIdempotent gets for transactions; the lead's own design already has the RECEIVER
// dedupe by tradeId:topic, which is the real idempotency boundary for this one.
export async function sendGroupMessage(sdk: SendGroupMessageSdk, groupId: string, topic: string, data: unknown): Promise<void> {
  await sdk.pgroup.sendMessage({ domain: "pente", group: groupId, topic, data });
}

// Task #14 (lead report): the raw SDK message has no identity-level sender (only `node`, set by
// the RECEIVING node's transport from the authenticated mTLS peer -- NOT from the payload) and
// uses `group`, not `groupId`. Mapping explicitly here, rather than casting the raw batch
// straight to GroupMessage[] (the previous bug), keeps both mismatches from reappearing silently
// if the SDK's wire shape changes again.
export function toGroupMessage(raw: IPrivacyGroupMessage): GroupMessage {
  return {
    id: raw.id,
    groupId: raw.group,
    domain: raw.domain,
    topic: raw.topic,
    correlationId: raw.correlationId,
    data: raw.data,
    node: raw.node,
    sent: raw.sent,
    received: raw.received,
  };
}

export interface LockOwnerCheckSdk {
  pstate: {
    listSchemas(domain: string): Promise<{ id: string; signature: string; definition: object }[]>;
    queryContractStates(
      domain: string,
      contractAddress: string,
      schemaId: string,
      query: unknown,
      status: string
    ): Promise<{ data: Record<string, unknown> }[]>;
  };
}
export async function verifyLockOwner(
  sdk: LockOwnerCheckSdk,
  domain: string,
  tokenAddress: string,
  lockId: string,
  expectedOwnerAddress: string,
  callerName: string
): Promise<void> {
  const schemas = await sdk.pstate.listSchemas(domain);
  const lockSchema = schemas.find((s) => s.signature.includes("NotoLockInfo_V1"));
  if (!lockSchema) {
    throw new PaladinClientError("PD_CLIENT_LOCK_OWNER_CHECK_FAILED", `could not find the NotoLockInfo_V1 state schema on domain "${domain}"`);
  }
  const states = await sdk.pstate.queryContractStates(domain, tokenAddress, lockSchema.id, { eq: [{ field: "lockId", value: lockId }] }, "all");
  const lockState = states[0];
  if (!lockState) {
    throw new PaladinClientError("PD_CLIENT_LOCK_NOT_FOUND", `no lock state found for lockId ${lockId} on ${tokenAddress}`);
  }
  const actualOwner = String(lockState.data.owner).toLowerCase();
  if (actualOwner !== expectedOwnerAddress.toLowerCase()) {
    throw new PaladinClientError(
      "PD_CLIENT_LOCK_OWNER_MISMATCH",
      `${callerName} called on lock ${lockId}, which is owned by ${actualOwner}, not ${expectedOwnerAddress} -- refusing to submit (this would otherwise endorse-fail and retry forever server-side, see client.ts's verifyLockOwner doc comment)`
    );
  }
}

// Task #5b -> #6c productization (lead requirement, 2026-10-05): the binding check proven live
// in Paladin/spikes/binding-5b/spike.ts, now a real paladin-client capability so the backend
// doesn't hand-rewrite it per call site (needed by both the primary-subscription flow and
// task #8's outright Agreement). Exported as a pure function (mocked-sdk testable) and wrapped
// as a class method below.
export interface VerifyDelegatedLegSdk extends LockOwnerCheckSdk {
  ptx: {
    call(transaction: any): Promise<unknown>;
  };
  getVerifiers(...lookups: string[]): { address(): Promise<string> }[];
}
const NOTO_SPEND_LOCK_ARGS_TUPLE = "tuple(bytes32 txId, bytes32[] inputs, bytes32[] outputs, bytes data, bytes proof)";
// Bug found by the lead matching 0.3.0 against the real backend (2026-10-05): the backend
// passes LOOKUPS (e.g. "investor3@node3") for expected.recipient/owner, not raw addresses --
// these functions used to compare that string directly against NotoCoin's stored (raw
// address) owner field, which NEVER matches a lookup string, so every real call failed closed
// (false negative, every subscription/outright rejected). Fixed by accepting either: a raw
// address is used as-is, anything else is resolved via getVerifiers on the VERIFYING node
// (the node whose pstate is being read -- resolution is local/deterministic, not a remote
// call, so this is safe regardless of which node is actually doing the verifying).
async function resolveToAddress(sdk: { getVerifiers(...lookups: string[]): { address(): Promise<string> }[] }, value: string): Promise<string> {
  if (RAW_ADDRESS_RE.test(value)) return value.toLowerCase();
  return (await sdk.getVerifiers(value)[0].address()).toLowerCase();
}
export async function verifyDelegatedLeg(
  sdk: VerifyDelegatedLegSdk,
  domain: string,
  fromLookup: string,
  tokenAddress: string,
  lockId: string,
  unlockCall: string,
  expected: { recipient: string; amount: string; owner: string },
  atomAddress: string
): Promise<VerifyResult> {
  // 1. D7 (architecture review, 2026-10-05): must be delegated to THIS SPECIFIC atom, not just
  // "delegated to someone" -- the old check only compared spender != owner, which would have
  // passed for a lock delegated to a completely different (e.g. stale, or wrong) atom address.
  // Re-prepareUnlock is impossible once delegated (Noto.sol:478-479 LockImmutable), which is
  // what makes this check trustworthy no matter when it runs relative to execute(). Split into
  // two codes (lead requirement, 2026-10-05): spender == owner means genuinely not delegated
  // yet (NOT_DELEGATED, transient -- may still be in flight); spender == some OTHER address
  // means delegated, but to the wrong thing (SPENDER_NOT_ATOM, definite).
  const lockInfoResult = (await sdk.ptx.call({
    type: TransactionType.PUBLIC,
    abi: INotoAbi.abi,
    function: "getLock",
    to: tokenAddress,
    from: fromLookup,
    data: { lockId },
  })) as any;
  const lockInfo = lockInfoResult.info ?? lockInfoResult["0"];
  const norm = (a: string) => (a.startsWith("0x") ? a : "0x" + a).toLowerCase();
  const lockOwnerAddr = norm(lockInfo.owner);
  const lockSpenderAddr = norm(lockInfo.spender);
  if (lockSpenderAddr === lockOwnerAddr) {
    return { ok: false, code: "NOT_DELEGATED", reason: `lock ${lockId} has not been delegated to anyone yet (spender == owner) -- may still be in flight, retry` };
  }
  if (lockSpenderAddr !== norm(atomAddress)) {
    return { ok: false, code: "SPENDER_NOT_ATOM", reason: `lock ${lockId}'s spender (${lockSpenderAddr}) is not the expected atom (${norm(atomAddress)}) -- delegated to a different atom` };
  }

  // 2. Decode the unlockCall: spendLock(bytes32 lockId, bytes spendArgs, bytes data). The
  // embedded lockId must match -- catches a counterparty swapping in an unrelated lock's call.
  // A decode failure is a malformed-input caller bug, not one of the 8 modeled conditions --
  // left without a code (treated as DEFINITE by convention; see VerifyResult's doc comment).
  let decodedLockId: string;
  let spendArgs: string;
  try {
    const iface = new ethers.Interface(INotoAbi.abi);
    const decoded = iface.decodeFunctionData("spendLock", unlockCall);
    decodedLockId = decoded[0] as string;
    spendArgs = decoded[1] as string;
  } catch (e) {
    return { ok: false, reason: `unlockCall does not decode as spendLock: ${(e as Error).message}` };
  }
  if (norm(decodedLockId) !== norm(lockId)) {
    return { ok: false, code: "LOCKID_MISMATCH", reason: `unlockCall's embedded lockId ${decodedLockId} != expected ${lockId}` };
  }

  // 3. Decode spendArgs -> the real, enforced outputs; read each from this node; total to
  // recipient must match exactly (AMOUNT_MISMATCH otherwise -- this is also the enforcement
  // point for D5's "declared leg amount/asset never checked against the real locked value"
  // finding: callers MUST pass `trade.legs[i].amount` as `expected.amount`, not trust it only
  // got as far as `propose()`/`accept()`), every other output must belong only to the lock
  // owner (FOREIGN_OUTPUT otherwise).
  let outputs: string[];
  try {
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode([NOTO_SPEND_LOCK_ARGS_TUPLE], spendArgs);
    outputs = (decoded.outputs as string[]).map((o) => o.toLowerCase());
  } catch (e) {
    return { ok: false, reason: `spendArgs does not decode as NotoSpendLockArgs: ${(e as Error).message}` };
  }

  const [recipientAddr, ownerAddr] = await Promise.all([resolveToAddress(sdk, expected.recipient), resolveToAddress(sdk, expected.owner)]);

  const schemas = await sdk.pstate.listSchemas(domain);
  const coinSchema = schemas.find((s) => s.signature.includes("NotoCoin("));
  if (!coinSchema) return { ok: false, reason: `could not find the NotoCoin state schema on domain "${domain}"` };

  // Query ALL states for this token/schema on this node (not filtered by owner) so a state
  // genuinely absent here (not yet propagated to this node -- STATE_NOT_FOUND, transient; a
  // successful receipt does not mean peer nodes already hold the resulting states) can be told
  // apart from one that's present but belongs to neither party (FOREIGN_OUTPUT, definite).
  const allStates = await sdk.pstate.queryContractStates(domain, tokenAddress, coinSchema.id, {}, "all");
  const byId = new Map<string, { data: { owner: string; amount: string } }>();
  for (const s of allStates as { id: string; data: { owner: string; amount: string } }[]) byId.set(s.id, s);

  // Money, not float/Number -- an amount bigger than 2^53 silently loses precision through
  // Number() (lead-flagged, architecture review 2026-10-05).
  let totalToRecipient = 0n;
  for (const outId of outputs) {
    const state = byId.get(outId);
    if (!state) return { ok: false, code: "STATE_NOT_FOUND", reason: `output ${outId} has not propagated to this node yet -- retry`, outputs };
    const owner = state.data.owner.toLowerCase();
    if (owner === recipientAddr) {
      totalToRecipient += BigInt(state.data.amount);
    } else if (owner !== ownerAddr) {
      return { ok: false, code: "FOREIGN_OUTPUT", reason: `output ${outId} belongs to ${owner}, neither the expected recipient nor the lock owner`, outputs };
    }
  }
  if (totalToRecipient !== BigInt(expected.amount)) {
    return { ok: false, code: "AMOUNT_MISMATCH", reason: `total to recipient ${totalToRecipient} != expected ${expected.amount}`, outputs };
  }

  // D7's original step 4 -- simulating the atom's own `spendLock(lockId, spendArgs, data)`
  // call with `from: atomAddress` to bind the verification to the lock's real commitment --
  // REMOVED (live-proof finding, 2026-10-05): confirmed against the real cluster that
  // `ptx.call`'s `from` is NEVER passed through literally. Paladin's txmgr always resolves it
  // via the key manager (`core/go/internal/txmgr/transaction_submission.go`'s
  // `callTransactionPublic`, calling `keyManager.ResolveEthAddressNewDatabaseTX`, which in turn
  // always runs `KeyResolver.ResolveKey` -- `core/go/internal/keymanager/manager.go:241-264` --
  // with no passthrough for a string that already looks like an address). A contract address
  // is not a resolvable signing identity, so this simulated `atomAddress as msg.sender` call
  // was silently resolved to some unrelated derived key instead -- it reverts with Noto's
  // `LockUnauthorized(lockId, realSpender, thatUnrelatedAddress)` every time, REGARDLESS of
  // whether the real commitment matches, making the check a permanent false reject, not the
  // intended binding proof. Unlike a plain Ethereum node's `eth_call`, Paladin's ptx_call gives
  // no way to spoof an arbitrary `from` for a read-only simulation -- confirmed no raw eth_call
  // passthrough exists in this SDK either, and paladin-client is architecturally confined to
  // talking only through Paladin's own ptx_*/pstate_* API (see this file's header comment).
  //
  // Removing this step does NOT reopen the gap it was trying to close: step 1 above already
  // confirms `spender == atomAddress` (a real on-chain read, not a simulation); D6's
  // `delegateTradeLeg` already refuses to delegate unless the atom's OWN on-chain
  // `operations`/`cancelOperations` genuinely contain this leg's recorded unlockCall/cancelCall
  // bytes; and recordLeg's one-shot guard (solidity-auditor fix, same date) makes those recorded
  // bytes immutable once genuinely set. So by the time delegation has happened, the exact bytes
  // that will run at executeAtom time are already pinned, on-chain, before this check ever
  // runs -- a real commitment mismatch (e.g. a stale lock) still surfaces, just at executeAtom
  // (via AtomStatusChanged/confirmSettled-vs-markFailed), not pre-emptively here.
  return { ok: true, outputs };
}

// Task #8 lead requirement #3: the mirror of verifyDelegatedLeg for the CANCEL path -- BI must
// verify a leg's cancelCall too, before createAtom, since it's what actually runs if the trade
// atom is ever cancelled after this leg has delegated to it (RestrictedAtom.cancel()'s fix).
// Unlike verifyDelegatedLeg (total to ONE recipient + change to the owner), ALL outputs here
// must belong to the single `owner` -- there's no "recipient" for a refund, and no external
// "expected amount" to check against (the whole point is "give everything back to whoever it
// came from", not match some separately-agreed figure). Same not-yet-delegated refusal as step
// 1 of verifyDelegatedLeg, for the same reason: the check is only meaningful (cannot be
// invalidated by a later re-prepare) once the lock is actually delegated.
export async function verifyCancelCall(
  sdk: VerifyDelegatedLegSdk,
  domain: string,
  fromLookup: string,
  tokenAddress: string,
  lockId: string,
  cancelCall: string,
  owner: string
): Promise<VerifyResult> {
  // Lead decision (2026-10-05, task #8 reorder): unlike verifyDelegatedLeg, this is now called
  // BEFORE delegation -- recordAtom (which this gates) runs right after createAtom, before any
  // leg delegates, so there's no "already delegated" state to check here anymore. Safety still
  // holds: cancelCall only ever returns a leg's OWN funds to its OWN owner (never a
  // counterparty), so a leg owner re-preparing after this check just makes their OWN stale
  // cancelCall revert on-chain later (self-harm, not exploitable against anyone else) -- unlike
  // unlockCall, which moves funds to the counterparty and must stay gated on delegation
  // (LockImmutable) via verifyDelegatedLeg, called separately right before executeAtom.
  const norm = (a: string) => (a.startsWith("0x") ? a : "0x" + a).toLowerCase();

  let decodedLockId: string;
  let cancelArgs: string;
  try {
    const iface = new ethers.Interface(INotoAbi.abi);
    const decoded = iface.decodeFunctionData("cancelLock", cancelCall);
    decodedLockId = decoded[0] as string;
    cancelArgs = decoded[1] as string;
  } catch (e) {
    return { ok: false, reason: `cancelCall does not decode as cancelLock: ${(e as Error).message}` };
  }
  if (norm(decodedLockId) !== norm(lockId)) {
    return { ok: false, code: "LOCKID_MISMATCH", reason: `cancelCall's embedded lockId ${decodedLockId} != expected ${lockId}` };
  }

  let outputs: string[];
  try {
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode([NOTO_SPEND_LOCK_ARGS_TUPLE], cancelArgs);
    outputs = (decoded.outputs as string[]).map((o) => o.toLowerCase());
  } catch (e) {
    return { ok: false, reason: `cancelArgs does not decode as NotoSpendLockArgs: ${(e as Error).message}` };
  }

  const ownerAddr = await resolveToAddress(sdk, owner);

  const schemas = await sdk.pstate.listSchemas(domain);
  const coinSchema = schemas.find((s) => s.signature.includes("NotoCoin("));
  if (!coinSchema) return { ok: false, reason: `could not find the NotoCoin state schema on domain "${domain}"` };

  // Query ALL states for this token/schema (not filtered by owner), same reasoning as
  // verifyDelegatedLeg: tells "not yet propagated to this node" (STATE_NOT_FOUND, transient)
  // apart from "present, but really does belong to someone else" (RECIPIENT_MISMATCH --
  // cancelCall's only valid destination is `owner` itself, there being no separate recipient
  // for a refund; so any output found with a different owner means the refund wouldn't fully
  // return to its rightful owner).
  const allStates = await sdk.pstate.queryContractStates(domain, tokenAddress, coinSchema.id, {}, "all");
  const byId = new Map<string, { data: { owner: string; amount: string } }>();
  for (const s of allStates as { id: string; data: { owner: string; amount: string } }[]) byId.set(s.id, s);

  for (const outId of outputs) {
    const state = byId.get(outId);
    if (!state) return { ok: false, code: "STATE_NOT_FOUND", reason: `output ${outId} has not propagated to this node yet -- retry`, outputs };
    const owner = state.data.owner.toLowerCase();
    if (owner !== ownerAddr) {
      return { ok: false, code: "RECIPIENT_MISMATCH", reason: `output ${outId} belongs to ${owner}, not ${ownerAddr} -- the refund would not fully return to its owner`, outputs };
    }
  }
  return { ok: true, outputs };
}

// Extracted so it's unit-testable without a live websocket: acks the batch only once `onBatch`'s
// promise resolves; nacks (never partially acks) if it rejects. `onError` is called before the
// nack so a caller (or a test) can observe the failure without needing to parse console output.
export function dispatchBatch(
  sender: AckNackSender,
  subscription: string,
  onBatch: () => Promise<void>,
  onError?: (err: unknown) => void
): Promise<void> {
  // Promise.resolve().then(onBatch), not onBatch().then(...): a SYNCHRONOUSLY-throwing onBatch
  // (as opposed to one that returns a rejected promise) would otherwise throw here directly,
  // bypassing .catch() entirely and never reaching sender.nack(). Routing the call itself
  // through .then() catches both cases identically.
  return Promise.resolve()
    .then(onBatch)
    .then(() => sender.ack(subscription))
    .catch((err) => {
      onError?.(err);
      sender.nack(subscription);
    });
}

// 0.4.2 bugfix (lead report, 2026-10-06): a backend DB reset followed by BI reboot hit
// "PD012220: idempotencyKey already used ... onboard-primary:bank2:deploy-agreement" --
// deployAgreement called `group.deploy(...).waitForDeploy(...)` directly, with no try/catch for
// a reused idempotencyKey, so the retry threw instead of returning the ORIGINAL Agreement
// address. submitIdempotent below already solves exactly this for ptx.sendTransaction calls;
// this is that same recovery, pulled out into a plain function so deployAgreement and
// issueSeries's two deploy substeps -- which return a TransactionFuture/PentePrivateDeployFuture
// with a `.id`, not a bare tx id string -- can use it too, and so it's unit-testable against a
// mocked sdk without a live cluster (same convention as isLockDelegated/readDistributionAddress
// above). It works unchanged for Pente privacy-group deploys/sends because Paladin keeps ONE
// transactions table behind both RPC methods: pgroup_sendTransaction ultimately calls the same
// txManager.SendTransactions as ptx_sendTransaction, so the same idempotencyKey uniqueness
// constraint (and the same PD012220 on reuse) applies, and ptx_getTransactionByIdempotencyKey's
// lookup has no domain/type filter, so it finds group-originated transactions too.
// `txId` takes `string | Promise<string>` because that's exactly the shape of a
// TransactionFuture's `.id` -- the SDK sends lazily, the first time something awaits `.id`,
// which is also where the PD012220 rejection actually surfaces, so passing `future.id` straight
// through (rather than something already-awaited) preserves that laziness for the caller.
// `full` is forwarded to pollForReceipt uninterpreted: a Pente GROUP deploy's contract address
// lives at `receipt.domainReceipt.receipt.contractAddress` (only populated with full=true --
// see the SDK's own PentePrivateDeployFuture.waitForDeploy), while a PUBLIC or Noto PRIVATE
// deploy's address is top-level (`receipt.contractAddress`, full=false is fine) -- the caller
// knows which shape it's deploying, this helper doesn't need to.
export interface IdempotentRecoverySdk {
  ptx: {
    getTransactionByIdempotencyKey(idempotencyKey: string): Promise<{ id: string } | undefined>;
  };
  pollForReceipt(id: string, waitMs: number, full?: boolean): Promise<any>;
}
export async function resolveIdempotentFuture(
  sdk: IdempotentRecoverySdk,
  txId: string | Promise<string>,
  idempotencyKey: string | undefined,
  waitMs: number,
  full = false
): Promise<any> {
  let id: string;
  try {
    id = await txId;
  } catch (err) {
    const wrapped = toPaladinClientError(err);
    if (idempotencyKey && wrapped.code === "PD012220") {
      const existing = await sdk.ptx.getTransactionByIdempotencyKey(idempotencyKey);
      if (!existing?.id) throw wrapped;
      id = existing.id;
    } else {
      throw wrapped;
    }
  }
  // D-series (architecture review, 2026-10-05): pollForReceipt returns `undefined` specifically
  // on a TIMEOUT (no receipt ever appeared) -- a real failure (success: false) returns
  // immediately with a receipt instead. Throwing here instead of returning undefined means every
  // caller's own `receipt?.success` check becomes unreachable for the timeout case -- this is
  // the one place that distinguishes it.
  const receipt = await withReceiptDeadline(sdk.pollForReceipt(id, waitMs, full), waitMs, "resolveIdempotentFuture", id);
  if (!receipt) throw receiptTimeoutError("resolveIdempotentFuture", id);
  return receipt;
}

// Task #17 (lead report): resolveIdempotentFuture only recovers a PD012220 thrown AT SEND TIME
// -- it can't help a method with a client-side PRE-submit guard (e.g. prepareUnlock's
// isLockPrepared), because a retry with the same idempotencyKey never reaches the send at all:
// the guard sees the first attempt's own effect already landed and rejects before resolveIdempotentFuture
// gets a chance. Real incident: the investor's cash leg prepared fine, but BI's redelivered
// retry (indexer lag made getAgreement look un-prepared, the backend retried with the SAME key)
// hit PD_CLIENT_LOCK_ALREADY_PREPARED and dead-lettered. Fix: look up a PRIOR transaction for
// this exact key BEFORE running any guard -- if one exists, return ITS result, no guard, no
// new submission. Only when no transaction exists yet for this key does the guard apply (a
// genuine re-prepare attempt, no key or a DIFFERENT key).
export async function findReceiptByIdempotencyKey(sdk: IdempotentRecoverySdk, idempotencyKey: string, waitMs: number, full = false): Promise<any | undefined> {
  const existing = await sdk.ptx.getTransactionByIdempotencyKey(idempotencyKey);
  if (!existing?.id) return undefined;
  const receipt = await withReceiptDeadline(sdk.pollForReceipt(existing.id, waitMs, full), waitMs, "findReceiptByIdempotencyKey", existing.id);
  if (!receipt) throw receiptTimeoutError("findReceiptByIdempotencyKey", existing.id);
  return receipt;
}

// Shared by prepareUnlock's fresh-submit path and its idempotent-recovery path -- both must
// decode a receipt into the exact same result shape, or the two paths could silently drift.
export function decodePrepareUnlockReceipt(receipt: any, lockId: string, firstRecipientAddr: string): { lockId: string; unlockCall: string; cancelCall: string; preparedStateId: string } {
  if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_PREPARE_UNLOCK_FAILED", `prepareUnlock failed: ${receipt?.failureMessage ?? "no receipt"}`);
  const domainReceipt = receipt.domainReceipt as INotoDomainReceipt | undefined;
  const lockInfo = domainReceipt?.lockInfo;
  if (!lockInfo?.unlockCall || !lockInfo?.cancelCall) {
    throw new PaladinClientError("PD_CLIENT_PREPARE_UNLOCK_FAILED", "no unlockCall/cancelCall in domain receipt");
  }
  // Correlation key, proven live in Paladin/spikes/correlation/spike.ts (task #3): the
  // prepared OUTPUT state whose owner matches the first recipient -- NOT lockId, which only
  // ever appears on the locked INPUT, never the output.
  const preparedOutputs = (domainReceipt as any)?.states?.preparedOutputs as { id: string; data: { owner: string } }[] | undefined;
  const ourOutput = preparedOutputs?.find((o) => o.data.owner.toLowerCase() === firstRecipientAddr.toLowerCase());
  if (!ourOutput) throw new PaladinClientError("PD_CLIENT_PREPARE_UNLOCK_FAILED", "no preparedOutputs entry for the first recipient in receipt");
  return { lockId, unlockCall: lockInfo.unlockCall, cancelCall: lockInfo.cancelCall, preparedStateId: ourOutput.id };
}

// 0.5.0 fund-safety fix (live incident, 2026-10-06): a Pente private contract's address is
// only unique WITHIN its privacy group -- same deployer identity + same deployment nonce in
// two DIFFERENT groups produces the SAME address for two completely different contract
// instances (confirmed live: 6 onboarding Agreement contracts in 6 different groups all
// deployed to the same address). Keying the Agreement cache by address alone let a SECOND
// group's agreement silently overwrite the FIRST group's cache entry, so every later
// propose/accept/recordLeg/etc. call for the first group's agreement would have operated on
// the second group's contract instead. Every Agreement cache key is now `(groupId, address)`
// via this function, with no fallback lookup by address alone anywhere.
export function agreementCacheKey(groupId: string, agreementAddress: string): string {
  return `${groupId}:${agreementAddress.toLowerCase()}`;
}

// Task #15 (lead report): Paladin's own ABI decode of a `pgroup_call` result is inconsistent
// about the "0x" prefix on `address` fields (same quirk already found for executor() in
// _checkAtomMatchesLeg and for readDistributionAddress) -- getAgreement's own local `norm`
// added "0x" but never lowercased, so two addresses that are the SAME on-chain value could
// still fail a strict string equality check downstream (e.g. prepareTradeLeg's recipient
// match below) purely over case. One shared helper, used everywhere an address coming back
// from a contract call is compared or returned to a caller.
export function normAddr(a: string): string {
  return (a.startsWith("0x") ? a : "0x" + a).toLowerCase();
}

// 0.6.6 (real incident, task #27b): an un-recorded Agreement leg's unlockCall/cancelCall come
// back as the literal string "0x" (Solidity's empty-bytes encoding) and lockId as
// bytes32(0) -- both of which are TRUTHY in JS, so a caller checking `!leg.unlockCall` to mean
// "not recorded" gets it backwards. This is the one place that distinguishes "empty/unset hex"
// from "has a real value", used both to guard recordLeg's own inputs and to compute
// AgreementLeg.prepared in getAgreement.
export function isZeroHex(value: string | undefined): boolean {
  return !value || /^0x0*$/i.test(value);
}

export function requireLegOwner(legFrom: string, callerAddress: string, legIndex: number, tradeId: string): void {
  if (normAddr(legFrom) !== normAddr(callerAddress)) {
    throw new PaladinClientError(
      "PD_CLIENT_WRONG_ROLE",
      `leg ${legIndex} of trade ${tradeId} is owned by ${legFrom}, not the caller (${callerAddress}) -- only the leg owner may prepare it`
    );
  }
}

export function requireLegRecipientMatch(legTo: string, resolvedRecipientAddress: string, recipientLookup: string, legIndex: number, tradeId: string): void {
  if (normAddr(legTo) !== normAddr(resolvedRecipientAddress)) {
    throw new PaladinClientError(
      "PD_CLIENT_LEG_MISMATCH",
      `recipientLookup "${recipientLookup}" resolves to ${resolvedRecipientAddress}, but leg ${legIndex} of trade ${tradeId}'s recorded recipient is ${legTo} -- refusing to prepare an unlock to the wrong party`
    );
  }
}

class PaladinClientImpl implements PaladinClient {
  private lockedSchemaId: Promise<string | undefined> | undefined;
  private coinSchemaId: Promise<string | undefined> | undefined;
  private sockets: { close(wait?: boolean): Promise<void> }[] = [];
  // token (lowercased) -> its series context. See SeriesContext's own doc comment for the
  // in-memory-only limitation.
  private seriesContexts = new Map<string, SeriesContext>();
  // This identity's reused investor+custodian group (task #6b: "created once per investor at
  // onboarding, reused -- never a new group per subscription"). Config-provided id wins if set;
  // otherwise the first createSubscription call creates one and this caches it for the rest of
  // this client's lifetime.
  private investorCustodianGroup: Promise<PentePrivacyGroup> | undefined;
  // sorted "bankA|bankB" pair key -> its outright group. Same in-memory-only caveat; a real
  // cross-process cache is the caller's job (pass `knownGroupId` once it's been created once --
  // see ensureOutrightGroup's own doc comment).
  private outrightGroups = new Map<string, Promise<PentePrivacyGroup>>();
  // agreementCacheKey(groupId, agreementAddress) -> its group. Same in-memory-only caveat as
  // seriesContexts. Populated by deployAgreement, proposeAgreement, or resumeAgreement. Keyed
  // on (groupId, address), NOT address alone -- see agreementCacheKey's doc comment for why
  // (0.5.0 fund-safety fix: address alone collides across different privacy groups).
  private agreements = new Map<string, { group: PentePrivacyGroup; agreement: Agreement }>();

  constructor(
    private readonly sdk: PaladinClientSdk,
    private readonly verifier: PaladinVerifier,
    private readonly config: PaladinClientConfig
  ) {}

  // ---------------------------------------------------------------------------
  // PHASE 1
  // ---------------------------------------------------------------------------

  async balances(tokenAddress: string): Promise<TokenBalance> {
    try {
      const token = new NotoInstance(this.sdk, tokenAddress);
      const available = await token.balanceOf(this.verifier, { account: this.verifier.lookup });

      let locked = 0n;
      const schemaId = await this.getLockedSchemaId();
      if (schemaId) {
        const myAddress = await this.verifier.address();
        const states = await this.sdk.pstate.queryContractStates(
          "noto",
          tokenAddress,
          schemaId,
          { eq: [{ field: "owner", value: myAddress }] },
          "available"
        );
        for (const state of states) {
          locked += BigInt((state.data as { amount: string }).amount);
        }
      }

      return { available: available.totalBalance, locked: locked.toString() };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // NotoLockedCoin is only registered once a hooks-mode Noto token with at least one lock has
  // existed on this node; a fresh node may not have the schema yet. Cached once found; retried
  // (not cached as "absent") if not found yet, since it can appear later.
  private async getLockedSchemaId(): Promise<string | undefined> {
    if (this.lockedSchemaId) {
      const cached = await this.lockedSchemaId;
      if (cached) return cached;
    }
    this.lockedSchemaId = (async () => {
      const schemas = await this.sdk.pstate.listSchemas("noto");
      const found = schemas.find((s) => (s.definition as { name?: string }).name === NOTO_LOCKED_COIN_SCHEMA);
      return found?.id;
    })();
    return this.lockedSchemaId;
  }

  // Same caching shape as getLockedSchemaId, for the UNLOCKED coin schema (matched by
  // signature, the same way verifyDelegatedLeg already does -- NotoCoin has no stable
  // `definition.name` the way NotoLockedCoin does).
  private async getCoinSchemaId(): Promise<string | undefined> {
    if (this.coinSchemaId) {
      const cached = await this.coinSchemaId;
      if (cached) return cached;
    }
    this.coinSchemaId = (async () => {
      const schemas = await this.sdk.pstate.listSchemas("noto");
      const found = schemas.find((s) => s.signature.includes("NotoCoin("));
      return found?.id;
    })();
    return this.coinSchemaId;
  }

  async onOwnReceipt(
    listenerName: string,
    handler: ReceiptHandler,
    options?: { startFromLatest?: boolean }
  ): Promise<ListenerHandle> {
    // startFromLatest: task #4b -- for a node with a long receipt history (proven live: 39,000+
    // on node2 this session), a fresh listener otherwise replays from sequence 0, taking over a
    // minute to catch up (see onOwnReceipt's own doc comment in types.ts). Default stays false
    // (full replay) -- the safe behavior for a backend's genuinely first-ever startup, where
    // nothing should be skipped. The backend opts in per the lead's instruction once it knows
    // it's attaching to a node with pre-existing history it doesn't need to reconcile against.
    let sequenceAbove: number | undefined;
    if (options?.startFromLatest) {
      const latest = await this.sdk.ptx.queryTransactionReceipts({ sort: ["-sequence"], limit: 1 });
      sequenceAbove = latest[0]?.sequence ?? 0;
    }
    await createListenerIdempotent(
      "PD012237",
      () => this.sdk.ptx.createReceiptListener({ name: listenerName, filters: sequenceAbove !== undefined ? { sequenceAbove } : undefined, options: { domainReceipts: true } }),
      async () => {
        const existing = await this.sdk.ptx.getReceiptListener(listenerName);
        if (!existing) mismatch(listenerName, "receipt", "reported as duplicate but not found on refetch");
        // Only `options.domainReceipts` is caller-specified and stable across calls for this
        // listener kind -- `filters.sequenceAbove` is a one-time floor applied only at creation,
        // not something a later call can or should re-validate (the existing listener may
        // legitimately have already advanced far past whatever floor created it).
        if (existing.options?.domainReceipts !== true) {
          mismatch(listenerName, "receipt", `options.domainReceipts=${existing.options?.domainReceipts} (expected true)`);
        }
      }
    );
    return this.openWsListener("receipts", listenerName, async (event) => {
      const batch = event.params.result as { receipts: OwnReceipt[] };
      for (const receipt of batch.receipts) {
        await handler(receipt);
      }
    });
  }

  async onBlockchainEvent(
    listenerName: string,
    address: string,
    eventSignature: string,
    handler: BlockchainEventHandler
  ): Promise<ListenerHandle> {
    let abi: ethers.JsonFragment;
    try {
      abi = JSON.parse(ethers.EventFragment.from(eventSignature).format("json")) as ethers.JsonFragment;
    } catch (err) {
      throw new PaladinClientError("PD_CLIENT_BAD_EVENT_SIGNATURE", `could not parse event signature "${eventSignature}": ${(err as Error).message}`, err);
    }
    await createListenerIdempotent(
      "PD012246",
      () => this.sdk.ptx.createBlockchainEventListener({ name: listenerName, sources: [{ abi: [abi], address }] }),
      async () => {
        const existing = await this.sdk.ptx.getBlockchainEventListener(listenerName);
        if (!existing) mismatch(listenerName, "blockchain event", "reported as duplicate but not found on refetch");
        const existingSource = existing.sources[0];
        const existingAddress = existingSource?.address?.toLowerCase();
        const existingSignature = existingSource?.abi[0] ? eventSignatureOf(existingSource.abi[0]) : undefined;
        const requestedSignature = eventSignatureOf(abi);
        if (existingAddress !== address.toLowerCase() || existingSignature !== requestedSignature) {
          mismatch(
            listenerName,
            "blockchain event",
            `existing address=${existingAddress} event=${existingSignature}, requested address=${address.toLowerCase()} event=${requestedSignature}`
          );
        }
      }
    );
    return this.openWsListener("blockchainevents", listenerName, async (event) => {
      const batch = event.params.result as { events: BlockchainEvent[] };
      for (const blockchainEvent of batch.events) {
        await handler(blockchainEvent);
      }
    });
  }

  // D5 (architecture review, 2026-10-05): one listener covering EVERY RestrictedAtom instance
  // -- C2's finding: the backend hand-wrote the wrong event signature
  // (AtomStatusChanged(address,uint8) vs the real AtomStatusChanged(uint8), on the FACTORY
  // address instead of each individual atom), so settlement events never arrived and trades
  // could never reach SETTLED/ROLLED_BACK in real mode. No contract address filter is passed
  // (IBlockchainEventListenerSource.address is optional) -- Paladin matches the event against
  // EVERY contract emitting it with this ABI, covering every RestrictedAtom clone without the
  // backend ever needing to enumerate or hand-register individual atom addresses.
  async onAtomStatusChanged(listenerName: string, handler: AtomStatusChangedHandler, options?: { startFromLatest?: boolean }): Promise<ListenerHandle> {
    const eventSignature = "AtomStatusChanged(uint8 status)";
    const abi = JSON.parse(ethers.EventFragment.from(eventSignature).format("json")) as ethers.JsonFragment;
    // startFromLatest: same pattern/default as onOwnReceipt (task #4b) -- live-proof finding,
    // 2026-10-05: with no address filter, a fresh listener otherwise replays AtomStatusChanged
    // from the chain's earliest history (every RestrictedAtom ever created, not just new ones;
    // confirmed live, a backlog of dozens of historical atoms took over 120s to drain before a
    // just-created one surfaced). Default stays false (full replay) -- safe for a backend's
    // genuinely first-ever startup; opt in once attached to a node with history that doesn't
    // need reconciling.
    const fromBlock = options?.startFromLatest ? "latest" : undefined;
    await createListenerIdempotent(
      "PD012246",
      () => this.sdk.ptx.createBlockchainEventListener({ name: listenerName, sources: [{ abi: [abi] }], options: fromBlock ? { fromBlock } : undefined }),
      async () => {
        const existing = await this.sdk.ptx.getBlockchainEventListener(listenerName);
        if (!existing) mismatch(listenerName, "atom status", "reported as duplicate but not found on refetch");
        const existingSource = existing.sources[0];
        if (existingSource?.address) mismatch(listenerName, "atom status", `existing listener has an address filter (${existingSource.address}) -- onAtomStatusChanged must cover every RestrictedAtom instance, not one`);
        const existingSignature = existingSource?.abi[0] ? eventSignatureOf(existingSource.abi[0]) : undefined;
        if (existingSignature !== eventSignatureOf(abi)) {
          mismatch(listenerName, "atom status", `existing event=${existingSignature}, requested event=${eventSignatureOf(abi)}`);
        }
      }
    );
    return this.openWsListener("blockchainevents", listenerName, async (event) => {
      const batch = event.params.result as { events: BlockchainEvent[] };
      for (const blockchainEvent of batch.events) {
        const statusNum = Number((blockchainEvent.data as { status: string | number }).status);
        await handler({
          atomAddress: blockchainEvent.address,
          status: RESTRICTED_ATOM_STATUS[statusNum],
          txHash: blockchainEvent.transactionHash,
          blockNumber: blockchainEvent.blockNumber,
        });
      }
    });
  }

  async onGroupMessage(listenerName: string, groupId: string, handler: GroupMessageHandler): Promise<ListenerHandle> {
    await createListenerIdempotent(
      "PD012507",
      () => this.sdk.pgroup.createMessageListener({ name: listenerName, filters: { group: groupId } }),
      async () => {
        const existing = await this.sdk.pgroup.getMessageListener(listenerName);
        if (!existing) mismatch(listenerName, "group message", "reported as duplicate but not found on refetch");
        if (existing.filters?.group !== groupId) {
          mismatch(listenerName, "group message", `existing group=${existing.filters?.group}, requested group=${groupId}`);
        }
      }
    );
    return this.openPrivacyGroupWsListener(listenerName, async (event) => {
      const batch = event.params.result as { messages: IPrivacyGroupMessage[] };
      for (const message of batch.messages) {
        await handler(toGroupMessage(message));
      }
    });
  }

  // Shared ack/nack wiring for ptx_* listeners (receipts, blockchain events). The handler for
  // one batch is awaited in full before acking; a thrown/rejected handler nacks the whole
  // batch -- see types.ts's PaladinClient doc comment for why this is batch-granularity, not
  // per-item.
  private openWsListener(
    type: "receipts" | "blockchainevents",
    name: string,
    onBatch: (event: { params: { subscription: string; result: unknown } }) => Promise<void>
  ): Promise<ListenerHandle> {
    return new Promise((resolve) => {
      const ws = new PaladinWebSocketClient(
        {
          url: this.wsUrl(),
          username: this.config.rpcAuth?.username,
          password: this.config.rpcAuth?.password,
          subscriptions: [{ type, name }],
          afterConnect: async () => resolve({ stop: () => ws.close(true) }),
        },
        (sender, event) => {
          dispatchBatch(sender as unknown as AckNackSender, event.params.subscription, () => onBatch(event as any), (err) =>
            console.error(`[paladin-client] handler failed for listener "${name}", nacking batch: ${(err as Error).message}`)
          );
        }
      );
      this.sockets.push(ws);
    });
  }

  private openPrivacyGroupWsListener(
    name: string,
    onBatch: (event: { params: { subscription: string; result: unknown } }) => Promise<void>
  ): Promise<ListenerHandle> {
    return new Promise((resolve) => {
      const ws = new PrivacyGroupWebSocketClient(
        {
          url: this.wsUrl(),
          username: this.config.rpcAuth?.username,
          password: this.config.rpcAuth?.password,
          subscriptions: [{ type: "messages", name }],
          afterConnect: async () => resolve({ stop: () => ws.close(true) }),
        },
        (sender, event) => {
          dispatchBatch(sender as unknown as AckNackSender, event.params.subscription, () => onBatch(event as any), (err) =>
            console.error(`[paladin-client] handler failed for group listener "${name}", nacking batch: ${(err as Error).message}`)
          );
        }
      );
      this.sockets.push(ws);
    });
  }

  private wsUrl(): string {
    if (this.config.wsUrl) return this.config.wsUrl;
    return this.config.nodeUrl.replace(/^http/, "ws");
  }

  // Task #6b (lead requirement): every submit-style method takes an optional idempotencyKey,
  // passed through to Paladin's own sendTransaction (same mechanism bond/src/lib/
  // outright.ts:165 already uses) -- the backend calls Paladin inside a DB transaction, and a
  // commit failure after Paladin already succeeded means a redelivery repeats the call. Paladin
  // REJECTS a reused key (PD012220) rather than silently returning the original transaction, so
  // this resolves that rejection to the ORIGINAL transaction's receipt via
  // ptx_getTransactionByIdempotencyKey instead of re-throwing -- idempotent end-to-end, not
  // just at the Paladin layer. `sendTxId` is deferred (not a bare Promise) so a key collision
  // never depends on re-running whatever built it.
  // 0.4.2: the recovery logic itself now lives in the exported resolveIdempotentFuture above
  // (deployAgreement/issueSeries's deploy substeps need the same recovery but return a
  // TransactionFuture, not a bare tx id, so they call it directly instead of through this
  // wrapper). This stays a thin shim that still calls sendTxId() exactly once, so the
  // collision-vs-first-attempt timing described above is unchanged.
  private async submitIdempotent(sendTxId: () => Promise<string>, idempotencyKey: string | undefined, full = false) {
    return resolveIdempotentFuture(this.sdk, sendTxId(), idempotencyKey, DEFAULT_POLL_TIMEOUT, full);
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.sockets.map((s) => s.close(true)));
    this.sockets = [];
  }

  // ---------------------------------------------------------------------------
  // Lock primitives: lockToken/prepareUnlock/delegateLock/mintToken/createPrivacyGroup/
  // resumePrivacyGroup -- shared by both the primary and outright flows (D1).
  // ---------------------------------------------------------------------------

  // 0.6.0 (coupon/redemption, task #19): `asIdentity` lets a client signed in as one
  // config.identities role lock/prepare on behalf of ANOTHER configured same-node identity
  // (e.g. BI's own client, connected as bondCustodian, locking the cash leg as bondIssuer for
  // a coupon payment) -- reuses `requireIdentityVerifier`'s existing same-node-only check
  // unchanged. Omitting it preserves today's behavior exactly (signs as `this.verifier`).
  async lockToken(tokenAddress: string, amount: string, idempotencyKey?: string, asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"): Promise<{ lockId: string }> {
    try {
      const signer = asIdentity ? this.requireIdentityVerifier(asIdentity) : this.verifier;
      const token = new NotoInstance(this.sdk, tokenAddress);
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(token.lock(signer, { amount, data: "0x" }, idempotencyKey).id),
        idempotencyKey,
        true
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_LOCK_FAILED", `lock failed: ${receipt?.failureMessage ?? "no receipt"}`);
      const lockId = (receipt.domainReceipt as INotoDomainReceipt | undefined)?.lockInfo?.lockId;
      if (!lockId) throw new PaladinClientError("PD_CLIENT_LOCK_FAILED", "no lockId in domain receipt");
      return { lockId };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async prepareUnlock(
    tokenAddress: string,
    lockId: string,
    recipients: { to: string; amount: string }[],
    idempotencyKey?: string,
    options?: { allowRePrepare?: boolean },
    asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"
  ): Promise<{ lockId: string; unlockCall: string; cancelCall: string; preparedStateId: string }> {
    try {
      const signer = asIdentity ? this.requireIdentityVerifier(asIdentity) : this.verifier;
      const recipientVerifiers = recipients.map((r) => ({ to: this.sdk.getVerifiers(requireLookup(r.to, "recipients[].to"))[0], amount: r.amount }));
      const firstRecipientAddr = await recipientVerifiers[0].to.address();

      // Task #17: a retry with the SAME idempotencyKey must recover the ORIGINAL result, even
      // though the lock is now already prepared -- check for a prior transaction under this
      // key BEFORE the guard below gets a chance to reject it as a (real) re-prepare attempt.
      if (idempotencyKey) {
        const existingReceipt = await findReceiptByIdempotencyKey(this.sdk, idempotencyKey, DEFAULT_POLL_TIMEOUT, true);
        if (existingReceipt) {
          return decodePrepareUnlockReceipt(existingReceipt, lockId, firstRecipientAddr);
        }
      }

      await verifyLockOwner(this.sdk, "noto", tokenAddress, lockId, await signer.address(), "prepareUnlock");
      // Lead-required guard (0.3.0): re-preparing before delegation is allowed on-chain
      // (LockImmutable only triggers after delegation) but silently changes spendCommitment,
      // invalidating any unlockCall/cancelCall a caller already recorded from the FIRST
      // prepare (the preparePayment/prepareBond bug this was found from). Opt out with
      // {allowRePrepare: true} only for an intentional re-prepare, e.g. releaseLock's
      // prepare-to-self recovery path. Only reached once we know -- from the lookup above --
      // that this is NOT a retry of our own earlier call under the same key.
      if (!options?.allowRePrepare && (await isLockPrepared(this.sdk, signer.lookup, tokenAddress, lockId))) {
        throw new PaladinClientError(
          "PD_CLIENT_LOCK_ALREADY_PREPARED",
          `lock ${lockId} already has a prepared unlock -- re-preparing would change its spendCommitment and invalidate any unlockCall/cancelCall already recorded from the first prepare. Pass {allowRePrepare: true} if this re-prepare is intentional.`
        );
      }
      const token = new NotoInstance(this.sdk, tokenAddress);
      const receipt = await this.submitIdempotent(
        () =>
          Promise.resolve(
            token.prepareUnlock(signer, { lockId, from: signer, recipients: recipientVerifiers, unlockData: "0x", data: "0x" }, idempotencyKey).id
          ),
        idempotencyKey,
        true
      );
      return decodePrepareUnlockReceipt(receipt, lockId, firstRecipientAddr);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // 0.6.1 (task #19 follow-up, reported by backend): the SAME `asIdentity` pattern as
  // lockToken/prepareUnlock/prepareTradeLeg -- delegateLock's on-chain owner check requires the
  // SIGNER to be the lock's actual owner, so a leg owned by a different configured identity
  // than this client's connection default (e.g. bondIssuer's cash leg, delegated from a client
  // connected as bondCustodian) needs this too. Omitting it preserves today's behavior exactly.
  async delegateLock(tokenAddress: string, lockId: string, delegateAddress: string, idempotencyKey?: string, asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"): Promise<void> {
    try {
      const signer = asIdentity ? this.requireIdentityVerifier(asIdentity) : this.verifier;
      await verifyLockOwner(this.sdk, "noto", tokenAddress, lockId, await signer.address(), "delegateLock");
      const token = new NotoInstance(this.sdk, tokenAddress);
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(token.delegateLock(signer, { lockId, delegate: delegateAddress, data: "0x" }, idempotencyKey).id),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_DELEGATE_LOCK_FAILED", `delegateLock failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // Extracted from delegateTradeLeg (lead requirement, 2026-10-05) so its atom-match check
  // uses the same VerifyResult/VerifyCode shape as verifyDelegatedLeg/verifyCancelCall --
  // reuses LOCKID_MISMATCH for a leg's recorded unlockCall/cancelCall not appearing in the
  // atom's operations/cancelOperations (the atom's content doesn't match what was recorded,
  // same category as an unlockCall whose embedded lockId doesn't match). The executor check
  // has no natural code among the 8 (none of them describe "wrong executor identity") so it's
  // left without one -- delegateTradeLeg still throws PD_CLIENT_ATOM_MISMATCH either way;
  // this method stays a plain internal check, not a new public return shape on
  // delegateTradeLeg itself (which still returns Promise<void> -- it performs the delegation).
  private async _checkAtomMatchesLeg(atomAddress: string, leg: AgreementLeg): Promise<VerifyResult> {
    const call = async (fn: string) => (await this.sdk.ptx.call({ type: TransactionType.PUBLIC, abi: restrictedAtomArtifact.abi, function: fn, to: atomAddress, from: this.verifier.lookup, data: {} })) as any;
    const [operationsResult, cancelOperationsResult, executorResult] = await Promise.all([call("getOperations"), call("getCancelOperations"), call("executor")]);
    const operations = (operationsResult.operations ?? operationsResult["0"]) as { contractAddress: string; callData: string }[];
    const cancelOperations = (cancelOperationsResult.cancelOperations ?? cancelOperationsResult["0"]) as { contractAddress: string; lockId: string; callData: string }[];
    const normBytes = (b: string) => (b.startsWith("0x") ? b : "0x" + b).toLowerCase();
    // Live-proof finding (2026-10-05): unlike operations[].contractAddress/leg.asset below
    // (both already run through normAddr), this value from the contract call was only
    // .toLowerCase()'d, never 0x-normalized -- RestrictedAtom's `executor()` getter can come
    // back without the "0x" prefix depending on the serializer, so the equality check against
    // bondCustodianAddr (always "0x"-prefixed, from getVerifiers().address()) failed on every
    // real call even when the two addresses were actually identical.
    const executorAddr = normAddr((executorResult["0"] ?? executorResult) as string);

    const opMatch = operations.some((o) => normAddr(o.contractAddress) === normAddr(leg.asset) && normBytes(o.callData) === normBytes(leg.unlockCall!));
    if (!opMatch) {
      return { ok: false, code: "LOCKID_MISMATCH", reason: `atom ${atomAddress}'s operations do not include this leg's recorded unlockCall -- refusing to delegate` };
    }
    const cancelOpMatch = cancelOperations.some((o) => normAddr(o.contractAddress) === normAddr(leg.asset) && normBytes(o.lockId) === normBytes(leg.lockId!) && normBytes(o.callData) === normBytes(leg.cancelCall!));
    if (!cancelOpMatch) {
      return { ok: false, code: "LOCKID_MISMATCH", reason: `atom ${atomAddress}'s cancelOperations do not include this leg's recorded cancelCall -- refusing to delegate` };
    }

    // The executor must resolve to a real, known identity -- bondCustodian (BI) if this
    // client has that identity configured, since BI is always the executor by design (every
    // trade atom in this platform, primary or outright).
    const configuredBondCustodian = this.config.identities?.bondCustodian;
    if (configuredBondCustodian) {
      const bondCustodianAddr = (await this.sdk.getVerifiers(configuredBondCustodian)[0].address()).toLowerCase();
      if (executorAddr !== bondCustodianAddr) {
        return { ok: false, reason: `atom ${atomAddress}'s executor (${executorAddr}) is not bondCustodian (${bondCustodianAddr}) -- refusing to delegate` };
      }
    }
    return { ok: true };
  }

  // D6 (architecture review, 2026-10-05): group messages are notifications, never authority
  // (C3's finding: a handler delegated straight to `data.atomAddress` taken from a group
  // message with no check at all -- any bank sharing the group could redirect a lock and
  // break DvP). This reads the real atom address from the chain (`getAgreement`), then reads
  // the ATOM'S OWN on-chain operations/cancelOperations/executor and confirms this specific
  // leg's recorded unlockCall/cancelCall genuinely appear in them before ever calling
  // delegateLock -- so even a caller that was fed a bogus atom address (e.g. from an
  // unauthenticated message) can't be tricked into delegating to it, because that bogus
  // atom's real on-chain operations won't match what this leg actually agreed to.
  // 0.6.1: `asIdentity`, same pattern as prepareTradeLeg -- threaded through to the internal
  // `delegateLock` call below, whose own on-chain owner check needs the leg's ACTUAL owner as
  // signer, not necessarily this client's own connection default.
  async delegateTradeLeg(groupId: string, agreementAddress: string, tradeId: string, legIndex: number, idempotencyKey?: string, asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"): Promise<void> {
    try {
      const trade = await this.getAgreement(groupId, agreementAddress, tradeId);
      if (trade.state !== "ATOM_CREATED" || !trade.atomAddress) {
        throw new PaladinClientError("PD_CLIENT_NO_ATOM_RECORDED", `trade ${tradeId} has no recorded atom yet (state=${trade.state}) -- wait for recordAtom`);
      }
      const leg = trade.legs[legIndex];
      if (!leg) throw new PaladinClientError("PD_CLIENT_LEG_INDEX_OUT_OF_RANGE", `legIndex ${legIndex} out of range for trade ${tradeId}`);
      if (!leg.unlockCall || !leg.cancelCall || !leg.lockId) {
        throw new PaladinClientError("PD_CLIENT_LEG_NOT_PREPARED", `leg ${legIndex} of trade ${tradeId} has no recorded lockId/unlockCall/cancelCall yet -- call recordLeg first`);
      }

      const check = await this._checkAtomMatchesLeg(trade.atomAddress, leg);
      if (!check.ok) throw new PaladinClientError("PD_CLIENT_ATOM_MISMATCH", check.reason ?? "atom does not match this leg -- refusing to delegate");

      await this.delegateLock(leg.asset, leg.lockId!, trade.atomAddress, idempotencyKey, asIdentity);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // 0.6.1: `asIdentity`, same pattern as prepareTradeLeg. `signer` is used for the ownership
  // check and for every prepareUnlock/delegateLock-shaped internal call below (both have
  // their own on-chain owner check, so they must sign as the lock's ACTUAL owner, not
  // necessarily this client's own connection default). createAtom's `parties`/`executor` and
  // the final executeAtom call deliberately stay on `this.verifier` -- they pick who is
  // ALLOWED TO EXECUTE this self-release atom, which is unrelated to who owns the lock being
  // released (the atom acts with its own delegated authority once execute()'d), so there's no
  // on-chain owner check there to satisfy. See executeAtom's own doc comment.
  async releaseLock(tokenAddress: string, lockId: string, idempotencyKey?: string, asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"): Promise<void> {
    try {
      const subKey = (step: string) => (idempotencyKey ? `${idempotencyKey}:${step}` : undefined);
      const signer = asIdentity ? this.requireIdentityVerifier(asIdentity) : this.verifier;

      // Refuse BEFORE sending anything if already delegated -- recovery for that case goes
      // through the trade atom's own cancel() (task #8), never this method.
      const delegation = await isLockDelegated(this.sdk, signer.lookup, tokenAddress, lockId);
      if (delegation.delegated) {
        throw new PaladinClientError("PD_CLIENT_LOCK_DELEGATED", `lock ${lockId} is already delegated to ${delegation.spender} -- recovery must go through the trade atom's own cancel()`);
      }

      // Find the locked amount for this lockId (NotoLockedCoin, same schema/mechanism balances() already uses).
      const schemaId = await this.getLockedSchemaId();
      if (!schemaId) throw new PaladinClientError("PD_CLIENT_RELEASE_LOCK_FAILED", "NotoLockedCoin schema not found");
      const lockedStates = await this.sdk.pstate.queryContractStates("noto", tokenAddress, schemaId, { eq: [{ field: "lockId", value: lockId }] }, "available");
      let totalAmount = 0n;
      for (const s of lockedStates) totalAmount += BigInt((s.data as { amount: string }).amount);
      if (totalAmount === 0n) throw new PaladinClientError("PD_CLIENT_RELEASE_LOCK_FAILED", `no locked balance found for lockId ${lockId}`);

      // prepareUnlock-to-self, then a single-leg cancel atom (delegate to it, execute) --
      // same mechanism as bond/src/lib/outright.ts's rollback(), for one leg.
      const token = new NotoInstance(this.sdk, tokenAddress);
      const prepReceipt = await this.submitIdempotent(
        () =>
          Promise.resolve(
            token.prepareUnlock(signer, { lockId, from: signer, recipients: [{ to: signer, amount: totalAmount.toString() }], unlockData: "0x", data: "0x" }, subKey("prepare")).id
          ),
        subKey("prepare"),
        true
      );
      if (!prepReceipt?.success) throw new PaladinClientError("PD_CLIENT_RELEASE_LOCK_FAILED", `prepareUnlock failed: ${prepReceipt?.failureMessage ?? "no receipt"}`);
      const cancelCall = (prepReceipt.domainReceipt as INotoDomainReceipt | undefined)?.lockInfo?.cancelCall;
      if (!cancelCall) throw new PaladinClientError("PD_CLIENT_RELEASE_LOCK_FAILED", "no cancelCall in domain receipt");

      // D1 (architecture review, 2026-10-05): goes through RestrictedAtomFactory now, not the
      // upstream unrestricted AtomFactory/Atom (C1 -- that one's cancel() has no access
      // control at all, so this single-leg self-release atom was itself a griefing target
      // between delegate and execute, however small the window).
      const { atomAddress } = await this.createAtom([{ contractAddress: tokenAddress, callData: cancelCall }], [], [this.verifier.lookup], this.verifier.lookup, subKey("create-atom"));

      const delegateReceipt = await this.submitIdempotent(
        () => Promise.resolve(token.delegateLock(signer, { lockId, delegate: atomAddress, data: "0x" }, subKey("delegate")).id),
        subKey("delegate")
      );
      if (!delegateReceipt?.success) throw new PaladinClientError("PD_CLIENT_RELEASE_LOCK_FAILED", `delegateLock to cancel-atom failed: ${delegateReceipt?.failureMessage ?? "no receipt"}`);

      await this.executeAtom(atomAddress, subKey("execute"));
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async health(): Promise<{ nodeName: string; indexerHeight: number; chainHeight?: number }> {
    try {
      const nodeName = await this.sdk.transport.nodeName();
      const rawHeight = await this.sdk.bidx.getConfirmedBlockHeight();
      // Confirmed live: comes back as a hex string despite the SDK's own type claiming
      // `number` -- Number() parses a "0x..." string correctly, a plain decimal number passes
      // through unchanged either way.
      const indexerHeight = Number(rawHeight);
      return { nodeName, indexerHeight };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async mintToken(tokenAddress: string, to: string, amount: string, idempotencyKey?: string): Promise<void> {
    try {
      const token = new NotoInstance(this.sdk, tokenAddress);
      const toVerifier = this.sdk.getVerifiers(requireLookup(to, "to"))[0];
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(token.mint(this.verifier, { to: toVerifier, amount, data: "0x" }, idempotencyKey).id),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_MINT_FAILED", `mint failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // 0.6.0 (task #19, coupon/redemption snapshot step): every holder of `token`, as seen from
  // THIS node -- truthful only from the token's own notary (BI), since Noto only distributes a
  // coin state to its owner and the notary. Hard-refuses otherwise (PD_CLIENT_WRONG_ROLE, same
  // gate as deployAgreement) rather than silently returning an incomplete result -- a non-BI
  // caller would otherwise see only its OWN states and mistake that for "every holder".
  //
  // `available`/`locked` are two separate SCHEMAS (NotoCoin vs NotoLockedCoin), each queried
  // with status "available" (not "all") so spent/superseded states are never double-counted --
  // mirrors balances()'s own status choice, not verifyDelegatedLeg's "all" (which exists there
  // to tell "not yet propagated" apart from "belongs to someone else", not to sum balances). A
  // locked state's `owner` is still the LOCK OWNER (a pending sale hasn't moved ownership yet),
  // so it lands on the right holder with no extra logic.
  async getHolders(token: string): Promise<{ holders: { owner: string; available: string; locked: string }[]; blockHeight: string }> {
    try {
      const bondCustodian = this.requireIdentityVerifier("bondCustodian");
      if (this.verifier.lookup !== bondCustodian.lookup) {
        throw new PaladinClientError(
          "PD_CLIENT_WRONG_ROLE",
          `getHolders must be called by bondCustodian ("${bondCustodian.lookup}"), not "${this.verifier.lookup}" -- only the token's own notary sees every holder's state`
        );
      }
      const byOwner = new Map<string, { available: bigint; locked: bigint }>();
      const add = (owner: string, amount: string, field: "available" | "locked") => {
        const key = normAddr(owner);
        const entry = byOwner.get(key) ?? { available: 0n, locked: 0n };
        entry[field] += BigInt(amount);
        byOwner.set(key, entry);
      };

      const coinSchemaId = await this.getCoinSchemaId();
      if (coinSchemaId) {
        const states = await this.sdk.pstate.queryContractStates("noto", token, coinSchemaId, {}, "available");
        for (const s of states as { data: { owner: string; amount: string } }[]) add(s.data.owner, s.data.amount, "available");
      }
      const lockedSchemaId = await this.getLockedSchemaId();
      if (lockedSchemaId) {
        const states = await this.sdk.pstate.queryContractStates("noto", token, lockedSchemaId, {}, "available");
        for (const s of states as { data: { owner: string; amount: string } }[]) add(s.data.owner, s.data.amount, "locked");
      }

      // Read AFTER both state queries so it never predates the states it describes -- still a
      // live read under a short hold, not a true historical "balance at block N" (Paladin has
      // no such API, per this project's own spec doc's "Open" section).
      const blockHeight = await this.sdk.bidx.getConfirmedBlockHeight();
      const holders = Array.from(byOwner.entries()).map(([owner, { available, locked }]) => ({ owner, available: available.toString(), locked: locked.toString() }));
      return { holders, blockHeight: String(blockHeight) };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // Plain `name@node` -> address, normalized (0x + lowercase) the same way getHolders'
  // `owner` is -- so a caller can map a BondHolding.owner back to a participant without a
  // separate ad-hoc normalization rule.
  async resolveAddress(lookup: string): Promise<string> {
    try {
      const address = await this.sdk.getVerifiers(requireLookup(lookup, "lookup"))[0].address();
      return normAddr(address);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // 0.6.0: plain Noto transfer on the RD cash token (deployed notaryMode "hooks" with a plain
  // ERC20 tracker, scripts/bootstrap-platform.ts:273 -- the hook is a balance mirror only, no
  // whitelist; the live-check spikes deploy a "basic" stand-in, e.g.
  // spikes/primary-subscription/live-proof.ts:112) signed as a configured identity other than
  // this client's own default (coupon/imbalan payment, redemption principal: bondIssuer@node1
  // -> holder). Returns the pending transaction's id (captured before awaiting the receipt,
  // same future.id already used by every other submit method in this file) so the caller has
  // something to correlate against even while the tx is still in flight.
  async transferCash(fromIdentity: "bondIssuer" | "bondCustodian" | "cashIssuer", toLookup: string, amount: string, idempotencyKey?: string): Promise<{ txId: string }> {
    try {
      const signer = this.requireIdentityVerifier(fromIdentity);
      const cashToken = requireCashToken(this.config);
      const token = new NotoInstance(this.sdk, cashToken);
      const toVerifier = this.sdk.getVerifiers(requireLookup(toLookup, "toLookup"))[0];
      const future = token.transfer(signer, { to: toVerifier, amount, data: "0x" }, idempotencyKey);
      const txId = await future.id;
      const receipt = await resolveIdempotentFuture(this.sdk, txId, idempotencyKey, DEFAULT_POLL_TIMEOUT);
      if (!receipt?.success) throw receiptFailureError("transferCash", "PD_CLIENT_TRANSFER_CASH_FAILED", receipt);
      return { txId };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // 0.6.0: cashIssuer@node1 mints RD to bondIssuer@node1, funding the paying-agent account
  // BI pays coupons/redemption principal out of. Plain mint, same shape as transferCash.
  async fundIssuer(amount: string, idempotencyKey?: string): Promise<{ txId: string }> {
    try {
      const signer = this.requireIdentityVerifier("cashIssuer");
      const bondIssuer = this.requireIdentityVerifier("bondIssuer");
      const cashToken = requireCashToken(this.config);
      const token = new NotoInstance(this.sdk, cashToken);
      const future = token.mint(signer, { to: bondIssuer, amount, data: "0x" }, idempotencyKey);
      const txId = await future.id;
      const receipt = await resolveIdempotentFuture(this.sdk, txId, idempotencyKey, DEFAULT_POLL_TIMEOUT);
      if (!receipt?.success) throw receiptFailureError("fundIssuer", "PD_CLIENT_FUND_ISSUER_FAILED", receipt);
      return { txId };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // 0.6.0: RD balance of an arbitrary BI-hosted identity (not necessarily this client's own
  // default identity) -- generalizes balances()'s single-identity, single-token-param shape to
  // an explicit identity, against the one RD cash token this deployment ever has
  // (config.contractData.cashToken, the same field bootstrap already writes -- confirmed with
  // the backend that no per-call token param is needed here).
  async cashBalanceOf(identity: string): Promise<{ available: string; locked: string; balance: string }> {
    try {
      const cashToken = requireCashToken(this.config);
      const verifier = this.sdk.getVerifiers(requireLookup(identity, "identity"))[0];
      const token = new NotoInstance(this.sdk, cashToken);
      const available = BigInt((await token.balanceOf(verifier, { account: verifier.lookup })).totalBalance);

      let locked = 0n;
      const schemaId = await this.getLockedSchemaId();
      if (schemaId) {
        const address = await verifier.address();
        const states = await this.sdk.pstate.queryContractStates("noto", cashToken, schemaId, { eq: [{ field: "owner", value: address }] }, "available");
        for (const s of states as { data: { amount: string } }[]) locked += BigInt(s.data.amount);
      }
      return { available: available.toString(), locked: locked.toString(), balance: (available + locked).toString() };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // 0.6.0: burn by the custodian, after a redemption bond leg has already landed the bond on
  // the custodian's own balance (burn is `onlySelf`-gated, inherited unmodified -- the
  // custodian can only ever burn its OWN holdings, never an arbitrary holder's directly; the
  // bond leg MUST settle first). Noto has no on-chain `burn` function -- it's a domain-level
  // verb implemented in Go, same shape as mint/transfer (INotoPrivate.sol's own doc comment:
  // "implemented in Go, never expected to be implemented in a smart contract").
  async burnBond(token: string, amount: string, idempotencyKey?: string): Promise<{ txId: string }> {
    try {
      const signer = this.requireIdentityVerifier("bondCustodian");
      const notoToken = new NotoInstance(this.sdk, token);
      const future = notoToken.burn(signer, { amount, data: "0x" }, idempotencyKey);
      const txId = await future.id;
      const receipt = await resolveIdempotentFuture(this.sdk, txId, idempotencyKey, DEFAULT_POLL_TIMEOUT);
      if (!receipt?.success) throw receiptFailureError("burnBond", "PD_CLIENT_BURN_BOND_FAILED", receipt);
      return { txId };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // Thin wrapper matching the backend's CouponPaladinPort shape exactly -- same underlying
  // mechanism as prepareTradeLeg's own `asIdentity` param, just with the identity moved to the
  // front as a required positional argument instead of a trailing optional one.
  async prepareTradeLegAs(
    identity: "bondIssuer" | "bondCustodian" | "cashIssuer",
    groupId: string,
    agreementAddress: string,
    tradeId: string,
    legIndex: number,
    recipientLookup: string,
    idempotencyKey?: string
  ): Promise<{ lockId: string; unlockCall: string; cancelCall: string; preparedStateId: string }> {
    return this.prepareTradeLeg(groupId, agreementAddress, tradeId, legIndex, recipientLookup, idempotencyKey, identity);
  }

  async createPrivacyGroup(members: string[]): Promise<{ groupId: string; groupAddress: string }> {
    try {
      const memberVerifiers = members.map((m) => this.sdk.getVerifiers(requireLookup(m, "members[]"))[0]);
      const group = await new PenteFactory(this.sdk, "pente")
        .newPrivacyGroup({ members: memberVerifiers, evmVersion: "shanghai", externalCallsEnabled: true })
        .waitForDeploy(DEFAULT_POLL_TIMEOUT);
      if (!group) throw new PaladinClientError("PD_CLIENT_GROUP_DEPLOY_FAILED", "privacy group deploy failed");
      return { groupId: group.group.id, groupAddress: group.address };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async resumePrivacyGroup(groupId: string): Promise<{ groupId: string; groupAddress: string }> {
    try {
      const group = await new PenteFactory(this.sdk, "pente").resumePrivacyGroup({ id: groupId });
      if (!group) throw new PaladinClientError("PD_CLIENT_GROUP_NOT_FOUND", `privacy group ${groupId} not found`);
      return { groupId: group.group.id, groupAddress: group.address };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // Added for 0.4.0 (backend addition, 2026-10-05): the backend was using a deterministic
  // string `group-investor-custodian-<bankId>` because paladin-client had no group query
  // method -- real group ids are random (same root cause as D8/ensureOutrightGroup's own
  // doc comment). `pgroup_queryGroupsWithMember` filters server-side to groups containing
  // ONE given member; the exact-set match (no extra members, none missing) is client-side.
  async findGroupsWithMembers(memberLookups: string[]): Promise<{ groupId: string; members: string[]; name?: string; createdAt: string }[]> {
    try {
      if (memberLookups.length === 0) throw new PaladinClientError("PD_CLIENT_INVALID_ARGUMENT", "memberLookups must not be empty");
      const resolved = memberLookups.map((m) => requireLookup(m, "memberLookups[]"));
      // Live-proof finding (2026-10-05): unlike pstate_queryContractStates, pgroup_
      // queryGroupsWithMember rejects an empty query object outright ("PD010721: limit is
      // required on all queries") -- a limit is mandatory here, there's no "no filter" form.
      const groups = (await this.sdk.pgroup.queryGroupsWithMember(resolved[0], { limit: 100 })) as { id: string; members: string[]; name?: string; created: string }[];
      const wanted = new Set(resolved.map((m) => m.toLowerCase()));
      return groups
        .filter((g) => {
          const have = new Set(g.members.map((m) => m.toLowerCase()));
          return have.size === wanted.size && [...wanted].every((m) => have.has(m));
        })
        .map((g) => ({ groupId: g.id, members: g.members, name: g.name, createdAt: g.created }));
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // BI (this client's own identity == config.identities.bondCustodian): creates the
  // investor+custodian group if it doesn't exist yet. Any other identity (an investor):
  // find-only, throws PD_CLIENT_GROUP_NOT_FOUND if BI hasn't created it yet -- the backend's
  // own job to retry, not this method's. Persists nothing (no in-memory cache) -- unlike
  // ensurePrimaryGroup (this client's own single investor-custodian relationship), BI calls
  // this once per investor, for potentially many different investors.
  async ensureInvestorCustodianGroup(investorLookup: string): Promise<{ groupId: string }> {
    try {
      const resolvedInvestor = requireLookup(investorLookup, "investorLookup");
      const bondCustodianLookup = this.configuredIdentityLookup("bondCustodian");
      const isBI = this.verifier.lookup === bondCustodianLookup;
      const found = await this.findGroupsWithMembers([resolvedInvestor, bondCustodianLookup]);
      if (found.length > 0) return { groupId: found[0].groupId };
      if (!isBI) {
        throw new PaladinClientError("PD_CLIENT_GROUP_NOT_FOUND", `no investor+custodian group found for ${resolvedInvestor} yet`);
      }
      const [investorVerifier, bondCustodian] = this.sdk.getVerifiers(resolvedInvestor, bondCustodianLookup);
      const group = await new PenteFactory(this.sdk, "pente")
        .newPrivacyGroup({ members: [investorVerifier, bondCustodian], evmVersion: "shanghai", externalCallsEnabled: true })
        .waitForDeploy(DEFAULT_POLL_TIMEOUT);
      if (!group) throw new PaladinClientError("PD_CLIENT_ENSURE_PRIMARY_GROUP_FAILED", "investor+custodian group deploy failed");
      return { groupId: group.group.id };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // idempotencyKey accepted for API consistency with every other submit method, but
  // deliberately unused -- see the exported sendGroupMessage's own doc comment for why
  // (pgroup_sendMessage's correlationId is a real UUID field, not a free-form dedup key).
  async sendGroupMessage(groupId: string, topic: string, data: unknown, _idempotencyKey?: string): Promise<void> {
    try {
      await sendGroupMessage(this.sdk, groupId, topic, data);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Task #8 -- Agreement.sol (generic multi-leg trade), lead-approved design.
  // ---------------------------------------------------------------------------

  // 0.5.0: keyed on (groupId, agreementAddress) -- there is NO fallback lookup by address
  // alone, since address alone is not unique across privacy groups (see agreementCacheKey's
  // doc comment). Both groupId and address are included in the error message below for
  // debuggability -- this is exactly the kind of mismatch that caused the live incident.
  private requireAgreement(groupId: string, agreementAddress: string): { group: PentePrivacyGroup; agreement: Agreement } {
    const ctx = this.agreements.get(agreementCacheKey(groupId, agreementAddress));
    if (!ctx) throw new PaladinClientError("PD_CLIENT_UNKNOWN_AGREEMENT", `no agreement context for group ${groupId} address ${agreementAddress} in this client instance -- call deployAgreement, proposeAgreement, or resumeAgreement first`);
    return ctx;
  }

  // Lead question (2026-10-05): can two banks independently compute the same privacy group id
  // from members+salt, so neither has to tell the other? NO -- confirmed by reading Paladin's
  // own groupmgr.CreateGroup (core/go/internal/groupmgr/manager.go:252-255): the genesis salt
  // is ALWAYS `pldtypes.RandBytes32()`, server-generated fresh on every call, and
  // `PrivacyGroupInput` (sdk/go/pkg/pldapi/privacy_group.go:64-71) has no field to override it.
  // The group id is the content hash of a genesis state that includes that random salt, so the
  // SAME members+name NEVER produces the same id twice, and there is no idempotent re-create --
  // every call makes a brand new group. There is therefore no deterministic
  // `group-outright-<bankA>-<bankB>` scheme possible against real Paladin; the group must be
  // created ONCE and its real (random) id propagated to the other party -- which Paladin
  // already does on creation ("a reliable message transfer to all the parties in the group so
  // they get notification it's there", same file, CreateGroup's final step) -- or, matching
  // this codebase's own idempotency convention elsewhere, the creator's backend persists and
  // hands out the id itself (pass it back as `knownGroupId` on a later call from either bank).
  // No idempotencyKey param -- group creation has no idempotencyKey support in this SDK
  // wrapper (known gap, already documented elsewhere in this file for createPrivacyGroup/
  // resumePrivacyGroup/mintToken); the in-memory pairKey cache above is this method's own
  // within-process substitute, same caveat as every other *Context/*Group cache in this file.
  //
  // D8 fixes (architecture review, 2026-10-05):
  // 1. The third member used to be `this.verifier` -- "whichever identity happens to be
  //    calling" -- not necessarily the custodian at all (an investor's own client calling
  //    this would make the investor its own third member, never including BI). Always
  //    resolve and include the REAL custodian (config.identities.bondCustodian) instead.
  // 2. A `knownGroupId` that fails to resume used to silently fall through to creating a
  //    brand-new (differently-id'd) group -- defeating the entire point of passing a known id
  //    (per-call-site duplicate groups, never detected). Now throws instead.
  async ensureOutrightGroup(bankALookup: string, bankBLookup: string, knownGroupId?: string): Promise<{ groupId: string }> {
    try {
      if (knownGroupId) {
        const resumed = await new PenteFactory(this.sdk, "pente").resumePrivacyGroup({ id: knownGroupId });
        if (!resumed) throw new PaladinClientError("PD_CLIENT_GROUP_NOT_FOUND", `knownGroupId ${knownGroupId} could not be resumed`);
        return { groupId: knownGroupId };
      }
      const pairKey = [bankALookup, bankBLookup].sort().join("|");
      let cached = this.outrightGroups.get(pairKey);
      if (!cached) {
        cached = (async () => {
          const [bankA] = this.sdk.getVerifiers(requireLookup(bankALookup, "bankALookup"));
          const [bankB] = this.sdk.getVerifiers(requireLookup(bankBLookup, "bankBLookup"));
          const bondCustodian = this.requireIdentityVerifier("bondCustodian");
          const group = await new PenteFactory(this.sdk, "pente")
            .newPrivacyGroup({ members: [bankA, bankB, bondCustodian], evmVersion: "shanghai", externalCallsEnabled: false })
            .waitForDeploy(DEFAULT_POLL_TIMEOUT);
          if (!group) throw new PaladinClientError("PD_CLIENT_ENSURE_OUTRIGHT_GROUP_FAILED", "outright group deploy failed");
          return group;
        })();
        this.outrightGroups.set(pairKey, cached);
      }
      const group = await cached;
      return { groupId: group.group.id };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // Public symmetric counterpart for the primary flow's group (D1's "existing investor+
  // custodian group", 2-party: this client's own identity + bondCustodian) -- same
  // ensure-or-create-once shape as ensureOutrightGroup, built on the existing private helper.
  async ensurePrimaryGroup(): Promise<{ groupId: string }> {
    try {
      const group = await this.getOrCreateInvestorCustodianGroup();
      return { groupId: group.group.id };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async deployAgreement(groupId: string, idempotencyKey?: string): Promise<{ agreementAddress: string }> {
    try {
      const bondCustodian = this.requireIdentityVerifier("bondCustodian");
      // Solidity-auditor fix (2026-10-05, agent 2 FINDING "unchecked-trusted-role-param"):
      // Agreement's `bi` is set from THIS call's bondCustodian resolution -- previously any
      // group member's client could deploy and set `bi_` from its own (possibly misconfigured)
      // local config, with no on-chain or client-side check that the deployer is really BI.
      // Same isBI gate ensureInvestorCustodianGroup already uses for its own BI-only branch.
      if (this.verifier.lookup !== bondCustodian.lookup) {
        throw new PaladinClientError("PD_CLIENT_WRONG_ROLE", `deployAgreement must be called by bondCustodian ("${bondCustodian.lookup}"), not "${this.verifier.lookup}" -- only BI's own client may set itself as the Agreement's trusted bi role`);
      }
      const group = await new PenteFactory(this.sdk, "pente").resumePrivacyGroup({ id: groupId });
      if (!group) throw new PaladinClientError("PD_CLIENT_GROUP_NOT_FOUND", `privacy group ${groupId} not found`);
      // 0.4.2 bugfix: was a raw `.waitForDeploy(...)` with no PD012220 recovery -- see
      // resolveIdempotentFuture's doc comment above for the bug this caused on a BI reboot
      // after a DB reset.
      const future = group.deploy(
        { abi: agreementArtifact.abi, bytecode: agreementArtifact.bytecode.object, from: this.verifier.lookup, inputs: { bi_: await bondCustodian.address() } },
        { idempotencyKey }
      );
      const receipt = await resolveIdempotentFuture(this.sdk, future.id, idempotencyKey, DEFAULT_POLL_TIMEOUT, true);
      const address = receipt?.domainReceipt && "receipt" in receipt.domainReceipt ? receipt.domainReceipt.receipt.contractAddress : undefined;
      if (!address) throw new PaladinClientError("PD_CLIENT_DEPLOY_AGREEMENT_FAILED", "Agreement deploy failed");
      this.agreements.set(agreementCacheKey(groupId, address), { group, agreement: new Agreement(group, address) });
      return { agreementAddress: address };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // Mirrors resumeSubscription -- lets a counterparty (who never called deployAgreement or
  // proposeAgreement itself) resolve this client's cache before calling acceptAgreement/
  // recordLeg/etc. Not in the lead's original #8 approval; added to close the same resumability
  // gap resumeSubscription already closes for BondSubscription, same in-memory-only caveat.
  // 0.5.0: param order swapped to (groupId, agreementAddress) -- consistent with every other
  // method here, which all take groupId first. This is a breaking change.
  async resumeAgreement(groupId: string, agreementAddress: string): Promise<void> {
    try {
      const group = await new PenteFactory(this.sdk, "pente").resumePrivacyGroup({ id: groupId });
      if (!group) throw new PaladinClientError("PD_CLIENT_GROUP_NOT_FOUND", `privacy group ${groupId} not found`);
      this.agreements.set(agreementCacheKey(groupId, agreementAddress), { group, agreement: new Agreement(group, agreementAddress) });
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async proposeAgreement(
    groupId: string,
    agreementAddress: string,
    tradeId: string,
    productType: string,
    legs: AgreementLeg[],
    idempotencyKey?: string
  ): Promise<void> {
    try {
      if (!this.agreements.has(agreementCacheKey(groupId, agreementAddress))) {
        await this.resumeAgreement(groupId, agreementAddress);
      }
      const { agreement } = this.requireAgreement(groupId, agreementAddress);
      const productTypeBytes32 = productType.startsWith("0x") && productType.length === 66 ? productType : ethers.id(productType);
      // D2: legs[].from/to are LOOKUPS now (not addresses, C5's finding) -- resolved here,
      // once, before the on-chain call. `asset` stays a contract address (not an identity).
      const resolvedLegs = await Promise.all(
        legs.map(async (l) => ({
          asset: l.asset,
          from: await this.sdk.getVerifiers(requireLookup(l.from, "legs[].from"))[0].address(),
          to: await this.sdk.getVerifiers(requireLookup(l.to, "legs[].to"))[0].address(),
          amount: l.amount,
        }))
      );
      const receipt = await this.submitIdempotent(
        () =>
          Promise.resolve(
            agreement.sendTransaction(
              {
                from: this.verifier.lookup,
                function: "propose",
                data: { tradeId, productType: productTypeBytes32, legs: resolvedLegs },
              },
              { idempotencyKey }
            ).id
          ),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_PROPOSE_AGREEMENT_FAILED", `propose failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // 0.6.7 (D31, 2026-10-07): replaces backend's own revert-as-signal presence probe
  // (`atomParties.ts:17`'s `getAgreement(..., "onboard-presence-probe")`, a bogus tradeId
  // relying on Agreement's own "TradeNotFound" revert) with a call to a REAL view function
  // (`Agreement.sol:75`'s public immutable `bi`) that doesn't log a Pente ERROR on the happy
  // path. "no contract deployed" (the group/address genuinely has no Agreement) -> false;
  // anything else (group not found, network error, etc.) -> throw, same as every other method.
  async agreementExists(groupId: string, agreementAddress: string): Promise<boolean> {
    try {
      if (!this.agreements.has(agreementCacheKey(groupId, agreementAddress))) {
        await this.resumeAgreement(groupId, agreementAddress);
      }
      const { agreement } = this.requireAgreement(groupId, agreementAddress);
      await agreement.call({ from: this.verifier.lookup, function: "bi" });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("no contract deployed")) return false;
      throw toPaladinClientError(err);
    }
  }

  async acceptAgreement(groupId: string, agreementAddress: string, tradeId: string, idempotencyKey?: string): Promise<void> {
    try {
      const { agreement } = this.requireAgreement(groupId, agreementAddress);
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(agreement.sendTransaction({ from: this.verifier.lookup, function: "accept", data: { tradeId } }, { idempotencyKey }).id),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_ACCEPT_AGREEMENT_FAILED", `accept failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // Task #15 (lead report): the on-chain leg stores ADDRESSES (D2 -- proposeAgreement resolves
  // lookup->address once, at propose time), so a backend reading getAgreement and calling
  // lockToken/prepareUnlock itself had to pass a raw address as a recipient -- requireLookup
  // rightly rejects that. This method does the whole prepare step so the backend only ever
  // hands over IDENTITIES: it resolves recipientLookup -> address itself and asserts it
  // matches the chain's own recorded leg.to, instead of trusting the caller's claim.
  //
  // Idempotency: leg.lockId/unlockCall are always empty pre-recordLeg (Agreement.sol's
  // one-shot guard keys on unlockCall.length, set only by recordLeg itself) -- there is no
  // on-chain signal yet to resume from. Retry-safety comes entirely from threading
  // idempotencyKey into lockToken/prepareUnlock, which already recover a PD012220 themselves.
  // 0.6.0 (task #19): `asIdentity` lets BI's own client prepare a leg it owns under a
  // DIFFERENT configured identity than its connection default -- e.g. coupon/redemption's
  // cash leg, owned by `bondIssuer`, prepared from a client connected as `bondCustodian`.
  // Omitting it preserves today's behavior (the leg owner must be `this.verifier`) exactly.
  async prepareTradeLeg(
    groupId: string,
    agreementAddress: string,
    tradeId: string,
    legIndex: number,
    recipientLookup: string,
    idempotencyKey?: string,
    asIdentity?: "bondIssuer" | "bondCustodian" | "cashIssuer"
  ): Promise<{ lockId: string; unlockCall: string; cancelCall: string; preparedStateId: string }> {
    try {
      const subKey = (step: string) => (idempotencyKey ? `${idempotencyKey}:${step}` : undefined);
      const signer = asIdentity ? this.requireIdentityVerifier(asIdentity) : this.verifier;
      const trade = await this.getAgreement(groupId, agreementAddress, tradeId);
      const leg = trade.legs[legIndex];
      if (!leg) throw new PaladinClientError("PD_CLIENT_LEG_INDEX_OUT_OF_RANGE", `trade ${tradeId} has no leg ${legIndex} (it has ${trade.legs.length})`);

      const myAddress = await signer.address();
      requireLegOwner(leg.from, myAddress, legIndex, tradeId);

      const recipientAddress = await this.sdk.getVerifiers(requireLookup(recipientLookup, "recipientLookup"))[0].address();
      requireLegRecipientMatch(leg.to, recipientAddress, recipientLookup, legIndex, tradeId);

      await this.checkInvestorWhitelistForLock(leg.asset, recipientAddress);

      const { lockId } = await this.lockToken(leg.asset, leg.amount, subKey("lock"), asIdentity);
      try {
        return await this.prepareUnlock(leg.asset, lockId, [{ to: recipientLookup, amount: leg.amount }], subKey("prepare"), undefined, asIdentity);
      } catch (prepareErr) {
        let released = false;
        try {
          await this.releaseLock(leg.asset, lockId, subKey("compensate-release"), asIdentity);
          released = true;
        } catch {
          released = false;
        }
        const originalCode = prepareErr instanceof PaladinClientError ? prepareErr.code : "PD_CLIENT_PREPARE_FAILED";
        throw lockRecoveryError(
          originalCode,
          `prepareTradeLeg: prepareUnlock failed after lockToken already succeeded (lockId=${lockId}); compensating release ${released ? "succeeded" : "FAILED -- lock is still held, needs manual recovery"}. Original error: ${prepareErr instanceof Error ? prepareErr.message : String(prepareErr)}`,
          prepareErr,
          lockId,
          released,
          leg.asset
        );
      }
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // 0.6.1: `asIdentity`, same pattern as prepareTradeLeg -- recordLeg signs as the leg's owner
  // (the `from` on the Agreement tx), which may differ from this client's connection default.
  async recordLeg(
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
  ): Promise<void> {
    try {
      // 0.6.6 (real incident, task #27b): recordLeg used to submit whatever lockId/unlockCall/
      // cancelCall the caller passed, no questions asked. Defense-in-depth: the E9 incident's
      // actual root cause was backend's "0x" truthy check skipping prepare+record entirely for
      // an un-prepared leg, then storing the CHAIN'S OWN zero sentinels (see isZeroHex's own
      // doc comment) in its own DB as if they were real -- recordLeg was never even called.
      // This guard doesn't fix that path (it never reached us); it keeps those same sentinel
      // values from ever reaching the chain through THIS method, whatever upstream mistake
      // produces them.
      if (isZeroHex(lockId) || isZeroHex(unlockCall) || isZeroHex(cancelCall)) {
        throw new PaladinClientError(
          "PD_CLIENT_PREPARE_FAILED",
          `recordLeg: refusing to record leg ${legIndex} of trade ${tradeId} with lockId=${lockId} unlockCall=${unlockCall} cancelCall=${cancelCall} -- this looks like an unprepared/placeholder leg, not a real prepared lock`
        );
      }
      const signer = asIdentity ? this.requireIdentityVerifier(asIdentity) : this.verifier;
      const { agreement } = this.requireAgreement(groupId, agreementAddress);
      const receipt = await this.submitIdempotent(
        () =>
          Promise.resolve(
            agreement.sendTransaction(
              { from: signer.lookup, function: "recordLeg", data: { tradeId, legIndex: String(legIndex), lockId, preparedStateId, unlockCall, cancelCall } },
              { idempotencyKey }
            ).id
          ),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_RECORD_LEG_FAILED", `recordLeg failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async recordAtom(groupId: string, agreementAddress: string, tradeId: string, atomAddress: string, idempotencyKey?: string): Promise<void> {
    try {
      const { agreement } = this.requireAgreement(groupId, agreementAddress);
      const bondCustodian = this.requireIdentityVerifier("bondCustodian");
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(agreement.sendTransaction({ from: bondCustodian.lookup, function: "recordAtom", data: { tradeId, atomAddress } }, { idempotencyKey }).id),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_RECORD_ATOM_FAILED", `recordAtom failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async confirmSettled(groupId: string, agreementAddress: string, tradeId: string, idempotencyKey?: string): Promise<void> {
    try {
      const { agreement } = this.requireAgreement(groupId, agreementAddress);
      const bondCustodian = this.requireIdentityVerifier("bondCustodian");
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(agreement.sendTransaction({ from: bondCustodian.lookup, function: "confirmSettled", data: { tradeId } }, { idempotencyKey }).id),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_CONFIRM_SETTLED_FAILED", `confirmSettled failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async markFailed(groupId: string, agreementAddress: string, tradeId: string, idempotencyKey?: string): Promise<void> {
    try {
      const { agreement } = this.requireAgreement(groupId, agreementAddress);
      const bondCustodian = this.requireIdentityVerifier("bondCustodian");
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(agreement.sendTransaction({ from: bondCustodian.lookup, function: "markFailed", data: { tradeId } }, { idempotencyKey }).id),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_MARK_FAILED_FAILED", `markFailed failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async cancelAgreement(groupId: string, agreementAddress: string, tradeId: string, idempotencyKey?: string): Promise<void> {
    try {
      const { agreement } = this.requireAgreement(groupId, agreementAddress);
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(agreement.sendTransaction({ from: this.verifier.lookup, function: "cancel", data: { tradeId } }, { idempotencyKey }).id),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_CANCEL_AGREEMENT_FAILED", `cancel failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async getAgreement(groupId: string, agreementAddress: string, tradeId: string): Promise<AgreementTrade> {
    try {
      const { agreement } = this.requireAgreement(groupId, agreementAddress);
      const result = (await agreement.call({ from: this.verifier.lookup, function: "getAgreement", data: { tradeId } })) as any;
      const trade = result["0"] ?? result.trade;
      return {
        tradeId: trade.tradeId,
        productType: trade.productType,
        legs: (trade.legs as any[]).map((l) => ({
          asset: normAddr(l.asset),
          from: normAddr(l.from),
          to: normAddr(l.to),
          amount: l.amount,
          lockId: l.lockId,
          preparedStateId: l.preparedStateId,
          unlockCall: l.unlockCall,
          cancelCall: l.cancelCall,
          prepared: !isZeroHex(l.preparedStateId),
        })),
        state: AGREEMENT_STATE[Number(trade.state)] as AgreementTrade["state"],
        atomAddress: normAddr(trade.atomAddress),
      };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // RestrictedAtomFactory is a plain public contract, shared across every trade atom and
  // every bank -- deployed ONCE by the bootstrap, never by a client at runtime (lead fix,
  // 2026-10-05: the old deploy-at-runtime branch was dead code -- validateClientConfig
  // already requires contractData.restrictedAtomFactoryAddress, so `configured` was always
  // truthy in practice -- and keeping it would have let each bank's client silently deploy
  // and use a DIFFERENT factory if that required config were ever missing).
  private getOrDeployRestrictedAtomFactory(): string {
    const configured = this.config.contractData?.restrictedAtomFactoryAddress as string | undefined;
    if (!configured) throw new PaladinClientError("PD_CLIENT_MISSING_CONFIG", "config.contractData.restrictedAtomFactoryAddress is not set");
    return configured;
  }

  // D2 (architecture review, 2026-10-05): `parties`/`executor` are LOOKUPS (`name@node`), not
  // addresses -- paladin-client resolves them internally, matching prepareUnlock's existing
  // convention. One rule everywhere identity flows through this client (C5's finding: mixed
  // forms across agreement legs/atom parties/prepareUnlock was the root confusion).
  async createAtom(
    operations: { contractAddress: string; callData: string }[],
    cancelOperations: { contractAddress: string; lockId: string; callData: string }[],
    parties: string[],
    executor: string,
    idempotencyKey?: string
  ): Promise<{ atomAddress: string }> {
    try {
      const factoryAddress = this.getOrDeployRestrictedAtomFactory();
      const partyAddresses = await Promise.all(parties.map((p) => this.sdk.getVerifiers(requireLookup(p, "parties[]"))[0].address()));
      const executorAddress = await this.sdk.getVerifiers(requireLookup(executor, "executor"))[0].address();
      const receipt = await this.submitIdempotent(
        () =>
          this.sdk.ptx.sendTransaction({
            type: TransactionType.PUBLIC,
            abi: restrictedAtomFactoryArtifact.abi,
            function: "create",
            from: this.verifier.lookup,
            to: factoryAddress,
            data: { operations, cancelOperations, parties: partyAddresses, executor: executorAddress },
            idempotencyKey,
          }),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_CREATE_ATOM_FAILED", `RestrictedAtomFactory.create failed: ${receipt?.failureMessage ?? "no receipt"}`);
      // create()'s return value isn't in the receipt -- decode the AtomDeployed event from
      // the tx's own logs instead (same pattern releaseLock below reuses).
      const events = await this.sdk.bidx.decodeTransactionEvents(receipt.transactionHash!, restrictedAtomFactoryArtifact.abi, "");
      const deployed = events.find((e) => e.soliditySignature.startsWith("event AtomDeployed"));
      const atomAddress = (deployed?.data as { addr?: string } | undefined)?.addr;
      if (!atomAddress) throw new PaladinClientError("PD_CLIENT_CREATE_ATOM_FAILED", "no AtomDeployed event found");
      return { atomAddress };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }
  // Architecture review fix (2026-10-05): this used to hardcode `bondCustodian` as the
  // signer, which throws PD_CLIENT_MISSING_CONFIG for any client without that identity
  // configured (e.g. an investor calling releaseLock's own self-release atom, whose executor
  // is the investor, never bondCustodian) and would simply be WRONG for any atom whose real
  // `executor` isn't bondCustodian -- RestrictedAtom.execute() is onlyExecutor-gated on-chain
  // regardless of who the Paladin tx sender is, so signing as `this.verifier` (matching
  // cancelAtom's already-correct pattern) is both more general and no less safe: the
  // on-chain gate is what actually enforces correctness, not which identity happens to submit.
  async executeAtom(atomAddress: string, idempotencyKey?: string): Promise<void> {
    try {
      const receipt = await this.submitIdempotent(
        () =>
          this.sdk.ptx.sendTransaction({
            type: TransactionType.PUBLIC,
            abi: restrictedAtomArtifact.abi,
            function: "execute",
            from: this.verifier.lookup,
            to: atomAddress,
            data: {},
            idempotencyKey,
          }),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_EXECUTE_ATOM_FAILED", `executeAtom failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }
  async cancelAtom(atomAddress: string, idempotencyKey?: string): Promise<void> {
    try {
      const receipt = await this.submitIdempotent(
        () =>
          this.sdk.ptx.sendTransaction({
            type: TransactionType.PUBLIC,
            abi: restrictedAtomArtifact.abi,
            function: "cancel",
            from: this.verifier.lookup,
            to: atomAddress,
            data: {},
            idempotencyKey,
          }),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_CANCEL_ATOM_FAILED", `cancelAtom failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // Also add a retryRelease wrapper (RestrictedAtom's own 0.3.0 audit fix) -- a leg whose
  // release failed during cancel() (not skipped as undelegated) can be retried without
  // redeploying the atom. Same generic-identity reasoning as executeAtom/cancelAtom above.
  async retryReleaseAtom(atomAddress: string, legIndex: number, idempotencyKey?: string): Promise<void> {
    try {
      const receipt = await this.submitIdempotent(
        () =>
          this.sdk.ptx.sendTransaction({
            type: TransactionType.PUBLIC,
            abi: restrictedAtomArtifact.abi,
            function: "retryRelease",
            from: this.verifier.lookup,
            to: atomAddress,
            data: { index: String(legIndex) },
            idempotencyKey,
          }),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_RETRY_RELEASE_FAILED", `retryRelease failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async verifyDelegatedLeg(
    tokenAddress: string,
    lockId: string,
    unlockCall: string,
    expected: { recipient: string; amount: string; owner: string },
    atomAddress: string
  ): Promise<{ ok: boolean; reason?: string; outputs?: string[] }> {
    return verifyDelegatedLeg(this.sdk, "noto", this.verifier.lookup, tokenAddress, lockId, unlockCall, expected, atomAddress);
  }

  async verifyCancelCall(tokenAddress: string, lockId: string, cancelCall: string, owner: string): Promise<{ ok: boolean; reason?: string; outputs?: string[] }> {
    return verifyCancelCall(this.sdk, "noto", this.verifier.lookup, tokenAddress, lockId, cancelCall, owner);
  }

  // ---------------------------------------------------------------------------
  // PHASE 3 (task #6b) -- implemented, lead-confirmed shapes (2026-10-05).
  // ---------------------------------------------------------------------------

  async issueSeries(p: SeriesRegistrationParams, idempotencyKey?: string): Promise<IssueSeriesResult> {
    try {
      const bondIssuer = this.requireIdentityVerifier("bondIssuer");
      const bondCustodian = this.requireIdentityVerifier("bondCustodian");
      const registryAddress = this.requireRegistryAddress();
      const subKey = (step: string) => (idempotencyKey ? `${idempotencyKey}:${step}` : undefined);

      // BACKLOG #10: validate ALL registry-field encodings BEFORE any deploy (group/trackers/
      // Noto). A bad ISIN/date/hash used to throw inside registerSeries -- after group + public
      // tracker + private tracker + Noto token were already deployed -- orphaning them all
      // (two real orphaned-approval incidents: tx cc982051, 5bf41ebf).
      const enc = encodeSeriesFields(p);

      // Group creation does not support idempotencyKey through this SDK wrapper
      // (PenteFactory.newPrivacyGroup never forwards transactionOptions) -- a retry that gets
      // this far re-creates a new group, same as the ponytail note below for the whole function.
      const group = await new PenteFactory(this.sdk, "pente")
        .newPrivacyGroup({ members: [bondIssuer, bondCustodian], evmVersion: "shanghai", externalCallsEnabled: true })
        .waitForDeploy(DEFAULT_POLL_TIMEOUT);
      if (!group) throw new PaladinClientError("PD_CLIENT_ISSUE_SERIES_FAILED", "issuer+custodian group deploy failed");

      // D3 encoding fix (live-proof finding, 2026-10-05): BondTrackerPublic's constructor
      // takes issueDate_/maturityDate_ as uint256 unix-seconds, same as registerSeries below --
      // this call was still passing the raw ISO date strings, reverting with "FF22088: Invalid
      // integer string" on every real issueSeries call. registerSeries got the D3 fix; this
      // earlier deploy in the same function did not.
      const publicTrackerAddress = await this.deployPublicContract(
        bondIssuer,
        bondTrackerPublicArtifact,
        { owner: group.address, issueDate_: enc.issueDate, maturityDate_: enc.maturityDate, currencyToken_: p.currencyToken, faceValue_: p.faceValue },
        subKey("deploy-public-tracker")
      );

      const custodianAddr = await bondCustodian.address();
      // 0.4.2 bugfix: was a raw `.waitForDeploy(...)` with no PD012220 recovery, same bug as
      // deployAgreement above -- see resolveIdempotentFuture's doc comment.
      const privateTrackerKey = subKey("deploy-private-tracker");
      const privateTrackerFuture = group.deploy(
        {
          abi: bondTrackerArtifact.abi,
          bytecode: bondTrackerArtifact.bytecode.object,
          from: bondIssuer.lookup,
          inputs: { name: p.seriesCode, symbol: p.seriesCode, custodian: custodianAddr, publicTracker: publicTrackerAddress },
        },
        { idempotencyKey: privateTrackerKey }
      );
      const privateTrackerReceipt = await resolveIdempotentFuture(this.sdk, privateTrackerFuture.id, privateTrackerKey, DEFAULT_POLL_TIMEOUT, true);
      const privateTrackerAddress =
        privateTrackerReceipt?.domainReceipt && "receipt" in privateTrackerReceipt.domainReceipt ? privateTrackerReceipt.domainReceipt.receipt.contractAddress : undefined;
      if (!privateTrackerAddress) throw new PaladinClientError("PD_CLIENT_ISSUE_SERIES_FAILED", "BondTracker deploy failed");
      const privateTracker = new BondTracker(group, privateTrackerAddress);

      // 0.4.2 bugfix: same bug, but this deploy is Noto (a ptx_sendTransaction PRIVATE deploy,
      // not a Pente group deploy) -- its receipt's contractAddress is top-level, no
      // domainReceipt nesting, so full=false (the default) is correct here.
      const notoKey = subKey("deploy-token");
      const notoFuture = new NotoFactory(this.sdk, "noto").newNoto(
        bondIssuer,
        {
          name: p.seriesCode,
          symbol: p.seriesCode,
          notary: bondCustodian,
          notaryMode: "hooks",
          options: { hooks: { privateGroup: group, publicAddress: group.address, privateAddress: privateTrackerAddress } },
        },
        notoKey
      );
      const notoReceipt = await resolveIdempotentFuture(this.sdk, notoFuture.id, notoKey, DEFAULT_POLL_TIMEOUT);
      if (!notoReceipt?.contractAddress) throw new PaladinClientError("PD_CLIENT_ISSUE_SERIES_FAILED", "Noto bond token deploy failed");
      const token = notoReceipt.contractAddress;

      // ponytail: if registerSeries itself fails here, the group/trackers/token above are
      // already deployed and orphaned -- harmless (costs only gas); a retry WITHOUT
      // idempotencyKey (or after the group-creation gap above) re-deploys from scratch rather
      // than needing any cleanup. With idempotencyKey, every step past group creation resolves
      // to its own original result instead of re-submitting.
      // D4: signed by bondCustodian (the registry's actual onlyOwner), not bondIssuer -- C4's
      // finding: every registerSeries call was reverting, signed by the wrong identity.
      const registerReceipt = await this.submitIdempotent(
        () =>
          this.sdk.ptx.sendTransaction({
            type: TransactionType.PUBLIC,
            abi: bondSeriesRegistryArtifact.abi,
            function: "registerSeries",
            from: bondCustodian.lookup,
            to: registryAddress,
            data: {
              token,
              // D3: encode human values the way the contract's bytes32/bytes12/uint64 fields
              // actually need, not raw (C6's finding) -- pre-validated above, BACKLOG #10.
              instrumentType: enc.instrumentType,
              seriesCode: enc.seriesCode,
              isin: enc.isin,
              currencyToken: p.currencyToken,
              faceValue: p.faceValue,
              issueDate: enc.issueDate,
              maturityDate: enc.maturityDate,
              transferRestricted: p.transferRestricted,
              termsHash: enc.termsHash,
              // v2 registry field (0.4.1): already public on-chain via the registry itself, so
              // getDistributionState/getPrice derive it from getSeries(token).publicTracker
              // instead of SeriesContext caching it -- see SeriesContext's own doc comment.
              publicTracker: publicTrackerAddress,
            },
            idempotencyKey: subKey("register-series"),
          }),
        subKey("register-series")
      );
      if (!registerReceipt?.success) {
        throw new PaladinClientError("PD_CLIENT_ISSUE_SERIES_FAILED", `registerSeries failed: ${registerReceipt?.failureMessage ?? "no receipt"}`);
      }

      const investorListAddress = (await privateTracker.call({ from: bondIssuer.lookup, function: "investorList" }))[0] as string;
      this.seriesContexts.set(token.toLowerCase(), { group, privateTracker, investorListAddress });
      return { token, privateTracker: privateTrackerAddress, publicTracker: publicTrackerAddress, groupId: group.group.id };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // 0.4.1: rebuilds the BI-private half of SeriesContext after a process restart, for a token
  // this client's identity already issued. `groupId` and `privateTrackerAddress` MUST come from
  // BI's own DB -- specifically, from the ORIGINAL issueSeries call's returned IssueSeriesResult
  // (groupId, privateTracker) -- because neither value is derivable from any on-chain state
  // Paladin exposes: there is no on-chain mapping from a Noto token to the Pente group that
  // privately hosts its hooks, and no way to enumerate a Pente group's deployed contracts from
  // its id alone. `publicTracker` is deliberately NOT a param here -- v2's whole point is that
  // it's now derivable via getSeries(token).publicTracker instead of needing to be cached or
  // persisted at all (see SeriesContext's own doc comment).
  async resumeSeries(token: string, groupId: string, privateTrackerAddress: string): Promise<void> {
    try {
      const bondIssuer = this.requireIdentityVerifier("bondIssuer");
      const group = await new PenteFactory(this.sdk, "pente").resumePrivacyGroup({ id: groupId });
      if (!group) throw new PaladinClientError("PD_CLIENT_GROUP_NOT_FOUND", `knownGroupId ${groupId} could not be resumed`);
      const privateTracker = new BondTracker(group, privateTrackerAddress);
      const investorListAddress = (await privateTracker.call({ from: bondIssuer.lookup, function: "investorList" }))[0] as string;
      this.seriesContexts.set(token.toLowerCase(), { group, privateTracker, investorListAddress });
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async mintTranche(token: string, amount: string, idempotencyKey?: string): Promise<void> {
    try {
      this.requireSeriesContext(token);
      const bondIssuer = this.requireIdentityVerifier("bondIssuer");
      const bondCustodian = this.requireIdentityVerifier("bondCustodian");
      const noto = new NotoInstance(this.sdk, token);
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(noto.mint(bondIssuer, { to: bondCustodian, amount, data: "0x" }, idempotencyKey).id),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_MINT_TRANCHE_FAILED", `mintTranche failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async beginDistribution(token: string, p: { price: string; minimumDenomination: string }, idempotencyKey?: string): Promise<void> {
    await this.sendBondTrackerTx(token, "beginDistribution", "bondCustodian", { discountPrice: p.price, minimumDenomination: p.minimumDenomination }, idempotencyKey);
  }
  async closeDistribution(token: string, idempotencyKey?: string): Promise<void> {
    await this.sendBondTrackerTx(token, "closeDistribution", "bondCustodian", {}, idempotencyKey);
  }
  async setActive(token: string, idempotencyKey?: string): Promise<void> {
    await this.sendBondTrackerTx(token, "setActive", "bondIssuer", {}, idempotencyKey);
  }
  async forceCompleteDistribution(token: string, idempotencyKey?: string): Promise<void> {
    await this.sendBondTrackerTx(token, "forceCompleteDistribution", "bondCustodian", {}, idempotencyKey);
  }

  private async sendBondTrackerTx(
    token: string,
    fn: string,
    signer: "bondIssuer" | "bondCustodian",
    data: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<void> {
    try {
      const ctx = this.requireSeriesContext(token);
      const verifier = this.requireIdentityVerifier(signer);
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(ctx.privateTracker.sendTransaction({ from: verifier.lookup, function: fn, data }, { idempotencyKey }).id),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_BOND_TRACKER_TX_FAILED", `${fn} failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async getSeries(token: string): Promise<SeriesRegistryEntry> {
    try {
      const registryAddress = this.requireRegistryAddress();
      const result = await this.sdk.ptx.call({
        type: TransactionType.PUBLIC,
        abi: bondSeriesRegistryArtifact.abi,
        function: "getSeries",
        to: registryAddress,
        from: this.verifier.lookup,
        data: { token },
      });
      const series = (result as any)["0"];
      // D3: decode every field back to its human form, including the 3 that were previously
      // missing entirely (instrumentType, seriesCode, termsVersion).
      return {
        instrumentType: fromFixedBytes(series.instrumentType),
        seriesCode: fromFixedBytes(series.seriesCode),
        isin: fromFixedBytes(series.isin),
        currencyToken: series.currencyToken,
        faceValue: series.faceValue,
        issueDate: fromUnixSeconds(series.issueDate),
        maturityDate: fromUnixSeconds(series.maturityDate),
        status: SERIES_STATUS[Number(series.status)],
        transferRestricted: series.transferRestricted,
        termsHash: series.termsHash.startsWith("0x") ? series.termsHash : "0x" + series.termsHash,
        termsVersion: String(series.termsVersion),
        // v2 registry field (0.4.1): plain address, no encoding/decoding needed -- same
        // pass-through as currencyToken above.
        publicTracker: series.publicTracker,
      };
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // D4: signed by bondCustodian (the registry's actual onlyOwner), not bondIssuer.
  async setSeriesStatus(token: string, status: SeriesRegistryEntry["status"], idempotencyKey?: string): Promise<void> {
    try {
      const bondCustodian = this.requireIdentityVerifier("bondCustodian");
      const registryAddress = this.requireRegistryAddress();
      const receipt = await this.submitIdempotent(
        () =>
          this.sdk.ptx.sendTransaction({
            type: TransactionType.PUBLIC,
            abi: bondSeriesRegistryArtifact.abi,
            function: "setStatus",
            from: bondCustodian.lookup,
            to: registryAddress,
            data: { token, status: SERIES_STATUS.indexOf(status) },
            idempotencyKey,
          }),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_SET_SERIES_STATUS_FAILED", `setStatus failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async updateTerms(token: string, newTermsHash: string, idempotencyKey?: string): Promise<void> {
    try {
      const bondCustodian = this.requireIdentityVerifier("bondCustodian");
      const registryAddress = this.requireRegistryAddress();
      const receipt = await this.submitIdempotent(
        () =>
          this.sdk.ptx.sendTransaction({
            type: TransactionType.PUBLIC,
            abi: bondSeriesRegistryArtifact.abi,
            function: "updateTerms",
            from: bondCustodian.lookup,
            to: registryAddress,
            data: { token, newTermsHash: toBytes32Hash(newTermsHash, "newTermsHash") },
            idempotencyKey,
          }),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_UPDATE_TERMS_FAILED", `updateTerms failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }


  async getDistributionState(token: string): Promise<DistributionState> {
    try {
      // 0.4.1: resolved via the v2 registry (works from ANY process/node), not the in-memory
      // SeriesContext cache -- see SeriesContext's own doc comment.
      const publicTrackerAddress = (await this.getSeries(token)).publicTracker;
      // 0.7.0: legacy series keep the public-amounts path; status-only series read units and
      // price from the private tracker (BI only -- a client without a series context gets the
      // public fields only).
      if ((await this.publicTrackerSchema(publicTrackerAddress)) === "legacy") {
        return await readLegacyDistributionState(this.sdk, this.verifier.lookup, publicTrackerAddress);
      }
      return await readStatusOnlyDistributionState(this.sdk, this.verifier.lookup, publicTrackerAddress, this.privateRoundReader(token));
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  async getPrice(token: string, units: string): Promise<string> {
    try {
      // 0.4.1: resolved via the v2 registry (works from ANY process/node), not the in-memory
      // SeriesContext cache -- see SeriesContext's own doc comment.
      const publicTrackerAddress = (await this.getSeries(token)).publicTracker;
      if ((await this.publicTrackerSchema(publicTrackerAddress)) === "status-only") {
        // 0.7.0: the price is private. Only a client holding the series context (BI) can compute it.
        const priv = this.privateRoundReader(token);
        if (!priv) this.requireSeriesContext(token); // throws PD_CLIENT_UNKNOWN_SERIES with the usual hint
        const [discountPrice, minimumDenomination] = await Promise.all([priv!.discountPrice(), priv!.minimumDenomination()]);
        return statusOnlyPrice(units, discountPrice, minimumDenomination);
      }
      const distributionAddress = await readDistributionAddress(this.sdk, this.verifier.lookup, publicTrackerAddress);
      if (distributionAddress.toLowerCase() === ZERO_ADDRESS) {
        throw new PaladinClientError("PD_CLIENT_NO_DISTRIBUTION_ROUND", `${token} has no distribution round yet -- call beginDistribution first`);
      }
      const result = await this.sdk.ptx.call({
        type: TransactionType.PUBLIC,
        abi: tokenDistributionArtifact.abi,
        function: "getPrice",
        to: distributionAddress,
        from: this.verifier.lookup,
        data: { quantity: units },
      });
      return String((result as any)["0"]);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }

  // Cached per public tracker address: the schema of a deployed tracker never changes.
  private trackerSchemas = new Map<string, PublicTrackerSchema>();
  private async publicTrackerSchema(publicTrackerAddress: string): Promise<PublicTrackerSchema> {
    const key = publicTrackerAddress.toLowerCase();
    let schema = this.trackerSchemas.get(key);
    if (!schema) {
      schema = await detectPublicTrackerSchema(this.sdk, this.verifier.lookup, publicTrackerAddress);
      this.trackerSchemas.set(key, schema);
    }
    return schema;
  }

  // Private round terms via the series' privacy group; undefined when this client holds no series context.
  private privateRoundReader(token: string): PrivateRoundReader | undefined {
    const ctx = this.seriesContexts.get(token.toLowerCase());
    if (!ctx) return undefined;
    const from = this.requireIdentityVerifier("bondIssuer").lookup;
    const read = async (fn: string) => String((await ctx.privateTracker.call({ from, function: fn }))[0]);
    return { availableUnits: () => read("availableUnitsPrivate"), discountPrice: () => read("discountPrice"), minimumDenomination: () => read("minimumDenomination") };
  }

  async addInvestor(bondAddress: string, lookup: string, idempotencyKey?: string): Promise<void> {
    await this.setInvestorRegistration(bondAddress, lookup, true, idempotencyKey);
  }

  async setInvestorStatus(bondAddress: string, lookup: string, status: "approved" | "revoked", idempotencyKey?: string): Promise<void> {
    await this.setInvestorRegistration(bondAddress, lookup, status === "approved", idempotencyKey);
  }

  // InvestorList (solidity/contracts/private/InvestorList.sol) has no "approved"/"revoked"
  // status concept -- only addInvestor/removeInvestor/isRegistered. "approved" maps to
  // addInvestor, "revoked" to removeInvestor, each a no-op (checked first, not a bare retry of
  // a revert) if already in the target state, since both are one-shot (addInvestor reverts
  // "Investor already added", removeInvestor reverts "Investor already removed").
  private async setInvestorRegistration(bondAddress: string, lookup: string, wantRegistered: boolean, idempotencyKey?: string): Promise<void> {
    try {
      const ctx = this.requireSeriesContext(bondAddress);
      const bondCustodian = this.requireIdentityVerifier("bondCustodian");
      const investorList = new InvestorList(ctx.group, ctx.investorListAddress);
      const addr = await this.sdk.getVerifiers(requireLookup(lookup, "lookup"))[0].address();
      const isRegistered = ((await investorList.call({ from: bondCustodian.lookup, function: "isRegistered", data: { addr } }))["0"] as boolean) === true;
      if (isRegistered === wantRegistered) return;
      const fn = wantRegistered ? "addInvestor" : "removeInvestor";
      const receipt = await this.submitIdempotent(
        () => Promise.resolve(investorList.sendTransaction({ from: bondCustodian.lookup, function: fn, data: { addr } }, { idempotencyKey }).id),
        idempotencyKey
      );
      if (!receipt?.success) throw new PaladinClientError("PD_CLIENT_INVESTOR_LIST_TX_FAILED", `${fn} failed: ${receipt?.failureMessage ?? "no receipt"}`);
    } catch (err) {
      throw toPaladinClientError(err);
    }
  }


  // ---------------------------------------------------------------------------
  // Phase-3 helpers
  // ---------------------------------------------------------------------------

  // PD_CLIENT_WRONG_ROLE, early (architecture review, 2026-10-05): a Paladin identity can only
  // ever sign from its OWN node (`localName@nodeId`'s node suffix must match the node the
  // submitting client is connected to -- confirmed task #6b's own crash-loop incident, where a
  // mismatched identity retried forever server-side instead of failing fast). BI's own client
  // legitimately signs as BOTH bondIssuer and bondCustodian across different calls (e.g.
  // issueSeries) -- they're both node1 identities on BI's own client -- so the check here is
  // "is the TARGET identity on the SAME node this client is connected to", not "does the
  // target identity literally equal this client's own identity" (which would incorrectly
  // block that legitimate dual-role usage). An investor's client (a different node) now fails
  // immediately, client-side, with a clear message, instead of a confusing Paladin-level
  // rejection (or worse, a server-side retry loop) several steps later.
  // Pure config read, no node-ownership assumption -- for callers that only need the
  // configured LOOKUP STRING for comparison/querying (e.g. ensureInvestorCustodianGroup's
  // investor-side branch, which never signs as bondCustodian, just compares/queries by its
  // lookup) and would otherwise be wrongly blocked by requireIdentityVerifier's same-node
  // signing assertion below (live-proof finding, 2026-10-05: an investor's own client,
  // connected to a different node than bondCustodian, legitimately needs this).
  private configuredIdentityLookup(key: "bondIssuer" | "bondCustodian" | "cashIssuer"): string {
    const lookup = this.config.identities?.[key];
    if (!lookup) throw new PaladinClientError("PD_CLIENT_MISSING_CONFIG", `config.identities.${key} is not set`);
    return lookup;
  }

  private requireIdentityVerifier(key: "bondIssuer" | "bondCustodian" | "cashIssuer"): PaladinVerifier {
    const lookup = this.configuredIdentityLookup(key);
    const targetNode = lookup.split("@")[1];
    if (targetNode && targetNode !== this.config.nodeId) {
      throw new PaladinClientError(
        "PD_CLIENT_WRONG_ROLE",
        `cannot sign as ${key} ("${lookup}") from this client -- that identity lives on node "${targetNode}", this client is connected to "${this.config.nodeId}" (a Paladin identity can only ever sign from its own node)`
      );
    }
    return this.sdk.getVerifiers(lookup)[0];
  }

  private requireRegistryAddress(): string {
    const addr = this.config.identities?.registryAddress;
    if (!addr) throw new PaladinClientError("PD_CLIENT_MISSING_CONFIG", "config.identities.registryAddress is not set");
    return addr;
  }

  // 0.6.5 (task #25, real incident): bond-leg recipients must be on the series' InvestorList
  // BEFORE a lock is even created -- same rule BondTracker's own _checkTransfer enforces
  // on-chain (D20's `to == _custodian` exemption), checked here so a bad recipient never
  // creates an orphaned lock in the first place. Cash legs have no InvestorList at all --
  // `seriesContexts` only has entries for bond tokens this client issued/resumed (populated by
  // issueSeries/resumeSeries), so a token with no cached SeriesContext is treated as "not a
  // whitelisted asset" and skipped, same as today's behavior (no regression for cash legs, and
  // no false rejection for a bond leg this particular client process simply hasn't loaded).
  private async checkInvestorWhitelistForLock(tokenAddress: string, recipientAddress: string): Promise<void> {
    const ctx = this.seriesContexts.get(tokenAddress.toLowerCase());
    if (!ctx) return;
    const bondCustodianLookup = this.configuredIdentityLookup("bondCustodian");
    const bondCustodianAddress = await this.sdk.getVerifiers(requireLookup(bondCustodianLookup, "bondCustodian"))[0].address();
    if (recipientAddress.toLowerCase() === bondCustodianAddress.toLowerCase()) return;
    const investorList = new InvestorList(ctx.group, ctx.investorListAddress);
    const isRegistered = ((await investorList.call({ from: bondCustodianLookup, function: "isRegistered", data: { addr: recipientAddress } }))["0"] as boolean) === true;
    if (!isRegistered) {
      throw new PaladinClientError(
        "PD_CLIENT_INVESTOR_NOT_REGISTERED",
        `recipient ${recipientAddress} is not registered on the InvestorList for ${tokenAddress} -- no lock created`
      );
    }
  }

  private requireSeriesContext(token: string): SeriesContext {
    const ctx = this.seriesContexts.get(token.toLowerCase());
    if (!ctx) throw new PaladinClientError("PD_CLIENT_UNKNOWN_SERIES", `no series context for ${token} in this client instance -- call issueSeries (if this identity issued it) or resumeSeries (if BI's backend persisted its groupId/privateTracker) first; this cache is in-memory only, see SeriesContext's doc comment`);
    return ctx;
  }

  // D1 (architecture review, 2026-10-05): the primary flow now settles through Agreement +
  // RestrictedAtom, same as outright -- BondSubscription, the upstream Atom/AtomFactory and
  // getOrDeployAtomFactory are removed from the platform path entirely (C1: the upstream
  // Atom's cancel() has no access control, so a griefer could strand both legs forever once
  // delegated). This group is now purely an Agreement host -- callers pass its id to
  // deployAgreement/resumeAgreement, propose/accept/recordLeg/recordAtom exactly as outright
  // does, just with productType "PRIMARY" and 2 legs (investor's cash, custodian's bond).
  private async getOrCreateInvestorCustodianGroup(): Promise<PentePrivacyGroup> {
    if (!this.investorCustodianGroup) {
      this.investorCustodianGroup = (async () => {
        const configuredId = this.config.identities?.investorCustodianGroupId;
        if (configuredId) {
          const resumed = await new PenteFactory(this.sdk, "pente").resumePrivacyGroup({ id: configuredId });
          if (resumed) return resumed;
          // D8's same "throw, don't silently create a different group" rule applies here too.
          throw new PaladinClientError("PD_CLIENT_GROUP_NOT_FOUND", `config.identities.investorCustodianGroupId (${configuredId}) could not be resumed`);
        }
        // Lenient lookup (not requireIdentityVerifier): this client lists bondCustodian as a
        // GROUP MEMBER, never signs AS it here -- the same cross-node false-reject this
        // method's sibling ensureInvestorCustodianGroup hit live (2026-10-05) applies equally
        // when an investor's own client (a different node than bondCustodian) calls this for
        // its own primary group.
        const [bondCustodian] = this.sdk.getVerifiers(this.configuredIdentityLookup("bondCustodian"));
        const group = await new PenteFactory(this.sdk, "pente")
          .newPrivacyGroup({ members: [this.verifier, bondCustodian], evmVersion: "shanghai", externalCallsEnabled: true })
          .waitForDeploy(DEFAULT_POLL_TIMEOUT);
        if (!group) throw new PaladinClientError("PD_CLIENT_ENSURE_PRIMARY_GROUP_FAILED", "investor+custodian group deploy failed");
        return group;
      })();
    }
    return this.investorCustodianGroup;
  }

  private async deployPublicContract(
    from: PaladinVerifier,
    artifact: { abi: any; bytecode: { object: string } },
    data: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<string> {
    const receipt = await this.submitIdempotent(
      () =>
        this.sdk.ptx.sendTransaction({
          type: TransactionType.PUBLIC,
          abi: artifact.abi,
          bytecode: artifact.bytecode.object,
          function: "",
          from: from.lookup,
          data,
          idempotencyKey,
        }),
      idempotencyKey
    );
    if (!receipt?.contractAddress) throw new PaladinClientError("PD_CLIENT_ISSUE_SERIES_FAILED", "public contract deploy failed");
    return receipt.contractAddress;
  }
}

const SERIES_STATUS = ["ACTIVE", "MATURED", "REDEEMED", "SUSPENDED"] as const;
// Matches RestrictedAtom.sol's enum Status { Pending, Executed, Cancelled } exactly.
const RESTRICTED_ATOM_STATUS = ["Pending", "Executed", "Cancelled"] as const;
const DISTRIBUTION_STATUS = [
  "INITIALIZED",
  "ISSUED",
  "DISTRIBUTION_STARTED",
  "DISTRIBUTION_COMPLETE",
  "DISTRIBUTION_CLOSED",
  "ACTIVE",
] as const;

export async function connect(config: PaladinClientConfig): Promise<PaladinClient> {
  const sdk = new PaladinClientSdk({
    url: config.nodeUrl,
    // 0.6.4 (real incident): always set a request timeout, auth or not -- an axios instance with
    // no timeout lets a single stalled HTTP call hang forever (see withReceiptDeadline in
    // errors.ts for the other half of this fix).
    requestConfig: { timeout: 30000, ...(config.rpcAuth ? { auth: { username: config.rpcAuth.username, password: config.rpcAuth.password } } : {}) },
  });
  let verifier: PaladinVerifier;
  try {
    [verifier] = sdk.getVerifiers(`${config.identity}@${config.nodeId}`);
  } catch (err) {
    throw toPaladinClientError(err);
  }
  return new PaladinClientImpl(sdk, verifier, config);
}

// Config seam fix (lead decision, 2026-10-05): single source of truth for what a
// PaladinClientConfig needs to actually work, since the backend's own real.ts had drifted
// from what client.ts really reads (task #8/#9 finding -- real.ts put everything under
// `contractData`, but client.ts reads the registry/BI identity from `identities`, a
// different field). The backend should call ONLY `loadClientConfigFile` -- never build or
// map this shape itself again.
//
// Required fields below are exactly the ones confirmed by reading every
// `this.config.identities?.X` / `this.config.contractData?.X` call site in this file, not a
// guess: `identities.registryAddress` (requireRegistryAddress -- used by getSeries, which
// BOTH BI's own calls and every investor-initiated phase-3 method route through) and
// `identities.bondCustodian` (requireIdentityVerifier("bondCustodian") -- used by nearly
// every phase-3/task-8 method, BI and investor alike) and `contractData.
// restrictedAtomFactoryAddress` (createAtom/task #8's Agreement flow -- D1, 2026-10-05:
// deployed ONCE by the bootstrap, never by a client at runtime; getOrDeployRestrictedAtomFactory
// is now a plain getter that throws PD_CLIENT_MISSING_CONFIG if this is absent, not a
// lazy-deploy). Deliberately NOT required, since the code itself treats them as optional:
// `identities.bondIssuer` (BI-only, primary issuance), `identities.investorCustodianGroupId`
// (lazily created by getOrCreateInvestorCustodianGroup if absent).
const REQUIRED_CLIENT_CONFIG_FIELDS: { path: string; get: (cfg: PaladinClientConfig) => unknown }[] = [
  { path: "nodeId", get: (cfg) => cfg.nodeId },
  { path: "identity", get: (cfg) => cfg.identity },
  { path: "identities.registryAddress", get: (cfg) => cfg.identities?.registryAddress },
  { path: "identities.bondCustodian", get: (cfg) => cfg.identities?.bondCustodian },
  { path: "contractData.restrictedAtomFactoryAddress", get: (cfg) => cfg.contractData?.restrictedAtomFactoryAddress },
];
export function validateClientConfig(cfg: PaladinClientConfig): void {
  for (const field of REQUIRED_CLIENT_CONFIG_FIELDS) {
    const value = field.get(cfg);
    if (value === undefined || value === null || value === "") {
      throw new PaladinClientError("PD_CLIENT_MISSING_CONFIG", `client config is missing required field: ${field.path}`);
    }
  }
}

// Reads a contract-data file (the shape Paladin/scripts/bootstrap-platform.ts writes --
// PaladinClientConfig minus nodeUrl/wsUrl/rpcAuth, which only ever come from env/runtime, never
// a static file) and merges in the connection-specific pieces the caller supplies, validating
// BEFORE returning so a broken config fails fast and clearly instead of surfacing as a
// confusing error from deep inside some later method call.
export function loadClientConfigFile(filePath: string, connection: { nodeUrl: string; wsUrl?: string; rpcAuth?: { username: string; password: string } }): PaladinClientConfig {
  let fileConfig: Partial<PaladinClientConfig>;
  try {
    fileConfig = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new PaladinClientError("PD_CLIENT_MISSING_CONFIG", `could not read or parse client config file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const cfg: PaladinClientConfig = { ...fileConfig, ...connection } as PaladinClientConfig;
  validateClientConfig(cfg);
  return cfg;
}

// Reads PALADIN_RPC_USERNAME/PALADIN_RPC_PASSWORD from the given env map (defaults to
// process.env). Returns undefined if either is unset -- matches today's live-cluster state
// (no rpcAuth secret deployed), so a backend started without them connects unauthenticated,
// the same way every spike and the centralized bond/swap-noto flows already do.
export function credentialsFromEnv(env: Record<string, string | undefined> = process.env) {
  const username = env.PALADIN_RPC_USERNAME;
  const password = env.PALADIN_RPC_PASSWORD;
  if (!username || !password) return undefined;
  return { username, password };
}
