import { describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { createListenerIdempotent, dispatchBatch, eventSignatureOf, mismatch, verifyLockOwner, verifyDelegatedLeg, verifyCancelCall, isLockDelegated, isLockPrepared, readDistributionAddress, requireLookup, resolveIdempotentFuture, sendGroupMessage, validateClientConfig, loadClientConfigFile, toFixedBytes, fromFixedBytes, toUnixSeconds, fromUnixSeconds, toBytes32Hash, encodeSeriesFields, agreementCacheKey, toGroupMessage, normAddr, requireLegOwner, requireLegRecipientMatch, findReceiptByIdempotencyKey, decodePrepareUnlockReceipt, requireCashToken, isZeroHex, detectPublicTrackerSchema, readLegacyDistributionState, readStatusOnlyDistributionState, statusOnlyPrice } from "../src/client";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PaladinClientConfig, SeriesRegistrationParams } from "../src/types";
import { TRANSIENT_VERIFY_CODES } from "../src/types";
import { PaladinClientError, toPaladinClientError, receiptTimeoutError, receiptFailureError, withReceiptDeadline, lockRecoveryError, PD_CLIENT_INVESTOR_NOT_REGISTERED } from "../src/errors";
import INotoAbi from "../src/abis/INoto.json";

// Covers the lead's two required cases for task #4: ack only after the handler's promise
// resolves, and a handler error produces no ack (so Paladin redelivers the batch) instead of
// a partial/silent ack.

describe("dispatchBatch", () => {
  it("acks only after the handler's promise resolves", async () => {
    const sender = { ack: vi.fn(), nack: vi.fn() };
    let resolveHandler: () => void;
    const handlerPromise = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    const done = dispatchBatch(sender, "sub-1", () => handlerPromise);

    // Handler hasn't resolved yet -- must not have acked.
    await Promise.resolve();
    expect(sender.ack).not.toHaveBeenCalled();
    expect(sender.nack).not.toHaveBeenCalled();

    resolveHandler!();
    await done;

    expect(sender.ack).toHaveBeenCalledOnce();
    expect(sender.ack).toHaveBeenCalledWith("sub-1");
    expect(sender.nack).not.toHaveBeenCalled();
  });

  it("acks in order: handler resolution happens before ack, not interleaved", async () => {
    const order: string[] = [];
    const sender = {
      ack: vi.fn(() => order.push("ack")),
      nack: vi.fn(() => order.push("nack")),
    };

    await dispatchBatch(sender, "sub-1", async () => {
      order.push("handler-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("handler-end");
    });

    expect(order).toEqual(["handler-start", "handler-end", "ack"]);
  });

  it("a handler error produces no ack and nacks the batch instead (redelivery)", async () => {
    const sender = { ack: vi.fn(), nack: vi.fn() };
    const onError = vi.fn();

    await dispatchBatch(
      sender,
      "sub-2",
      () => Promise.reject(new Error("boom")),
      onError
    );

    expect(sender.ack).not.toHaveBeenCalled();
    expect(sender.nack).toHaveBeenCalledOnce();
    expect(sender.nack).toHaveBeenCalledWith("sub-2");
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0][0] as Error).message).toBe("boom");
  });

  it("a thrown (not rejected) handler also nacks, not acks", async () => {
    const sender = { ack: vi.fn(), nack: vi.fn() };

    await dispatchBatch(sender, "sub-3", () => {
      throw new Error("sync boom");
    });

    expect(sender.ack).not.toHaveBeenCalled();
    expect(sender.nack).toHaveBeenCalledOnce();
    expect(sender.nack).toHaveBeenCalledWith("sub-3");
  });

  it("never calls both ack and nack for the same batch", async () => {
    const sender = { ack: vi.fn(), nack: vi.fn() };
    await dispatchBatch(sender, "sub-4", () => Promise.resolve());
    await dispatchBatch(sender, "sub-5", () => Promise.reject(new Error("x")));

    expect(sender.ack).toHaveBeenCalledOnce();
    expect(sender.nack).toHaveBeenCalledOnce();
    // and never both for the SAME subscription
    expect(sender.ack).not.toHaveBeenCalledWith("sub-5");
    expect(sender.nack).not.toHaveBeenCalledWith("sub-4");
  });
});

// Task #4b (lead review): createListenerIdempotent must not silently accept a duplicate name
// whose actual source/filters differ from what was just requested.
describe("createListenerIdempotent", () => {
  const duplicateError = () => {
    const err = new Error("PD012246: A blockchain event listener named 'x' already exists");
    return err;
  };

  it("succeeds without calling verifyExisting when create() succeeds (no duplicate)", async () => {
    const verifyExisting = vi.fn();
    await createListenerIdempotent("PD012246", () => Promise.resolve(), verifyExisting);
    expect(verifyExisting).not.toHaveBeenCalled();
  });

  it("on a duplicate-name error, calls verifyExisting and succeeds if it resolves (config matches)", async () => {
    const verifyExisting = vi.fn().mockResolvedValue(undefined);
    await createListenerIdempotent("PD012246", () => Promise.reject(duplicateError()), verifyExisting);
    expect(verifyExisting).toHaveBeenCalledOnce();
  });

  it("on a duplicate-name error, propagates the PD_LISTENER_CONFIG_MISMATCH verifyExisting throws (config differs)", async () => {
    const verifyExisting = async () => {
      mismatch("my-listener", "blockchain event", "existing address=0xA, requested address=0xB");
    };
    await expect(createListenerIdempotent("PD012246", () => Promise.reject(duplicateError()), verifyExisting)).rejects.toMatchObject({
      code: "PD_LISTENER_CONFIG_MISMATCH",
    });
  });

  it("propagates a non-duplicate error without ever calling verifyExisting", async () => {
    const verifyExisting = vi.fn();
    const otherError = new Error("PD012220: idempotencyKey already used by submitted transaction x");
    await expect(createListenerIdempotent("PD012246", () => Promise.reject(otherError), verifyExisting)).rejects.toMatchObject({
      code: "PD012220",
    });
    expect(verifyExisting).not.toHaveBeenCalled();
  });

  it("mismatch() always throws PaladinClientError with the expected code and a readable message", () => {
    expect(() => mismatch("n", "receipt", "detail here")).toThrowError(PaladinClientError);
    try {
      mismatch("n", "receipt", "detail here");
    } catch (err) {
      expect((err as PaladinClientError).code).toBe("PD_LISTENER_CONFIG_MISMATCH");
      expect((err as PaladinClientError).message).toContain("detail here");
    }
  });
});

// Task #4b resume-test caught a live false positive: Paladin's own getBlockchainEventListener
// echoes an ABI fragment back with a different key order and an extra `outputs: null`, so the
// mismatch check must compare semantic identity (name + input types), not raw JSON equality.
describe("eventSignatureOf", () => {
  it("treats differently-ordered/shaped but semantically identical fragments as equal", () => {
    const requested = { type: "event", anonymous: false, name: "AtomDeployed", inputs: [{ type: "address", name: "addr" }] };
    const echoedBack = { type: "event", name: "AtomDeployed", inputs: [{ name: "addr", type: "address" }], outputs: null };
    expect(eventSignatureOf(requested)).toBe(eventSignatureOf(echoedBack));
  });

  it("ignores parameter names -- only types affect on-chain event identity", () => {
    const a = { name: "AtomDeployed", inputs: [{ type: "address", name: "addr" }] };
    const b = { name: "AtomDeployed", inputs: [{ type: "address", name: "somethingElse" }] };
    expect(eventSignatureOf(a)).toBe(eventSignatureOf(b));
  });

  it("still distinguishes genuinely different events", () => {
    const a = { name: "AtomDeployed", inputs: [{ type: "address", name: "addr" }] };
    const b = { name: "AtomDeployed", inputs: [{ type: "address" }, { type: "uint256" }] };
    const c = { name: "SomethingElse", inputs: [{ type: "address", name: "addr" }] };
    expect(eventSignatureOf(a)).not.toBe(eventSignatureOf(b));
    expect(eventSignatureOf(a)).not.toBe(eventSignatureOf(c));
  });
});

