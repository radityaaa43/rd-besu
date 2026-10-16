export * from "./types";
export * from "./errors";
// findReceiptByIdempotencyKey (client.ts:705): NOTE for external callers (lead-approved,
// 2026-10-08) -- when a transaction EXISTS for the key but its receipt is not yet available
// within waitMs, this throws PD_CLIENT_RECEIPT_TIMEOUT (retryable, carries the txId); it
// returns undefined ONLY when no transaction exists for the key at all. Treat the throw as
// "still pending", not as a failure.
export { connect, credentialsFromEnv, loadClientConfigFile, validateClientConfig, findReceiptByIdempotencyKey } from "./client";
