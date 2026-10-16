// RD and DFABI instrument records for the Zeto track (spec: besu/docs/instrument-data-spec.md).
// DFABI uses only the BDT v1.2 fields the user approved (spec section "DFABI record: the BDT v1.2
// fields DFABI uses"): top-level keys are the group titles, inner keys the BDT field labels.
// RD is a short cash record.
// Only the Zeto-specific values are set here; the hash rule is shared with the stealth track:
//   dataHash = keccak256(UTF-8 bytes of canonicalJson(record)), canonical = keys sorted, no whitespace.
import { ethers } from "ethers";

export type ZetoToken = { address: string; tokenName: "Zeto_Anon" | "Zeto_AnonNullifierKyc" };
type Obj = Record<string, any>;

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

// ---- DFABI record: exactly the BDT v1.2 fields in the spec table (39 R + 11 C), nothing else ----
// Group titles and field labels are the spec's. Fields in the spec's "Not used for DFABI" list
// are not in any list below, so supplying one throws (the stealth validator is strict as well).

// Inputs the issuer must supply, per group.
const REQUIRED: Record<string, string[]> = {
  "Security identifier and status": ["Identifier Value", "Status Notes"],
  Issuer: ["Issuer LEI"],
  Amounts: ["Specified Denomination", "Final Redemption Amount", "Aggregate Nominal Amount", "Series Number", "Series Amount", "Tranche Amount"],
  "Interest & Calculations": ["Term", "Day Count Fraction", "Business Day Convention", "Maturity Date"],
  Dates: ["Issue Date", "Settlement Date"],
  "Pricing Data": ["Issue Price"],
  "Listing and Restrictions": ["Method of distribution", "Documentation Name", "Documentation Link", "Selling Restrictions"],
};
// Conditional (C) fields, present only when their condition holds. "Tranche Number" is R but
// defaults to "1": one Zeto token pair is one tranche.
const CONDITIONAL: Record<string, string[]> = {
  "Security identifier and status": ["Issue Ratings Agency", "Expected Issue Ratings Value"],
  Issuer: ["Issuer Ratings Agency", "Issuer Ratings Value", "Issuer Ratings Outlook"],
  Amounts: ["Integral Multiples", "Gross Proceeds", "Net Proceeds", "Tranche Number"],
  "Interest & Calculations": ["Accrued Interest"],
  Parties: ["Other Party Roles"],
  Dates: ["Pricing Date"],
  "Pricing Data": ["Indication Yield"],
  "Listing and Restrictions": ["Listing", "Listing Market Type", "Use of Proceeds"],
  "DLT extension": ["Role", "Fee"],
};
const INPUT_GROUPS = new Set([...Object.keys(REQUIRED), ...Object.keys(CONDITIONAL)]);

const need = (cond: unknown, what: string) => { if (!cond) throw new Error(`instrument: ${what}`); };

// Only fields the issuer may supply; anything else (derived fields, "Not used" fields) throws.
function inputs(terms: Obj, name: string): Obj {
  const g = terms[name] ?? {};
  need(typeof g === "object" && !Array.isArray(g), `terms.${name} must be an object`);
  const allowed = new Set([...(REQUIRED[name] ?? []), ...(CONDITIONAL[name] ?? [])]);
  for (const k of Object.keys(g)) need(allowed.has(k), `${name}."${k}" is not an input field (derived or not used for DFABI)`);
  for (const k of REQUIRED[name] ?? []) need(g[k] !== undefined && g[k] !== "", `${name}."${k}" is required`);
  return g;
}

// DLT extension: Besu / Private / Security, Name "Paladin zeto domain" (the spec's Zeto value),
// Identifier = chainId 1337 of this exploration, Smart Contract = the Zeto token.
export const DLT_NAME = "Paladin zeto domain";
export function dltExtension(t: ZetoToken, extra: Obj = {}): Obj {
  return {
    Type: "Hyperledger Besu",
    Accessibility: "Private",
    Name: DLT_NAME,
    Identifier: "1337",
    "Token Type": "Security",
    "Smart Contract": ethers.getAddress(t.address),
    ...extra,
  };
}