// Task #6b incident: a delegateLock/prepareUnlock submitted by an identity that doesn't
// actually own the lock gets stuck server-side (PD200018, endorsement retried forever) instead
// of failing outright -- confirmed live, it crash-looped node1's pod. This guard must catch the
// mismatch client-side, before any transaction is ever submitted.
describe("verifyLockOwner", () => {
  const schemas = [{ id: "schema-1", signature: "NotoLockInfo_V1(bytes32,address,address)", definition: {} }];

  it("does not throw when the lock's owner matches the expected address", async () => {
    const sdk = {
      pstate: {
        listSchemas: vi.fn(async () => schemas),
        queryContractStates: vi.fn(async () => [{ data: { owner: "0xAAAA000000000000000000000000000000000A" } }]),
      },
    };
    await expect(
      verifyLockOwner(sdk, "noto", "0xtoken", "0xlock", "0xaaaa000000000000000000000000000000000a", "delegateLock")
    ).resolves.toBeUndefined();
  });

  it("throws PD_CLIENT_LOCK_OWNER_MISMATCH before any transaction is submitted when the owner differs", async () => {
    const sdk = {
      pstate: {
        listSchemas: vi.fn(async () => schemas),
        queryContractStates: vi.fn(async () => [{ data: { owner: "0xBBBB000000000000000000000000000000000B" } }]),
      },
    };
    await expect(
      verifyLockOwner(sdk, "noto", "0xtoken", "0xlock", "0xaaaa000000000000000000000000000000000a", "delegateLock")
    ).rejects.toMatchObject({ code: "PD_CLIENT_LOCK_OWNER_MISMATCH" });
  });

  it("throws PD_CLIENT_LOCK_NOT_FOUND when no lock state matches the lockId", async () => {
    const sdk = {
      pstate: {
        listSchemas: vi.fn(async () => schemas),
        queryContractStates: vi.fn(async () => []),
      },
    };
    await expect(
      verifyLockOwner(sdk, "noto", "0xtoken", "0xlock", "0xaaaa000000000000000000000000000000000a", "delegateLock")
    ).rejects.toMatchObject({ code: "PD_CLIENT_LOCK_NOT_FOUND" });
  });

  it("throws PD_CLIENT_LOCK_OWNER_CHECK_FAILED when the NotoLockInfo_V1 schema isn't found", async () => {
    const sdk = {
      pstate: {
        listSchemas: vi.fn(async () => []),
        queryContractStates: vi.fn(),
      },
    };
    await expect(
      verifyLockOwner(sdk, "noto", "0xtoken", "0xlock", "0xaaaa000000000000000000000000000000000a", "delegateLock")
    ).rejects.toMatchObject({ code: "PD_CLIENT_LOCK_OWNER_CHECK_FAILED" });
    expect(sdk.pstate.queryContractStates).not.toHaveBeenCalled();
  });
});

// Found live (task #5 binding spike): delegateLock's own `catch (err) { throw
// toPaladinClientError(err); }` was silently turning verifyLockOwner's PD_CLIENT_LOCK_OWNER_MISMATCH
// into PD_CLIENT_UNKNOWN, because the old implementation only recognized Paladin's own raw
// "PDxxxxxx: message" string format, not an already-constructed PaladinClientError.
describe("toPaladinClientError", () => {
  it("passes an already-constructed PaladinClientError through unchanged, preserving its code", () => {
    const original = new PaladinClientError("PD_CLIENT_LOCK_OWNER_MISMATCH", "lock 0xabc is owned by someone else");
    const result = toPaladinClientError(original);
    expect(result).toBe(original);
    expect(result.code).toBe("PD_CLIENT_LOCK_OWNER_MISMATCH");
  });

  it("still parses a raw Paladin RPC-style error for a plain Error", () => {
    const result = toPaladinClientError(new Error("PD012220: idempotencyKey already used"));
    expect(result.code).toBe("PD012220");
    expect(result.message).toBe("idempotencyKey already used");
  });

  it("falls back to PD_CLIENT_UNKNOWN only for a genuinely unrecognized error", () => {
    const result = toPaladinClientError(new Error("socket hang up"));
    expect(result.code).toBe("PD_CLIENT_UNKNOWN");
  });
});

