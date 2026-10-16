/*
 * Typed error so the backend can map a failure to an HTTP status without string-matching
 * Paladin's own error messages itself.
 */

export class PaladinClientError extends Error {
  readonly code: string;
  readonly cause?: unknown;
  /** True only for PD_CLIENT_RECEIPT_TIMEOUT -- the backend's signal that retrying (not
   * failing the trade) is the right response; see that error's own doc comment below. */
  readonly retryable?: boolean;
  /** Set only for PD_CLIENT_RECEIPT_TIMEOUT -- the transaction id to poll/retry against, so the
   * backend doesn't have to re-derive it from the original request. */
  readonly txId?: string;
  /** 0.6.5: set only on a prepareTradeLeg failure after lockToken already succeeded -- the
   * lock that was created, so the caller can recover it even if the compensating release
   * (see lockReleased) itself failed. */
  readonly lockId?: string;
  /** 0.6.5: true only when a compensating releaseLock (back to the lock's own owner) ran and
   * got a success receipt. false means the lock named in `lockId` is still held and needs
   * manual recovery -- store it, don't silently drop it. Undefined for any error unrelated to
   * this path. */
  readonly lockReleased?: boolean;
  /** 0.6.5: the Noto token address the lock in `lockId` lives on, so the caller doesn't have
   * to re-derive it from the original request. */
  readonly tokenAddress?: string;

  constructor(code: string, message: string, cause?: unknown, retryable?: boolean, txId?: string, lockId?: string, lockReleased?: boolean, tokenAddress?: string) {
    super(message);
    this.name = "PaladinClientError";
    this.code = code;
    this.cause = cause;
    this.retryable = retryable;
    this.txId = txId;
    this.lockId = lockId;
    this.lockReleased = lockReleased;
    this.tokenAddress = tokenAddress;
  }
}

/*
 * D-series architecture review item (2026-10-05): a receipt POLL TIMING OUT (no receipt ever
 * appeared within the poll window) is NOT the same condition as the transaction actually
 * FAILING on-chain (a receipt with `success: false`) -- confirmed from the SDK's own
 * `pollForReceipt` (paladin.js:563-575): it returns `undefined` on timeout specifically,
 * distinct from a real failed receipt, which it returns immediately. Before this fix, every
 * caller collapsed both into the same generic "<method> failed: no receipt" error, so the
 * backend had no way to tell "this probably still landed, poll again" from "this genuinely
 * reverted, don't retry blindly" -- confirmed by reading every submitIdempotent call site.
 * `retryable: true` and `txId` let the backend make that call itself.
 */
export const PD_CLIENT_RECEIPT_TIMEOUT = "PD_CLIENT_RECEIPT_TIMEOUT";
export function receiptTimeoutError(method: string, txId: string): PaladinClientError {
  return new PaladinClientError(PD_CLIENT_RECEIPT_TIMEOUT, `${method}: no receipt for ${txId} within the poll window -- the transaction may still be pending; retry (same idempotencyKey) rather than treating this as a failure`, undefined, true, txId);
}