// terms = the issuer's inputs, grouped by the spec's group titles (see REQUIRED / CONDITIONAL).
// Everything else is derived here. Optional top-level terms.extensions.bi carries backend-only fields.
export function buildDfabiRecord(terms: Obj, token: ZetoToken): Obj {
  for (const k of Object.keys(terms)) need(INPUT_GROUPS.has(k) || k === "extensions" || k === "Parties", `terms."${k}" is not an input group`);
  const ident = inputs(terms, "Security identifier and status");
  const issuer = inputs(terms, "Issuer");
  const amounts = inputs(terms, "Amounts");
  const interest = inputs(terms, "Interest & Calculations");
  const parties = inputs(terms, "Parties");
  const dates = inputs(terms, "Dates");
  const pricing = inputs(terms, "Pricing Data");
  const listing = inputs(terms, "Listing and Restrictions");
  const dlt = inputs(terms, "DLT extension");
  need(isValidIsin(ident["Identifier Value"]), "Identifier Value is not a valid ISIN (ISO 6166 check digit)");
  need(isValidLei(issuer["Issuer LEI"]), "Issuer LEI is not valid (ISO 17442, mod 97)");
  need(String(interest["Maturity Date"]) > String(dates["Issue Date"]), "Maturity Date must be after Issue Date");
  need(Number.isSafeInteger(interest["Term"]) && interest["Term"] > 0, "Term must be a positive integer number of days");
  if (terms.extensions !== undefined) need(Object.keys(terms.extensions).every((k) => k === "bi"), 'extensions may only hold "bi"');

  const agent = `LEI-${issuer["Issuer LEI"]}`; // BI is Issuer, Principal Paying Agent and Calculation Agent
  return {
    kind: "DFABI",
    "Security identifier and status": { ...ident, "Identifier Type": "ISIN", "Form Note": "Registered", "DLT Bond Indicator": true },
    Issuer: { "Issuer Name": "Bank Indonesia", ...issuer },
    Amounts: { "Tranche Number": "1", ...amounts, "Calculation Amount": amounts["Specified Denomination"] },
    Currency: { "Specified Currency": "IDR", "Payment Currency": "IDR", "Settlement Currency": "IDR" },
    "Interest & Calculations": { ...interest, "Interest Type": "Zero coupon", "Term Period": "Days", "Business Days": "IDJA" },
    Parties: { ...parties, "Clearing/Settlement System": DLT_NAME, "Principal Paying Agent": agent, "Calculation Agent": agent },
    Dates: dates,
    "Pricing Data": pricing,
    "Listing and Restrictions": { ...listing, "Governing Law": "Indonesia" },
    "DLT extension": dltExtension(token, dlt),
    ...(terms.extensions ? { extensions: terms.extensions } : {}),
  };
}

// RD is cash, so BDT does not apply (spec "RD record"). Zeto has no decimals of its own: a Zeto
// amount is an integer unit and 1 unit = 1 rupiah, matching the stealth RD (decimals 0).
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
    token: ethers.getAddress(token.address),
    platform: `Hyperledger Besu, ${DLT_NAME}`,
    tokenStandard: token.tokenName,
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
  // Builders: the sample builds to exactly the 42 required labels; extra or "Not used" input throws.
  const t: ZetoToken = { address: "0x" + "ab".repeat(20), tokenName: "Zeto_Anon" };
  const terms = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "docs", "samples", "dfabi-terms.sample.json"), "utf8"));
  delete terms._note;
  const rec = buildDfabiRecord(terms, t);
  const labels = Object.entries(rec).filter(([k]) => k !== "kind").flatMap(([, g]) => Object.keys(g as Obj));
  assert.strictEqual(labels.length, 42);
  assert.strictEqual(rec["Parties"]["Clearing/Settlement System"], rec["DLT extension"]["Name"]);
  const bad = (edit: (x: Obj) => void) => { const x = JSON.parse(JSON.stringify(terms)); edit(x); return () => buildDfabiRecord(x, t); };
  assert.throws(bad((x) => (x["Interest & Calculations"]["Interest Rate"] = "3.875")), /not an input field/);
  assert.throws(bad((x) => (x["Guarantor"] = { "Guarantor Name": "X" })), /not an input group/);
  assert.throws(bad((x) => (x["Security identifier and status"]["Identifier Value"] = "IDZETOTEST12")), /valid ISIN/);
  assert.throws(bad((x) => delete x["Pricing Data"]["Issue Price"]), /required/);
  assert.throws(bad((x) => (x["Interest & Calculations"]["Maturity Date"] = "2026-10-16")), /after Issue Date/);
  assert.strictEqual(buildRdRecord({ issuerLei: "5493ZETOTEST00000283" }, t).decimals, 0);
  console.log("instrument self-check: PASS");
}
