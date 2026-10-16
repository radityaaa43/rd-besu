// RD and DFABI instrument records for the Zeto track (spec: besu/docs/instrument-data-spec.md).
// DFABI follows ICMA Bond Data Taxonomy v1.2, Appendix 12.1: top-level keys are the BDT group
// titles and the keys inside are the exact BDT field labels. RD is a short cash record.
// Only the Zeto-specific values are set here; the hash rule is shared with the stealth track:
//   dataHash = keccak256(UTF-8 bytes of canonicalJson(record)), canonical = keys sorted, no whitespace.
import { ethers } from "ethers";

export type ZetoToken = { address: string; tokenName: "Zeto_Anon" | "Zeto_AnonNullifierKyc" };
type Obj = Record<string, any>;

export const BDT_VERSION = "ICMA-BDT-v1.2";

// ---- hash rule ----

// Strict on purpose: JSON.stringify silently drops undefined keys, which would make a record and
// its re-read file hash differently. Amounts are strings, so floats are rejected too.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`canonicalJson: ${v} is not a safe integer (use a string for decimals)`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object" && v !== undefined) {
    const o = v as Obj;
    return `{${Object.keys(o).sort().map((k) => {
      if (o[k] === undefined) throw new Error(`canonicalJson: key "${k}" is undefined (omit absent fields)`);
      return `${JSON.stringify(k)}:${canonicalJson(o[k])}`;
    }).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported value ${String(v)}`);
}
export const dataHash = (record: unknown) => ethers.keccak256(ethers.toUtf8Bytes(canonicalJson(record)));

// ---- identifiers (never invented: callers pass real values, these only check them) ----

const expand = (s: string) => [...s].map((c) => parseInt(c, 36).toString()).join("");
// ISO 6166: 2 letters + 9 alphanumerics + Luhn check digit over the letter-expanded body.
export function isValidIsin(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return false;
  const digits = expand(isin);
  let sum = 0;
  [...digits].reverse().forEach((ch, i) => {
    let d = Number(ch);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  });
  return sum % 10 === 0;
}
// ISO 17442: 20 alphanumerics whose letter-expanded value is 1 mod 97.
export function isValidLei(lei: string): boolean {
  return /^[A-Z0-9]{18}[0-9]{2}$/.test(lei) && BigInt(expand(lei)) % 97n === 1n;
}

// ---- DLT extension ----

// Spec table, DLT extension row: Besu / Private / Security, Smart Contract = the Zeto token.
export function dltExtension(t: ZetoToken): Obj {
  return {
    Type: "Hyperledger Besu",
    Accessibility: "Private",
    "Token Type": "Security",
    "Token Technical Reference": `Paladin zeto domain, ${t.tokenName}`,
    "Smart Contract": ethers.getAddress(t.address),
  };
}
const zetoExtension = (t: ZetoToken) => ({ domain: "zeto", tokenName: t.tokenName, standard: "Paladin v1.0.0" });

// ---- records ----

const need = (cond: unknown, what: string) => { if (!cond) throw new Error(`instrument: ${what}`); };
const group = (terms: Obj, name: string): Obj => (need(terms[name] && typeof terms[name] === "object", `terms.${name} is required`), terms[name]);

// terms = the issuer's inputs, grouped by BDT group title with BDT field labels as keys.
// Derived here: Identifier Type, DLT Bond Indicator, Specified/Payment/Settlement Currency,
// Governing Law default, the DLT extension. Everything else passes through unchanged.
export function buildDfabiRecord(terms: Obj, token: ZetoToken): Obj {
  const ident = group(terms, "Security identifier and status");
  const issuer = group(terms, "Issuer");
  need(isValidIsin(ident["Identifier Value"] ?? ""), "Identifier Value is not a valid ISIN (ISO 6166 check digit)");
  need(isValidLei(issuer["Issuer LEI"] ?? ""), "Issuer LEI is not valid (ISO 17442, mod 97)");
  need(ident["Form Note"] && ident["Status Notes"], "Form Note and Status Notes are required inputs");
  const guarantor = terms["Guarantor"];
  if (guarantor) need(isValidLei(guarantor["Guarantor LEI"] ?? ""), "Guarantor LEI is not valid");

  const { extensions: inputExt, ...rest } = terms;
  return {
    schema: BDT_VERSION,
    kind: "DFABI",
    ...rest,
    "Security identifier and status": { ...ident, "Identifier Type": "ISIN", "DLT Bond Indicator": true },
    Issuer: { "Issuer Name": "Bank Indonesia", ...issuer },
    Currency: { "Specified Currency": "IDR", "Payment Currency": "IDR", "Settlement Currency": "IDR" },
    "Listing and Restrictions": { "Governing Law": "Indonesia", ...(terms["Listing and Restrictions"] ?? {}) },
    DLTPlatformInformation: dltExtension(token),
    extensions: { ...(inputExt ?? {}), zeto: zetoExtension(token) },
  };
}

// RD is cash, so BDT does not apply. Zeto has no decimals of its own: a Zeto amount is an integer
// unit and 1 unit = 1 rupiah, matching the stealth RD (decimals 0).
// ponytail: the backing SampleERC20 inherits OpenZeppelin's default decimals() of 18, so a wallet
// reading the ERC20 shows 1 unit as 1e-18; not verified against the deployed token.
export function buildRdRecord(input: { issuerLei: string }, token: ZetoToken): Obj {
  need(isValidLei(input.issuerLei), "issuerLei is not valid (ISO 17442, mod 97)");
  return {
    kind: "RD",
    currency: "IDR",
    currencyNumeric: 360,
    issuer: { name: "Bank Indonesia", lei: input.issuerLei },
    decimals: 0,
    token: { address: ethers.getAddress(token.address), domain: "zeto", tokenName: token.tokenName },
  };
}

// primaryId for the registry: ISIN for DFABI, "IDR" for RD.
export const primaryIdOf = (record: Obj): string => (record.kind === "RD" ? "IDR" : record["Security identifier and status"]["Identifier Value"]);

// Runnable self-check: `npx ts-node src/instrument.ts`.
if (require.main === module) {
  const assert = require("assert");
  assert.strictEqual(canonicalJson({ b: 1, a: [{ d: "x", c: null }] }), '{"a":[{"c":null,"d":"x"}],"b":1}');
  assert.strictEqual(dataHash({ a: 1, b: 2 }), dataHash({ b: 2, a: 1 }));
  assert.notStrictEqual(dataHash({ a: 1 }), dataHash({ a: 2 }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: 1.5 }));
  assert.ok(isValidIsin("US0378331005") && !isValidIsin("US0378331006"));
  assert.ok(isValidLei("5493ZETOTEST00000186") && !isValidLei("5493ZETOTEST00000187"));
  console.log("instrument self-check: PASS");
}