// 0.6.4 (real incident): the SDK's own pollForReceipt loops on a counter, not Date.now() -- if
// a single underlying HTTP call hangs, it blocks forever regardless of its own waitMs argument,
// confirmed from a real 3.5-minute hang in production. This wraps ANY receipt-wait promise with
// a REAL wall-clock deadline via Promise.race, so our own code can never hang past waitMs even
// if the SDK call underneath never resolves. Does not fix the SDK itself (out of scope, see
// BACKLOG.md) -- this is a defensive outer bound around it.
export function withReceiptDeadline<T>(promise: Promise<T>, waitMs: number, method: string, txId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(receiptTimeoutError(method, txId)), waitMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Paladin's own JSON-RPC errors are consistently prefixed "PDxxxxxx: <message>" (seen live this
// session, e.g. "PD012220: idempotencyKey already used...", "PD210100: failed to calculate the
// witness", "PD011206: DOMAIN pente returned error..."). This parses that prefix out when
// present. A network-level failure (ECONNREFUSED, a timeout) never reaches Paladin's own error
// formatting at all, so it falls back to a generic client-side code instead of guessing one.
const PD_CODE = /^(PD\d{6})(?::\s*)?(.*)$/s;

export function toPaladinClientError(err: unknown): PaladinClientError {
  // Pass through unchanged -- without this, every method that wraps its own throw in a
  // try/catch calling toPaladinClientError(err) (nearly all of them) would clobber a custom
  // code (PD_CLIENT_LOCK_OWNER_MISMATCH, PD_CLIENT_UNKNOWN_SERIES, PD_CLIENT_MISSING_CONFIG,
  // etc.) back down to PD_CLIENT_UNKNOWN, since those messages are plain English, not Paladin's
  // own "PDxxxxxx: ..." format. Found live (task #5): the 0.2.1 ownership guard's own
  // PD_CLIENT_LOCK_OWNER_MISMATCH was silently turned into PD_CLIENT_UNKNOWN by delegateLock's
  // own catch block before this fix.
  if (err instanceof PaladinClientError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const match = PD_CODE.exec(raw);
  if (match) {
    return new PaladinClientError(match[1], match[2] || raw, err);
  }
  return new PaladinClientError("PD_CLIENT_UNKNOWN", raw, err);
}

// 0.6.1 (backend report, task #22): a failed receipt's `failureMessage` carries Paladin's own
// stable PD code too (e.g. "PD200005: Insufficient funds (available=1000)") -- a caller that
// needs to distinguish "insufficient funds" from "any other failure" (to map to a specific HTTP
// status, say) had no way to do that from `.code` alone, since every submit method's own
// `if (!receipt?.success) throw ...` used ONE fixed fallback code regardless of the real
// underlying reason. Surfaces the real PD code as `.code` when the message has one, falling
// back to the caller's own method-specific code only when it doesn't (a timeout or a receipt
// that's simply missing, not a domain-level revert).
export function receiptFailureError(method: string, fallbackCode: string, receipt: { success?: boolean; failureMessage?: string } | undefined): PaladinClientError {
  const raw = receipt?.failureMessage ?? "no receipt";
  const match = PD_CODE.exec(raw);
  if (match) return new PaladinClientError(match[1], match[2] || raw);
  return new PaladinClientError(fallbackCode, `${method} failed: ${raw}`);
}

export const PD_CLIENT_INVESTOR_NOT_REGISTERED = "PD_CLIENT_INVESTOR_NOT_REGISTERED";

/*
 * 0.6.5 (task #25, real incident): 3 bond-leg prepareTradeLeg calls succeeded at lockToken
 * then reverted at prepareUnlock with "Investor is not registered" -- 3 orphaned locks, no
 * lockId recorded anywhere the backend could find without a direct DB query. checkInvestorWhitelistForLock
 * (client.ts) now runs this same InvestorList check BEFORE lockToken, so a bad recipient fails
 * with no lock created at all (throws PD_CLIENT_INVESTOR_NOT_REGISTERED, no lockId). If
 * prepareUnlock still fails AFTER lockToken succeeded for any OTHER reason, this error carries
 * the lock back to the caller with a best-effort compensating release already attempted, so
 * the backend never has to go find an orphan by hand again.
 *
 * Retry note: do NOT retry a failed prepareTradeLeg with the SAME idempotencyKey after a
 * compensating release ran (lockReleased: true). Paladin's idempotency (PD012220) resolves a
 * reused key back to the ORIGINAL lockToken's result, not a fresh lock -- a retry with the same
 * key would try to operate on the lock that was just released. Use a NEW idempotencyKey for
 * the retry.
 */
export function lockRecoveryError(code: string, message: string, cause: unknown, lockId: string, lockReleased: boolean, tokenAddress: string): PaladinClientError {
  return new PaladinClientError(code, message, cause, undefined, undefined, lockId, lockReleased, tokenAddress);
}

// Task #4b: a listener name already existed (so createListenerIdempotent swallowed the
// duplicate-name error), but its actual source/filters (address, event signature, group id)
// don't match what this call just asked for -- the backend would otherwise silently attach to
// the WRONG source under a name it thinks is its own. Always a logic error in the caller (reused
// a listener name across two different purposes), never a transient Paladin-side condition --
// map to 500/422, not 502.
export const PD_LISTENER_CONFIG_MISMATCH = "PD_LISTENER_CONFIG_MISMATCH";

/*
 * HTTP-status mapping guidance for the backend (not exhaustive -- Paladin's full PDxxxxx
 * catalog was not enumerated; these are the codes actually observed live this session):
 * - PD_CLIENT_UNKNOWN / network errors (ECONNREFUSED, timeout): 502 -- Paladin node unreachable.
 * - PD012220 (idempotency key conflict): 422 (lead ruling 2026-10-08, matching the REST doc's
 *   PALADIN_REJECTED row) -- the node really rejected the submission, so it is a rejection, not
 *   a conflict the caller can resolve by re-reading. The backend's own retry path should still
 *   recognize this BEFORE it reaches here (look up the stored response by idempotency key
 *   first); any client-internal replay handling stays internal and must never surface as a
 *   status for a node-level rejection.
 * - A validation-shaped PDxxxxx (bad amount, unknown account, notary mismatch, etc.): 422.
 * - PD210100 (witness/wedged transaction) should never surface synchronously to an HTTP caller
 *   -- it only shows up in node logs well after the triggering call returned. Not a mapping
 *   case; flagged here only so nobody is surprised if they later see the code in a log search.
 */