// Task #5b -> #6c productization: verifyDelegatedLeg is the only safe way to trust an
// unlockCall a counterparty hands over before building/executing an Atom around it. Fixtures
// use REAL ABI encoding (ethers), not stubbed strings, so the decode paths are genuinely
// exercised, not just the surrounding control flow.
describe("verifyDelegatedLeg", () => {
  // Real 40-hex-char addresses (not the shorter look-alikes used elsewhere in this file for
  // opaque ids) -- these feed resolveToAddress's RAW_ADDRESS_RE check (0.3.1 lookup-or-address
  // fix), which requires exactly 40 hex chars to short-circuit past getVerifiers.
  const RECIPIENT = "0x" + "a".repeat(40);
  const OWNER = "0x" + "b".repeat(40);
  const SPENDER = "0x" + "c".repeat(40);
  const LOCK_ID = "0x" + "11".repeat(32);
  const OTHER_LOCK_ID = "0x" + "99".repeat(32);
  const OUT_TO_RECIPIENT = "0x" + "22".repeat(32);
  const OUT_CHANGE_TO_OWNER = "0x" + "33".repeat(32);
  const OUT_TO_THIRD_PARTY = "0x" + "44".repeat(32);
  const THIRD_PARTY = "0x" + "d".repeat(40);

  function buildUnlockCall(lockId: string, outputs: string[]): string {
    const spendArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes32 txId, bytes32[] inputs, bytes32[] outputs, bytes data, bytes proof)"],
      [{ txId: "0x" + "00".repeat(32), inputs: [], outputs, data: "0x", proof: "0x" }]
    );
    return new ethers.Interface(INotoAbi.abi).encodeFunctionData("spendLock", [lockId, spendArgs, "0x"]);
  }

  const LOOKUP_TO_ADDRESS: Record<string, string> = { "recipient@node2": RECIPIENT, "owner@node1": OWNER };

  // D7 (architecture review, 2026-10-05): verifyDelegatedLeg needs `atomAddress` for the
  // spender==atomAddress check via getLock. The originally-planned second ptx.call (a
  // simulated spendLock as the atom) was REMOVED after a live-proof finding confirmed
  // Paladin's ptx.call can't spoof an arbitrary `from` (see client.ts's own comment on this)
  // -- so the mock only ever needs to answer "getLock" now.
  function mockSdk(
    opts: {
      spender?: string;
      coinStates?: { id: string; data: { owner: string; amount: string } }[];
    } = {}
  ) {
    const spender = opts.spender ?? SPENDER;
    const coinStates = opts.coinStates ?? [
      { id: OUT_TO_RECIPIENT, data: { owner: RECIPIENT, amount: "70" } },
      { id: OUT_CHANGE_TO_OWNER, data: { owner: OWNER, amount: "30" } },
    ];
    return {
      ptx: {
        call: vi.fn(async (tx: { function: string }) => {
          if (tx.function === "getLock") {
            return { info: { owner: OWNER, spender, spendCommitment: "0x", cancelCommitment: "0x" } };
          }
          throw new Error(`mockSdk: unexpected ptx.call function "${tx.function}"`);
        }),
      },
      pstate: {
        listSchemas: vi.fn(async () => [{ id: "coin-schema", signature: "NotoCoin(bytes32,address,uint256)", definition: {} }]),
        // verifyDelegatedLeg now queries unfiltered ({}) so it can tell STATE_NOT_FOUND
        // (absent from this node's view entirely) apart from FOREIGN_OUTPUT (present, wrong
        // owner) -- the mock just returns every coinState regardless of the query argument.
        queryContractStates: vi.fn(async () => coinStates),
      },
      // 0.3.1 lookup-or-address fix: resolveToAddress calls this for any non-address value.
      getVerifiers: vi.fn((lookup: string) => [{ address: async () => LOOKUP_TO_ADDRESS[lookup] }]),
    };
  }

  // Lead requirement (2026-10-05): spender == owner means genuinely not delegated yet --
  // TRANSIENT (may still be in flight), distinct from "delegated to the wrong atom".
  it("rejects with code NOT_DELEGATED when the lock is not delegated to anyone (spender == owner)", async () => {
    const sdk = mockSdk({ spender: OWNER });
    const unlockCall = buildUnlockCall(LOCK_ID, [OUT_TO_RECIPIENT, OUT_CHANGE_TO_OWNER]);
    const result = await verifyDelegatedLeg(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, unlockCall, { recipient: RECIPIENT, amount: "70", owner: OWNER }, SPENDER);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("NOT_DELEGATED");
    expect(TRANSIENT_VERIFY_CODES.has(result.code!)).toBe(true);
  });

  // D7: the old check only required "delegated to someone" -- a lock delegated to a DIFFERENT
  // (wrong/stale) atom used to pass. Now it must match the specific atomAddress being
  // verified, and this is DEFINITE (not a timing issue -- it's really the wrong atom).
  it("rejects with code SPENDER_NOT_ATOM when the lock is delegated to a DIFFERENT atom than expected", async () => {
    const sdk = mockSdk({ spender: "0x" + "9".repeat(40) });
    const unlockCall = buildUnlockCall(LOCK_ID, [OUT_TO_RECIPIENT, OUT_CHANGE_TO_OWNER]);
    const result = await verifyDelegatedLeg(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, unlockCall, { recipient: RECIPIENT, amount: "70", owner: OWNER }, SPENDER);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SPENDER_NOT_ATOM");
    expect(TRANSIENT_VERIFY_CODES.has(result.code!)).toBe(false);
  });

  it("accepts an honest unlockCall: delegated to the expected atom, right lockId, outputs match", async () => {
    const sdk = mockSdk();
    const unlockCall = buildUnlockCall(LOCK_ID, [OUT_TO_RECIPIENT, OUT_CHANGE_TO_OWNER]);
    const result = await verifyDelegatedLeg(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, unlockCall, { recipient: RECIPIENT, amount: "70", owner: OWNER }, SPENDER);
    expect(result.ok).toBe(true);
    expect(result.outputs).toEqual([OUT_TO_RECIPIENT.toLowerCase(), OUT_CHANGE_TO_OWNER.toLowerCase()]);
  });

  it("rejects with code LOCKID_MISMATCH when the unlockCall's embedded lockId does not match (swapped-in unrelated lock)", async () => {
    const sdk = mockSdk();
    const unlockCall = buildUnlockCall(OTHER_LOCK_ID, [OUT_TO_RECIPIENT, OUT_CHANGE_TO_OWNER]);
    const result = await verifyDelegatedLeg(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, unlockCall, { recipient: RECIPIENT, amount: "70", owner: OWNER }, SPENDER);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("LOCKID_MISMATCH");
    expect(result.reason).toContain("embedded lockId");
  });

  it("rejects with code AMOUNT_MISMATCH when the total to the recipient does not match the agreed amount (the #5b/D5 attack)", async () => {
    const sdk = mockSdk({
      coinStates: [
        { id: OUT_TO_RECIPIENT, data: { owner: RECIPIENT, amount: "40" } },
        { id: OUT_CHANGE_TO_OWNER, data: { owner: OWNER, amount: "60" } },
      ],
    });
    const unlockCall = buildUnlockCall(LOCK_ID, [OUT_TO_RECIPIENT, OUT_CHANGE_TO_OWNER]);
    const result = await verifyDelegatedLeg(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, unlockCall, { recipient: RECIPIENT, amount: "70", owner: OWNER }, SPENDER);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("AMOUNT_MISMATCH");
    expect(result.reason).toContain("total to recipient");
  });

  it("rejects with code FOREIGN_OUTPUT when an output belongs to a third party (neither recipient nor lock owner)", async () => {
    const sdk = mockSdk({
      coinStates: [
        { id: OUT_TO_RECIPIENT, data: { owner: RECIPIENT, amount: "70" } },
        { id: OUT_TO_THIRD_PARTY, data: { owner: THIRD_PARTY, amount: "30" } },
      ],
    });
    const unlockCall = buildUnlockCall(LOCK_ID, [OUT_TO_RECIPIENT, OUT_TO_THIRD_PARTY]);
    const result = await verifyDelegatedLeg(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, unlockCall, { recipient: RECIPIENT, amount: "70", owner: OWNER }, SPENDER);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("FOREIGN_OUTPUT");
    expect(TRANSIENT_VERIFY_CODES.has(result.code!)).toBe(false);
  });

  // Lead requirement (2026-10-05): an output absent from this node's view entirely (not found
  // anywhere, vs. found-but-wrong-owner above) is a propagation-timing issue -- TRANSIENT.
  it("rejects with code STATE_NOT_FOUND when an output has not propagated to this node yet", async () => {
    const sdk = mockSdk({ coinStates: [{ id: OUT_CHANGE_TO_OWNER, data: { owner: OWNER, amount: "30" } }] }); // OUT_TO_RECIPIENT missing entirely
    const unlockCall = buildUnlockCall(LOCK_ID, [OUT_TO_RECIPIENT, OUT_CHANGE_TO_OWNER]);
    const result = await verifyDelegatedLeg(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, unlockCall, { recipient: RECIPIENT, amount: "70", owner: OWNER }, SPENDER);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("STATE_NOT_FOUND");
    expect(TRANSIENT_VERIFY_CODES.has(result.code!)).toBe(true);
  });

  // 0.3.1 fix: the backend always passes LOOKUPS, not raw addresses (primaryFlow.ts/
  // outrightFlow.ts) -- this used to fail closed on every real call. A lookup must resolve to
  // the SAME address as the raw form and produce an identical result.
  it("accepts expected.recipient/owner given as LOOKUPS, resolving to the same addresses as the raw-address form", async () => {
    const sdk = mockSdk();
    const unlockCall = buildUnlockCall(LOCK_ID, [OUT_TO_RECIPIENT, OUT_CHANGE_TO_OWNER]);
    const byAddress = await verifyDelegatedLeg(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, unlockCall, { recipient: RECIPIENT, amount: "70", owner: OWNER }, SPENDER);
    const byLookup = await verifyDelegatedLeg(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, unlockCall, { recipient: "recipient@node2", amount: "70", owner: "owner@node1" }, SPENDER);
    expect(byLookup.ok).toBe(true);
    expect(byLookup).toEqual(byAddress);
  });
});

// Task #6c (releaseLock's safety guard): the OPPOSITE check from verifyDelegatedLeg's step 1 --
// releaseLock must refuse, before sending anything, if the lock turns out to already be
// delegated (recovery for that case goes through the trade atom's own cancel(), never
// releaseLock).
describe("isLockDelegated", () => {
  const OWNER = "0xaaaa000000000000000000000000000000000a";
  const DELEGATE = "0xbbbb000000000000000000000000000000000b";

  it("reports NOT delegated when spender == owner", async () => {
    const sdk = { ptx: { call: vi.fn(async () => ({ info: { owner: OWNER, spender: OWNER } })) } };
    const result = await isLockDelegated(sdk, "bi@node1", "0xtoken", "0xlock");
    expect(result.delegated).toBe(false);
  });

  it("reports delegated when spender != owner", async () => {
    const sdk = { ptx: { call: vi.fn(async () => ({ info: { owner: OWNER, spender: DELEGATE } })) } };
    const result = await isLockDelegated(sdk, "bi@node1", "0xtoken", "0xlock");
    expect(result.delegated).toBe(true);
    expect(result.spender).toBe(DELEGATE);
  });
});

// Fund-safety fix (lead-required, 2026-10-05): a raw address passed where a lookup is expected
// used to silently resolve to a different, unrelated identity via sdk.getVerifiers. Every
// caller-supplied lookup (prepareUnlock's recipients[].to, mintToken's `to`,
// createPrivacyGroup's members[], ensureOutrightGroup's bank lookups, setInvestorRegistration's
// lookup) now goes through this guard first.
describe("requireLookup", () => {
  it("passes through a real lookup unchanged", () => {
    expect(requireLookup("investor1@node2", "to")).toBe("investor1@node2");
  });

  it("throws PD_CLIENT_INVALID_RECIPIENT on a raw address", () => {
    const rawAddress = "0x" + "a".repeat(40);
    expect(() => requireLookup(rawAddress, "to")).toThrow();
    try {
      requireLookup(rawAddress, "recipients[].to");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("PD_CLIENT_INVALID_RECIPIENT");
      expect((e as Error).message).toContain("recipients[].to");
    }
  });
});

// 0.3.2 config-seam fix (lead decision): single source of truth for what a
// PaladinClientConfig needs -- the backend was drifting from what client.ts really reads
// (task #8/#9 finding: real.ts put everything under contractData, client.ts reads
// identities.registryAddress/bondCustodian from a different field entirely).
describe("validateClientConfig", () => {
  function validConfig(): PaladinClientConfig {
    return {
      nodeUrl: "http://127.0.0.1:31548",
      nodeId: "node1",
      identity: "bondCustodian",
      identities: { registryAddress: "0xregistry", bondCustodian: "bondCustodian@node1" },
      contractData: { restrictedAtomFactoryAddress: "0xatomfactory" },
    };
  }

  it("accepts a config with every required field present", () => {
    expect(() => validateClientConfig(validConfig())).not.toThrow();
  });

  it("does NOT require bondIssuer, investorCustodianGroupId, or atomFactoryAddress (all optional/lazy in the real code)", () => {
    const cfg = validConfig();
    expect(() => validateClientConfig(cfg)).not.toThrow();
    expect(cfg.identities?.bondIssuer).toBeUndefined();
    expect(cfg.identities?.investorCustodianGroupId).toBeUndefined();
    expect(cfg.contractData?.atomFactoryAddress).toBeUndefined();
  });

  it.each([
    ["nodeId", (cfg: PaladinClientConfig) => { (cfg as any).nodeId = undefined; }],
    ["identity", (cfg: PaladinClientConfig) => { (cfg as any).identity = undefined; }],
    ["identities.registryAddress", (cfg: PaladinClientConfig) => { cfg.identities = { ...cfg.identities, registryAddress: undefined }; }],
    ["identities.bondCustodian", (cfg: PaladinClientConfig) => { cfg.identities = { ...cfg.identities, bondCustodian: undefined }; }],
    ["contractData.restrictedAtomFactoryAddress", (cfg: PaladinClientConfig) => { cfg.contractData = { ...cfg.contractData, restrictedAtomFactoryAddress: undefined }; }],
  ])("throws PD_CLIENT_MISSING_CONFIG naming %s when it's missing", (fieldName, breakIt) => {
    const cfg = validConfig();
    breakIt(cfg);
    try {
      validateClientConfig(cfg);
      expect.fail("expected validateClientConfig to throw");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("PD_CLIENT_MISSING_CONFIG");
      expect((e as Error).message).toContain(fieldName);
    }
  });
});

describe("loadClientConfigFile", () => {
  // Matches exactly what Paladin/scripts/bootstrap-platform.ts's dry run prints as the file
  // shape it will write (contract-data-<bank>.json): PaladinClientConfig minus
  // nodeUrl/wsUrl/rpcAuth, which only ever come from env/runtime, never a static file.
  function writeTempConfigFile(content: object): string {
    const path = join(tmpdir(), `paladin-client-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it("loads a file in the bootstrap dry-run's shape, merges in the connection, and validates ok", () => {
    const path = writeTempConfigFile({
      nodeId: "node2",
      identity: "investor2",
      identities: { registryAddress: "0xregistry", bondCustodian: "bondCustodian@node1" },
      contractData: { restrictedAtomFactoryAddress: "0xatomfactory", cashToken: "0xcash", groupIds: {} },
    });
    try {
      const cfg = loadClientConfigFile(path, { nodeUrl: "http://127.0.0.1:31648" });
      expect(cfg.nodeUrl).toBe("http://127.0.0.1:31648");
      expect(cfg.nodeId).toBe("node2");
      expect(cfg.identity).toBe("investor2");
      expect(cfg.contractData?.cashToken).toBe("0xcash");
    } finally {
      unlinkSync(path);
    }
  });

  it("throws a clear PD_CLIENT_MISSING_CONFIG error naming the missing field", () => {
    const path = writeTempConfigFile({
      nodeId: "node2",
      identity: "investor2",
      identities: { bondCustodian: "bondCustodian@node1" }, // registryAddress missing
      contractData: { restrictedAtomFactoryAddress: "0xatomfactory" },
    });
    try {
      expect(() => loadClientConfigFile(path, { nodeUrl: "http://127.0.0.1:31648" })).toThrow(/identities\.registryAddress/);
    } finally {
      unlinkSync(path);
    }
  });

  it("throws a clear error if the file itself cannot be read", () => {
    expect(() => loadClientConfigFile("/no/such/file.json", { nodeUrl: "http://127.0.0.1:31648" })).toThrow();
  });
});

// 0.3.1: last PD_NOT_IMPLEMENTED stub closed -- the whole backend outbox flow depends on it.
// No idempotencyKey param (removed after a live finding: pgroup_sendMessage's correlationId
// is validated server-side as a real UUID, not a free-form dedup key -- "trade-1:outright-group"
// failed with PD020704 "invalid UUID length" -- so a caller's own key is never forwarded there).
describe("sendGroupMessage", () => {
  it("calls pgroup.sendMessage with domain pente and the given group/topic/data, no correlationId", async () => {
    const sendMessage = vi.fn(async () => ({}));
    const sdk = { pgroup: { sendMessage } };
    await sendGroupMessage(sdk, "0xgroup", "outright-group", { hello: "world" });
    expect(sendMessage).toHaveBeenCalledWith({ domain: "pente", group: "0xgroup", topic: "outright-group", data: { hello: "world" } });
  });
});

// Task #14 (lead report): the raw SDK message has `group`/`node`, not `groupId`/`sender` -- a
// real backend-reported shape, not a guess (checked via pgroup_queryMessages on node1).
describe("toGroupMessage", () => {
  it("maps a real raw payload shape: group -> groupId, node preserved, no sender field", () => {
    const raw = {
      id: "msg-1",
      localSequence: 1,
      sent: "2026-10-06T10:00:00.000Z",
      received: "2026-10-06T10:00:00.050Z",
      node: "node2",
      correlationId: "corr-1",
      domain: "pente",
      group: "0xgroupabc",
      topic: "outright-group",
      data: { hello: "from investorA" },
    };
    const mapped = toGroupMessage(raw);
    expect(mapped).toEqual({
      id: "msg-1",
      groupId: "0xgroupabc",
      domain: "pente",
      topic: "outright-group",
      correlationId: "corr-1",
      data: { hello: "from investorA" },
      node: "node2",
      sent: "2026-10-06T10:00:00.000Z",
      received: "2026-10-06T10:00:00.050Z",
    });
    expect((mapped as Record<string, unknown>).sender).toBeUndefined();
  });
});

// 0.3.0 lead addition: getDistributionState/getPrice read the public TokenDistribution behind
// BondTrackerPublic.distribution(), trustlessly, so an investor can lock the right amount.
describe("readDistributionAddress", () => {
  it("normalizes an address returned without a 0x prefix", async () => {
    const sdk = { ptx: { call: vi.fn(async () => ({ "0": "aaaa000000000000000000000000000000000a" })) } };
    expect(await readDistributionAddress(sdk, "bi@node1", "0xtoken")).toBe("0xaaaa000000000000000000000000000000000a");
  });

  it("returns the zero address as-is before any distribution round has started", async () => {
    const sdk = { ptx: { call: vi.fn(async () => ({ "0": "0x0000000000000000000000000000000000000000" })) } };
    expect(await readDistributionAddress(sdk, "bi@node1", "0xtoken")).toBe("0x0000000000000000000000000000000000000000");
  });
});

// 0.7.0: the public tracker is status-only for new series (no units/price/supply); the client
// routes by the tracker's schema() marker and keeps the legacy public-amounts path for series
// deployed before. One case per version below.
describe("public tracker schema routing (0.7.0)", () => {
  const PT = "0xpublic";
  const legacySdk = () => ({
    ptx: {
      call: vi.fn(async (tx: any) => {
        switch (tx.function) {
          case "schema": throw new Error("execution reverted (no such function)");
          case "distribution": return { "0": "0xaaaa000000000000000000000000000000000a" };
          case "status": return { "0": "2" };
          case "availableUnits": return { "0": "600" };
          case "trancheCount": return { "0": "1" };
          case "purchasePrice": return { "0": "7" };
          case "minimumDenomination": return { "0": "3" };
          case "paymentToken": return { "0": "0xbbbb" };
          default: throw new Error(`legacySdk: unexpected ${tx.function}`);
        }
      }),
    },
  });
  const statusOnlySdk = () => ({
    ptx: {
      call: vi.fn(async (tx: any) => {
        switch (tx.function) {
          case "schema": return { "0": "status-only-v1" };
          case "status": return { "0": "2" };
          case "trancheCount": return { "0": "1" };
          case "currencyToken": return { "0": "0xcccc" };
          default: throw new Error(`statusOnlySdk: unexpected ${tx.function}`);
        }
      }),
    },
  });
  const priv = (units: string, price: string, denom: string) => ({
    availableUnits: async () => units,
    discountPrice: async () => price,
    minimumDenomination: async () => denom,
  });

  it("legacy series (no schema()): detected via distribution(), state read from the public amounts", async () => {
    const sdk = legacySdk();
    expect(await detectPublicTrackerSchema(sdk, "bi@node1", PT)).toBe("legacy");
    expect(await readLegacyDistributionState(sdk, "bi@node1", PT)).toEqual({
      status: "DISTRIBUTION_STARTED", availableUnits: "600", trancheCount: "1",
      purchasePrice: "7", minimumDenomination: "3", paymentToken: "0xbbbb",
    });
  });

  it("status-only series (schema() answers): detected, public state has no units or price", async () => {
    const sdk = statusOnlySdk();
    expect(await detectPublicTrackerSchema(sdk, "bi@node1", PT)).toBe("status-only");
    expect(await readStatusOnlyDistributionState(sdk, "investor@node2", PT)).toEqual({ status: "DISTRIBUTION_STARTED", trancheCount: "1" });
  });

  it("status-only series, BI side: units and round terms come from the private reader", async () => {
    expect(await readStatusOnlyDistributionState(statusOnlySdk(), "bi@node1", PT, priv("600", "7", "3"))).toEqual({
      status: "DISTRIBUTION_STARTED", availableUnits: "600", trancheCount: "1",
      purchasePrice: "7", minimumDenomination: "3", paymentToken: "0xcccc",
    });
  });

  it("status-only series before the first round: units reported, no price terms", async () => {
    const state = await readStatusOnlyDistributionState(statusOnlySdk(), "bi@node1", PT, priv("0", "0", "0"));
    expect(state.purchasePrice).toBeUndefined();
    expect(state.minimumDenomination).toBeUndefined();
  });

  it("an unreachable node is not mistaken for a legacy series: the original error is rethrown", async () => {
    const sdk = { ptx: { call: vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }) } };
    await expect(detectPublicTrackerSchema(sdk, "bi@node1", PT)).rejects.toThrow("ECONNREFUSED");
  });

  it("an unknown schema marker is refused", async () => {
    const sdk = { ptx: { call: vi.fn(async () => ({ "0": "status-only-v9" })) } };
    await expect(detectPublicTrackerSchema(sdk, "bi@node1", PT)).rejects.toMatchObject({ code: "PD_CLIENT_UNKNOWN_TRACKER_SCHEMA" });
  });

  it("statusOnlyPrice: units x price, whole multiples of the minimum denomination only", () => {
    expect(statusOnlyPrice("50", "2", "5")).toBe("100");
    expect(() => statusOnlyPrice("1", "2", "5")).toThrowError(/minimum denomination/);
    expect(() => statusOnlyPrice("50", "2", "0")).toThrowError(/no distribution round/);
  });
});

// 0.3.0 PD_CLIENT_LOCK_ALREADY_PREPARED guard (lead-required): a non-zero spendCommitment means
// updateLock has already run once -- a second prepareUnlock would change it and invalidate any
// unlockCall/cancelCall already recorded from the first prepare.
describe("isLockPrepared", () => {
  const ZERO = "0x" + "00".repeat(32);
  const NONZERO = "0x" + "11".repeat(32);

  it("reports NOT prepared when spendCommitment is zero", async () => {
    const sdk = { ptx: { call: vi.fn(async () => ({ info: { spendCommitment: ZERO } })) } };
    expect(await isLockPrepared(sdk, "bi@node1", "0xtoken", "0xlock")).toBe(false);
  });

  it("reports prepared when spendCommitment is set", async () => {
    const sdk = { ptx: { call: vi.fn(async () => ({ info: { spendCommitment: NONZERO } })) } };
    expect(await isLockPrepared(sdk, "bi@node1", "0xtoken", "0xlock")).toBe(true);
  });
});

// Task #8 lead requirement #3: verifyCancelCall is verifyDelegatedLeg's mirror for the cancel
// path -- ALL outputs must belong to the single owner, no split, no external expected amount.
describe("verifyCancelCall", () => {
  // Real 40-hex-char addresses -- see verifyDelegatedLeg's own comment above on why length
  // matters here (RAW_ADDRESS_RE, the 0.3.1 lookup-or-address fix).
  const OWNER = "0x" + "a".repeat(40);
  const DELEGATE = "0x" + "b".repeat(40);
  const THIRD_PARTY = "0x" + "d".repeat(40);
  const LOCK_ID = "0x" + "11".repeat(32);
  const OTHER_LOCK_ID = "0x" + "99".repeat(32);
  const OUT_TO_OWNER = "0x" + "22".repeat(32);
  const OUT_TO_THIRD_PARTY = "0x" + "44".repeat(32);

  function buildCancelCall(lockId: string, outputs: string[]): string {
    const cancelArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes32 txId, bytes32[] inputs, bytes32[] outputs, bytes data, bytes proof)"],
      [{ txId: "0x" + "00".repeat(32), inputs: [], outputs, data: "0x", proof: "0x" }]
    );
    return new ethers.Interface(INotoAbi.abi).encodeFunctionData("cancelLock", [lockId, cancelArgs, "0x"]);
  }

  function mockSdk(opts: { coinStates?: { id: string; data: { owner: string; amount: string } }[] } = {}) {
    const coinStates = opts.coinStates ?? [{ id: OUT_TO_OWNER, data: { owner: OWNER, amount: "100" } }];
    return {
      // Not called by verifyCancelCall anymore (lead decision, 2026-10-05: it now runs BEFORE
      // delegation) -- kept only so this mock satisfies VerifyDelegatedLegSdk's shape.
      ptx: { call: vi.fn(async () => ({ info: { owner: OWNER, spender: DELEGATE } })) },
      pstate: {
        listSchemas: vi.fn(async () => [{ id: "coin-schema", signature: "NotoCoin(bytes32,address,uint256)", definition: {} }]),
        // verifyCancelCall now queries unfiltered ({}) so it can tell STATE_NOT_FOUND (absent
        // entirely) apart from RECIPIENT_MISMATCH (present, wrong owner) -- the mock just
        // returns every coinState regardless of the query argument.
        queryContractStates: vi.fn(async () => coinStates),
      },
      // 0.3.1 lookup-or-address fix: resolveToAddress calls this for any non-address `owner`.
      getVerifiers: vi.fn((lookup: string) => [{ address: async () => (lookup === "owner@node1" ? OWNER : undefined) }]),
    };
  }

  it("accepts before delegation too (lead decision: cancelCall is self-recovery-only, no delegation precondition)", async () => {
    const sdk = mockSdk();
    const cancelCall = buildCancelCall(LOCK_ID, [OUT_TO_OWNER]);
    const result = await verifyCancelCall(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, cancelCall, OWNER);
    expect(result.ok).toBe(true);
  });

  it("accepts when every output belongs to the owner", async () => {
    const sdk = mockSdk();
    const cancelCall = buildCancelCall(LOCK_ID, [OUT_TO_OWNER]);
    const result = await verifyCancelCall(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, cancelCall, OWNER);
    expect(result.ok).toBe(true);
  });

  it("rejects with code LOCKID_MISMATCH when the cancelCall's embedded lockId does not match", async () => {
    const sdk = mockSdk();
    const cancelCall = buildCancelCall(OTHER_LOCK_ID, [OUT_TO_OWNER]);
    const result = await verifyCancelCall(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, cancelCall, OWNER);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("LOCKID_MISMATCH");
    expect(result.reason).toContain("embedded lockId");
  });

  // 0.3.1 fix: same lookup-or-address acceptance as verifyDelegatedLeg -- the backend always
  // passes a lookup for `owner`, which used to never match the raw-address state field.
  it("accepts `owner` given as a LOOKUP, resolving to the same address as the raw-address form", async () => {
    const sdk = mockSdk();
    const cancelCall = buildCancelCall(LOCK_ID, [OUT_TO_OWNER]);
    const byAddress = await verifyCancelCall(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, cancelCall, OWNER);
    const byLookup = await verifyCancelCall(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, cancelCall, "owner@node1");
    expect(byLookup.ok).toBe(true);
    expect(byLookup).toEqual(byAddress);
  });

  it("rejects with code RECIPIENT_MISMATCH when an output belongs to someone other than the owner (refund leaking to a third party)", async () => {
    const sdk = mockSdk({ coinStates: [{ id: OUT_TO_THIRD_PARTY, data: { owner: THIRD_PARTY, amount: "100" } }] });
    const cancelCall = buildCancelCall(LOCK_ID, [OUT_TO_THIRD_PARTY]);
    const result = await verifyCancelCall(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, cancelCall, OWNER);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("RECIPIENT_MISMATCH");
    expect(TRANSIENT_VERIFY_CODES.has(result.code!)).toBe(false);
  });

  // Lead requirement (2026-10-05): an output absent from this node's view entirely (vs.
  // found-but-wrong-owner above) is a propagation-timing issue -- TRANSIENT.
  it("rejects with code STATE_NOT_FOUND when an output has not propagated to this node yet", async () => {
    const sdk = mockSdk({ coinStates: [] }); // OUT_TO_OWNER missing entirely
    const cancelCall = buildCancelCall(LOCK_ID, [OUT_TO_OWNER]);
    const result = await verifyCancelCall(sdk, "noto", "bi@node1", "0xtoken", LOCK_ID, cancelCall, OWNER);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("STATE_NOT_FOUND");
    expect(TRANSIENT_VERIFY_CODES.has(result.code!)).toBe(true);
  });
});

// D3 (architecture review, 2026-10-05): human value in, encoded bytes on-chain, decoded human
// value back out -- these round-trip helpers are what issueSeries/getSeries build on.
describe("toFixedBytes/fromFixedBytes", () => {
  it("round-trips a string shorter than the byte length, zero-padded at the end", () => {
    const encoded = toFixedBytes("FR0100XXXXX", 12);
    expect(ethers.getBytes(encoded).length).toBe(12);
    expect(encoded.toLowerCase().endsWith("00")).toBe(true); // 11-byte string in 12 bytes -> one trailing zero
    expect(fromFixedBytes(encoded)).toBe("FR0100XXXXX");
  });

  it("round-trips a string exactly at the byte length", () => {
    const encoded = toFixedBytes("ABCDEFGHIJKL", 12);
    expect(fromFixedBytes(encoded)).toBe("ABCDEFGHIJKL");
  });

  it("throws PD_CLIENT_ENCODING_FAILED when the string is too long for byteLen", () => {
    expect(() => toFixedBytes("this string is definitely too long for 12 bytes", 12)).toThrow(PaladinClientError);
    try {
      toFixedBytes("this string is definitely too long for 12 bytes", 12);
    } catch (e) {
      expect((e as PaladinClientError).code).toBe("PD_CLIENT_ENCODING_FAILED");
    }
  });

  it("fromFixedBytes accepts a hex string without the 0x prefix", () => {
    const encoded = toFixedBytes("hi", 4).slice(2); // strip 0x
    expect(fromFixedBytes(encoded)).toBe("hi");
  });
});

describe("toUnixSeconds/fromUnixSeconds", () => {
  it("round-trips an ISO date string", () => {
    const iso = "2026-10-05T00:00:00.000Z";
    const seconds = toUnixSeconds(iso);
    expect(seconds).toBe(String(Math.floor(Date.parse(iso) / 1000)));
    expect(fromUnixSeconds(seconds)).toBe(iso);
  });

  it("accepts fromUnixSeconds given a number instead of a string", () => {
    expect(fromUnixSeconds(1759622400)).toBe(new Date(1759622400 * 1000).toISOString());
  });

  it("throws PD_CLIENT_ENCODING_FAILED for an unparseable date", () => {
    try {
      toUnixSeconds("not a date");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as PaladinClientError).code).toBe("PD_CLIENT_ENCODING_FAILED");
    }
  });
});

describe("toBytes32Hash", () => {
  const HASH = "11".repeat(32);

  it("adds a 0x prefix when missing", () => {
    expect(toBytes32Hash(HASH, "termsHash")).toBe("0x" + HASH);
  });

  it("leaves an already-prefixed hash unchanged", () => {
    expect(toBytes32Hash("0x" + HASH, "termsHash")).toBe("0x" + HASH);
  });

  it("throws PD_CLIENT_ENCODING_FAILED for a hash that isn't 32 bytes", () => {
    try {
      toBytes32Hash("0xdead", "termsHash");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as PaladinClientError).code).toBe("PD_CLIENT_ENCODING_FAILED");
    }
  });
});

// BACKLOG #10: issueSeries calls encodeSeriesFields BEFORE any deploy (group/trackers/Noto
// token), so a bad registry field throws PD_CLIENT_ENCODING_FAILED with zero on-chain side
// effects -- previously it threw mid-way inside registerSeries and orphaned everything already
// deployed (two real orphaned-approval incidents: tx cc982051, 5bf41ebf).
describe("encodeSeriesFields", () => {
  const VALID: SeriesRegistrationParams = {
    instrumentType: "SRBI",
    seriesCode: "SRBI2026A",
    isin: "ID1000123456", // exactly 12 bytes
    currencyToken: "IDRX",
    faceValue: "1000000",
    issueDate: "2026-10-07T00:00:00.000Z",
    maturityDate: "2027-10-07T00:00:00.000Z",
    transferRestricted: false,
    termsHash: "11".repeat(32),
  };

  it("encodes all 6 registry fields without throwing on valid input", () => {
    const enc = encodeSeriesFields(VALID);
    expect(enc.instrumentType).toBeTruthy();
    expect(enc.seriesCode).toBeTruthy();
    expect(ethers.getBytes(enc.isin).length).toBe(12);
    expect(enc.issueDate).toBe(String(Math.floor(Date.parse(VALID.issueDate) / 1000)));
    expect(enc.maturityDate).toBe(String(Math.floor(Date.parse(VALID.maturityDate) / 1000)));
    expect(enc.termsHash).toBe("0x" + VALID.termsHash);
  });

  it.each([
    ["isin over 12 bytes", { ...VALID, isin: "ID10001234567890" }],
    ["unparseable issueDate", { ...VALID, issueDate: "not a date" }],
    ["unparseable maturityDate", { ...VALID, maturityDate: "not a date" }],
    ["termsHash not 32 bytes", { ...VALID, termsHash: "0xdead" }],
  ] as const)("throws PD_CLIENT_ENCODING_FAILED for %s", (_name, params) => {
    try {
      encodeSeriesFields(params);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as PaladinClientError).code).toBe("PD_CLIENT_ENCODING_FAILED");
    }
  });
});

// D-series (architecture review, 2026-10-05): a receipt POLL TIMING OUT is a different
// condition from a genuinely failed (reverted) transaction -- retryable, carries the txId.
describe("receiptTimeoutError", () => {
  it("produces a retryable PD_CLIENT_RECEIPT_TIMEOUT carrying the txId", () => {
    const err = receiptTimeoutError("submitIdempotent", "tx-123");
    expect(err.code).toBe("PD_CLIENT_RECEIPT_TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.txId).toBe("tx-123");
    expect(err.message).toContain("tx-123");
  });
});

// 0.6.4 (real incident): a real 3.5-minute production hang traced to the SDK's own
// pollForReceipt looping on a counter, not Date.now() -- a single stalled HTTP call underneath
// blocks it forever regardless of its own waitMs. withReceiptDeadline is the defensive outer
// bound: it races the SDK promise against a REAL setTimeout so our code can never hang past
// waitMs, even if the wrapped promise never settles.
describe("withReceiptDeadline", () => {
  it("resolves normally when the wrapped promise settles before the deadline", async () => {
    const result = await withReceiptDeadline(Promise.resolve("receipt"), 1000, "someMethod", "tx-1");
    expect(result).toBe("receipt");
  });

  it("rejects with PD_CLIENT_RECEIPT_TIMEOUT (retryable, correct txId) if the wrapped promise never resolves", async () => {
    const start = Date.now();
    const never = new Promise(() => {});
    await expect(withReceiptDeadline(never, 50, "someMethod", "tx-1")).rejects.toMatchObject({
      code: "PD_CLIENT_RECEIPT_TIMEOUT",
      retryable: true,
      txId: "tx-1",
    });
    expect(Date.now() - start).toBeLessThan(200);
  });
});

// 0.4.2 bugfix (lead report): deployAgreement/issueSeries deployed via a raw
// `.waitForDeploy()` with no PD012220 recovery, so a retry after a DB reset threw instead of
// recovering the ORIGINAL deploy's result. resolveIdempotentFuture is the pulled-out recovery
// logic submitIdempotent already had for ptx.sendTransaction, now also usable directly against
// a TransactionFuture/PentePrivateDeployFuture's `.id`.
describe("resolveIdempotentFuture", () => {
  const RECEIPT = { success: true, contractAddress: "0xaddr" };

  it("happy path: returns the receipt without ever looking up the idempotency key", async () => {
    const sdk = { ptx: { getTransactionByIdempotencyKey: vi.fn() }, pollForReceipt: vi.fn(async () => RECEIPT) };
    const result = await resolveIdempotentFuture(sdk, Promise.resolve("tx-1"), "key-1", 60000);
    expect(result).toBe(RECEIPT);
    expect(sdk.ptx.getTransactionByIdempotencyKey).not.toHaveBeenCalled();
  });

  it("PD012220 collision with a matching idempotencyKey recovers the original tx and polls it", async () => {
    const sdk = {
      ptx: { getTransactionByIdempotencyKey: vi.fn(async () => ({ id: "original-tx" })) },
      pollForReceipt: vi.fn(async () => RECEIPT),
    };
    const txId = Promise.reject(new Error("PD012220: idempotencyKey already used by submitted transaction x"));
    const result = await resolveIdempotentFuture(sdk, txId, "key-1", 60000);
    expect(result).toBe(RECEIPT);
    expect(sdk.ptx.getTransactionByIdempotencyKey).toHaveBeenCalledWith("key-1");
    expect(sdk.pollForReceipt).toHaveBeenCalledWith("original-tx", 60000, false);
  });

  it("PD012220 collision but idempotencyKey is undefined rethrows without looking up anything", async () => {
    const sdk = { ptx: { getTransactionByIdempotencyKey: vi.fn() }, pollForReceipt: vi.fn() };
    const txId = Promise.reject(new Error("PD012220: idempotencyKey already used by submitted transaction x"));
    await expect(resolveIdempotentFuture(sdk, txId, undefined, 60000)).rejects.toMatchObject({ code: "PD012220" });
    expect(sdk.ptx.getTransactionByIdempotencyKey).not.toHaveBeenCalled();
  });

  it("PD012220 collision but the lookup finds nothing rethrows the original wrapped error", async () => {
    const sdk = { ptx: { getTransactionByIdempotencyKey: vi.fn(async () => undefined) }, pollForReceipt: vi.fn() };
    const txId = Promise.reject(new Error("PD012220: idempotencyKey already used by submitted transaction x"));
    await expect(resolveIdempotentFuture(sdk, txId, "key-1", 60000)).rejects.toMatchObject({ code: "PD012220" });
    expect(sdk.pollForReceipt).not.toHaveBeenCalled();
  });

  it("a non-PD012220 error rethrows immediately without ever looking up the idempotency key", async () => {
    const sdk = { ptx: { getTransactionByIdempotencyKey: vi.fn() }, pollForReceipt: vi.fn() };
    const txId = Promise.reject(new Error("PD011206: DOMAIN pente returned error..."));
    await expect(resolveIdempotentFuture(sdk, txId, "key-1", 60000)).rejects.toMatchObject({ code: "PD011206" });
    expect(sdk.ptx.getTransactionByIdempotencyKey).not.toHaveBeenCalled();
  });

  it("pollForReceipt timing out (returns undefined) throws receiptTimeoutError", async () => {
    const sdk = { ptx: { getTransactionByIdempotencyKey: vi.fn() }, pollForReceipt: vi.fn(async () => undefined) };
    await expect(resolveIdempotentFuture(sdk, Promise.resolve("tx-1"), "key-1", 60000)).rejects.toMatchObject({
      code: "PD_CLIENT_RECEIPT_TIMEOUT",
      txId: "tx-1",
    });
  });

  it("forwards full=true to pollForReceipt", async () => {
    const sdk = { ptx: { getTransactionByIdempotencyKey: vi.fn() }, pollForReceipt: vi.fn(async () => RECEIPT) };
    await resolveIdempotentFuture(sdk, Promise.resolve("tx-1"), "key-1", 60000, true);
    expect(sdk.pollForReceipt).toHaveBeenCalledWith("tx-1", 60000, true);
  });

  // 0.6.4 regression test for the real incident: a mocked SDK whose pollForReceipt NEVER
  // settles (the exact shape of the production hang) must still reject within waitMs via
  // withReceiptDeadline, instead of hanging the test (and, in production, the caller) forever.
  it("regression (real incident): a pollForReceipt that never resolves rejects with the timeout error instead of hanging", async () => {
    const sdk = { ptx: { getTransactionByIdempotencyKey: vi.fn() }, pollForReceipt: vi.fn(() => new Promise(() => {})) };
    const start = Date.now();
    await expect(resolveIdempotentFuture(sdk, Promise.resolve("tx-1"), "key-1", 50)).rejects.toMatchObject({
      code: "PD_CLIENT_RECEIPT_TIMEOUT",
      retryable: true,
      txId: "tx-1",
    });
    expect(Date.now() - start).toBeLessThan(200);
  });
});

// 0.5.0 fund-safety fix (live incident): a Pente private contract's address is only unique
// WITHIN its privacy group -- the same deployer identity + nonce in two DIFFERENT groups
// produces the SAME address for two completely different contract instances (confirmed live:
// 6 onboarding Agreement contracts in 6 different groups all deployed to the same address).
// This is a narrow, honest unit test of the actual mechanism the bug was in: the cache key
// itself. The full end-to-end "ops go to the right group" proof is a separate live check
// against the real cluster, not something a unit test of a Map can establish.
describe("agreementCacheKey", () => {
  const COLLIDING_ADDRESS = "0x1d42fff0000000000000000000000000000000";

  it("produces different keys for the same address in different groups, with independent lookups", () => {
    const cache = new Map<string, string>();
    cache.set(agreementCacheKey("group-A", COLLIDING_ADDRESS), "agreement-for-group-A");
    cache.set(agreementCacheKey("group-F", COLLIDING_ADDRESS), "agreement-for-group-F");

    const keyA = agreementCacheKey("group-A", COLLIDING_ADDRESS);
    const keyF = agreementCacheKey("group-F", COLLIDING_ADDRESS);
    expect(keyA).not.toBe(keyF);
    expect(cache.get(keyA)).toBe("agreement-for-group-A");
    expect(cache.get(keyF)).toBe("agreement-for-group-F");
  });

  it("lowercases the address consistently but does not normalize groupId", () => {
    const upper = COLLIDING_ADDRESS.toUpperCase().replace("0X", "0x");
    expect(agreementCacheKey("group-A", COLLIDING_ADDRESS)).toBe(agreementCacheKey("group-A", upper));
    expect(agreementCacheKey("group-A", COLLIDING_ADDRESS)).not.toBe(agreementCacheKey("GROUP-A", COLLIDING_ADDRESS));
  });
});

// Task #15 (lead report): a leg asset came back from getAgreement without "0x" (BI's own
// message showed "98143f4b..."); Paladin's ABI decode of a pgroup_call result is inconsistent
// about the prefix AND the case, so the client must normalize both before any comparison.
describe("normAddr", () => {
  it("adds a missing 0x prefix and lowercases", () => {
    expect(normAddr("98143F4Bff2281d6b20fa4987daf9f31d22c9c77")).toBe("0x98143f4bff2281d6b20fa4987daf9f31d22c9c77");
  });
  it("lowercases an already-prefixed, mixed-case address", () => {
    expect(normAddr("0xAABB00000000000000000000000000000000CC")).toBe("0xaabb00000000000000000000000000000000cc");
  });
  it("leaves an already-normalized address unchanged", () => {
    expect(normAddr("0xaabb00000000000000000000000000000000cc")).toBe("0xaabb00000000000000000000000000000000cc");
  });
});

describe("requireLegOwner", () => {
  it("passes silently when the caller's address matches the leg's from, modulo case/prefix", () => {
    expect(() => requireLegOwner("0xAABB00000000000000000000000000000000CC", "0xaabb00000000000000000000000000000000cc", 0, "trade-1")).not.toThrow();
  });
  it("throws PD_CLIENT_WRONG_ROLE when the caller is not the leg owner", () => {
    expect(() => requireLegOwner("0xaabb00000000000000000000000000000000cc", "0xdead000000000000000000000000000000beef", 0, "trade-1")).toThrow(/PD_CLIENT_WRONG_ROLE|owned by/);
  });
});

describe("requireLegRecipientMatch", () => {
  it("passes silently when the resolved recipient matches the leg's to, modulo case/prefix", () => {
    expect(() => requireLegRecipientMatch("0xAABB00000000000000000000000000000000CC", "0xaabb00000000000000000000000000000000cc", "investor2@node2", 0, "trade-1")).not.toThrow();
  });
  it("throws PD_CLIENT_LEG_MISMATCH when recipientLookup resolves to a different address than the on-chain leg.to", () => {
    expect(() =>
      requireLegRecipientMatch("0xaabb00000000000000000000000000000000cc", "0xdead000000000000000000000000000000beef", "investor3@node3", 0, "trade-1")
    ).toThrow(/PD_CLIENT_LEG_MISMATCH|recorded recipient/);
  });
});

// Task #17 (lead report): a client-side PRE-submit guard (prepareUnlock's isLockPrepared) ran
// before resolveIdempotentFuture ever got a chance to recover a retry with the same key --
// findReceiptByIdempotencyKey is the lookup that must run FIRST, ahead of any such guard.
describe("findReceiptByIdempotencyKey", () => {
  const RECEIPT = { success: true, domainReceipt: { lockInfo: { unlockCall: "0xu", cancelCall: "0xc" } } };

  it("returns undefined (no lookup match) when no prior transaction exists for this key", async () => {
    const sdk = { ptx: { getTransactionByIdempotencyKey: vi.fn(async () => undefined) }, pollForReceipt: vi.fn() };
    const result = await findReceiptByIdempotencyKey(sdk, "key-1", 60000, true);
    expect(result).toBeUndefined();
    expect(sdk.pollForReceipt).not.toHaveBeenCalled();
  });

  it("returns the ORIGINAL receipt when a prior transaction exists for this key", async () => {
    const sdk = {
      ptx: { getTransactionByIdempotencyKey: vi.fn(async () => ({ id: "original-tx" })) },
      pollForReceipt: vi.fn(async () => RECEIPT),
    };
    const result = await findReceiptByIdempotencyKey(sdk, "key-1", 60000, true);
    expect(result).toBe(RECEIPT);
    expect(sdk.pollForReceipt).toHaveBeenCalledWith("original-tx", 60000, true);
  });

  it("throws PD_CLIENT_RECEIPT_TIMEOUT (retryable) if the prior transaction has no receipt yet", async () => {
    const sdk = {
      ptx: { getTransactionByIdempotencyKey: vi.fn(async () => ({ id: "original-tx" })) },
      pollForReceipt: vi.fn(async () => undefined),
    };
    await expect(findReceiptByIdempotencyKey(sdk, "key-1", 60000, true)).rejects.toMatchObject({ code: "PD_CLIENT_RECEIPT_TIMEOUT", retryable: true });
  });
});

describe("decodePrepareUnlockReceipt", () => {
  const RECIPIENT_ADDR = "0xaabb00000000000000000000000000000000cc";
  const receiptWith = (preparedOutputs: { id: string; data: { owner: string } }[]) => ({
    success: true,
    domainReceipt: { lockInfo: { unlockCall: "0xunlock", cancelCall: "0xcancel" }, states: { preparedOutputs } },
  });

  it("decodes lockId/unlockCall/cancelCall/preparedStateId from a successful receipt", () => {
    const receipt = receiptWith([{ id: "state-1", data: { owner: RECIPIENT_ADDR } }]);
    expect(decodePrepareUnlockReceipt(receipt, "lock-1", RECIPIENT_ADDR)).toEqual({
      lockId: "lock-1",
      unlockCall: "0xunlock",
      cancelCall: "0xcancel",
      preparedStateId: "state-1",
    });
  });

  it("matches the first recipient's owner case-insensitively (same reasoning as normAddr)", () => {
    const receipt = receiptWith([{ id: "state-1", data: { owner: RECIPIENT_ADDR.toUpperCase() } }]);
    expect(decodePrepareUnlockReceipt(receipt, "lock-1", RECIPIENT_ADDR).preparedStateId).toBe("state-1");
  });

  it("throws PD_CLIENT_PREPARE_UNLOCK_FAILED on a failed receipt", () => {
    expect(() => decodePrepareUnlockReceipt({ success: false, failureMessage: "reverted" }, "lock-1", RECIPIENT_ADDR)).toThrow(/PD_CLIENT_PREPARE_UNLOCK_FAILED|reverted/);
  });

  it("throws PD_CLIENT_PREPARE_UNLOCK_FAILED when no preparedOutputs entry matches the recipient", () => {
    const receipt = receiptWith([{ id: "state-1", data: { owner: "0xdead000000000000000000000000000000beef" } }]);
    expect(() => decodePrepareUnlockReceipt(receipt, "lock-1", RECIPIENT_ADDR)).toThrow(/PD_CLIENT_PREPARE_UNLOCK_FAILED|no preparedOutputs/);
  });
});

// Task #19 (0.6.0): transferCash/fundIssuer/cashBalanceOf all need the RD cash token's address
// without taking it as a param -- confirmed with the backend this deployment has exactly one.
describe("requireCashToken", () => {
  it("returns contractData.cashToken when set", () => {
    expect(requireCashToken({ contractData: { cashToken: "0xcash00000000000000000000000000000000ca" } } as any)).toBe(
      "0xcash00000000000000000000000000000000ca"
    );
  });
  it("throws PD_CLIENT_MISSING_CONFIG when contractData.cashToken is not set", () => {
    expect(() => requireCashToken({} as any)).toThrow(/PD_CLIENT_MISSING_CONFIG|cashToken/);
  });
});

// Task #22 (backend report): transferCash/fundIssuer/burnBond's failure throw used ONE fixed
// code regardless of the real reason -- backend needs to distinguish "insufficient funds"
// (PD200005) from any other failure to map to a specific HTTP status.
describe("receiptFailureError", () => {
  it("surfaces the real PD code from failureMessage when present", () => {
    const err = receiptFailureError("transferCash", "PD_CLIENT_TRANSFER_CASH_FAILED", { success: false, failureMessage: "PD200005: Insufficient funds (available=1000)" });
    expect(err.code).toBe("PD200005");
    expect(err.message).toBe("Insufficient funds (available=1000)");
  });
  it("falls back to the caller's own code when failureMessage has no PD code", () => {
    const err = receiptFailureError("burnBond", "PD_CLIENT_BURN_BOND_FAILED", { success: false, failureMessage: "connection reset" });
    expect(err.code).toBe("PD_CLIENT_BURN_BOND_FAILED");
    expect(err.message).toBe("burnBond failed: connection reset");
  });
  it("falls back to the caller's own code when there is no receipt at all", () => {
    const err = receiptFailureError("fundIssuer", "PD_CLIENT_FUND_ISSUER_FAILED", undefined);
    expect(err.code).toBe("PD_CLIENT_FUND_ISSUER_FAILED");
    expect(err.message).toBe("fundIssuer failed: no receipt");
  });
});

// 0.6.5 (task #25, real incident): prepareTradeLeg's compensating-release path needs its
// recovery info (lockId/lockReleased/tokenAddress) to actually reach the caller through the
// outer `catch (err) { throw toPaladinClientError(err); }` -- these tests cover the two new
// pure pieces plus that pass-through.
describe("lockRecoveryError", () => {
  it("builds a PaladinClientError with code, message, cause, and the lock recovery fields set", () => {
    const cause = new Error("PD200010: Investor is not registered");
    const err = lockRecoveryError("PD200010", "prepareUnlock failed after lockToken already succeeded", cause, "lock-123", true, "0xTokenAddress");
    expect(err.code).toBe("PD200010");
    expect(err.message).toBe("prepareUnlock failed after lockToken already succeeded");
    expect(err.cause).toBe(cause);
    expect(err.lockId).toBe("lock-123");
    expect(err.lockReleased).toBe(true);
    expect(err.tokenAddress).toBe("0xTokenAddress");
    expect(err.retryable).toBeUndefined();
    expect(err.txId).toBeUndefined();
  });
});

describe("PD_CLIENT_INVESTOR_NOT_REGISTERED", () => {
  it("is exported as the string PD_CLIENT_INVESTOR_NOT_REGISTERED", () => {
    expect(PD_CLIENT_INVESTOR_NOT_REGISTERED).toBe("PD_CLIENT_INVESTOR_NOT_REGISTERED");
  });
});

describe("toPaladinClientError (lockRecoveryError pass-through)", () => {
  it("passes a lockRecoveryError-produced error through unchanged, preserving lockId/lockReleased/tokenAddress", () => {
    const original = lockRecoveryError("PD_CLIENT_PREPARE_FAILED", "prepareUnlock failed", new Error("boom"), "lock-456", false, "0xOtherToken");
    const result = toPaladinClientError(original);
    expect(result).toBe(original);
    expect(result.lockId).toBe("lock-456");
    expect(result.lockReleased).toBe(false);
    expect(result.tokenAddress).toBe("0xOtherToken");
  });
});

// 0.6.6 (task #27b, real incident): backend's redemption handler checked `!leg.unlockCall` to
// mean "not recorded yet" -- an unprepared leg's unlockCall comes back as the literal string
// "0x" (Solidity's empty-bytes encoding), which is TRUTHY, so the check silently treated an
// un-prepared leg as prepared and wrote garbage into its own trade_legs table. isZeroHex is the
// one place that tells empty/zero hex apart from a real value; these tests cover both its
// direct uses (recordLeg's input guard, getAgreement's `prepared` field).
describe("isZeroHex", () => {
  it("is true for undefined, empty string, bare 0x, and an all-zero bytes32", () => {
    expect(isZeroHex(undefined)).toBe(true);
    expect(isZeroHex("")).toBe(true);
    expect(isZeroHex("0x")).toBe(true);
    expect(isZeroHex("0x" + "0".repeat(64))).toBe(true);
  });

  it("is false for a real non-zero hex value, regardless of case", () => {
    expect(isZeroHex("0x9fabe0226b298c7ec42e19f85fb74027ec8d0881b1192063cb768500c28c32e3")).toBe(false);
    expect(isZeroHex("0X00000000000000000000000000000000000000000000000000000000000001")).toBe(false);
  });
});
