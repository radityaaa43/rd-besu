# RD and DFABI instrument data (shared by stealth and zeto)

Date: 2026-10-16. Status: approved direction, in execution.

## Why

Both tracks carry only what a token transfer needs. The stealth DFABI has a name, a symbol and a partition; the Zeto tokens have nothing but the Zeto `tokenName`. No track has the bond terms: ISIN, issuer LEI, amounts, interest, dates, parties, listing or the DLT extension. The user requires DFABI data to follow the **ICMA Bond Data Taxonomy (BDT) v1.2**. The source is `besu/docs/icma-bdt-v1.2/ICMA DATA.pdf` (Appendix 12.1, "ICMA's Bond Data Taxonomy Overview"). That file is the user's copy of ICMA material: do **not** commit it.

## Design (same in both tracks)

- **Off chain**, one JSON record per instrument holds the full data. DFABI records follow BDT v1.2 groups and field names. RD records use a short cash schema (below). A TypeScript validator per track checks each record against a JSON Schema.
- **On chain**, an `InstrumentRegistry` contract (generic: `kind` is not an enum, see the profile section) (one per network, written once) stores per token: `token` address, `kind` (`RD` or `DFABI`), `primaryId` (the ISIN for DFABI, `IDR` for RD), `dataHash` (keccak256 of the canonical JSON, i.e. keys sorted with no whitespace), `dataUri`, `registrant` and `registeredAt`.
  - It emits `InstrumentRegistered`.
  - Registration is by an allow-listed registrar: BI for RD, the bond custodian or BI for DFABI.
  - One entry per token, immutable. A correction is a new version entry (`version` counter) and never an overwrite, so the history stays auditable.
  - Instrument data is public by nature (term-sheet data). Privacy covers holdings and transfers, not the terms.
- **Stealth only:** additionally call ERC-1400 `setDocument("ICMA-BDT-v1.2", dataUri, dataHash)` on the DfabiBond, because ERC-1400 has a standard slot for it.
- **Zeto only:** register through a Paladin PUBLIC transaction to the registry. The registry is not a Zeto contract, so the v1.0.0 poison-pill (public tx to a Zeto contract) does not apply. Still wait for the receipt.

## Profile-driven, so it also works for other instruments (SBN, SRBI, sukuk, ...)

**User requirement (2026-10-16): the data model must work dynamically for other instruments**, such as SBN, SRBI and sukuk, not only DFABI. So nothing about DFABI is hard-coded in the validator or the contract:

1. **Field catalog**, `besu/docs/instrument-data/bdt-v1.2.catalog.json` (authoritative, shared, see below). It lists every BDT v1.2 field from the overview: group, exact field name, BDT field type (list / free / predefined / calendar / ID-Link) and data type (string / decimal / integer / Boolean / date). It is written once and changes only when the BDT version changes. Fields outside BDT live in named **extension groups**, also declared in the catalog, e.g. `extensions.bi` (the backend fields) and, later, `extensions.sharia` for sukuk (contract type/akad, underlying asset, sharia opinion reference). Each extension field is marked `source: "extension"`, so it is never presented as BDT.
2. **Instrument profiles**, `instrument-data/profiles/<kind>.profile.json`, one per instrument type. A profile lists the catalog fields it uses, each with status `R` (required) or `C` (conditional, with a machine-checkable condition), plus optional fixed values (e.g. Interest Type = `Zero coupon`, the currencies = `IDR`) and value rules (e.g. ISIN check digit, LEI checksum, Maturity Date > Issue Date). Catalog fields the profile does not list are not allowed for that kind.
3. **One generic validator** that reads the catalog plus the profile named by the record's `kind`. Adding a new instrument means adding a profile file and its tests, with no code change. The same validator code serves both tracks.
4. **Registry**: `kind` is a free `bytes32` / short string (e.g. `DFABI`, `SBN-FR`, `SRBI`, `SUKUK-PBS`, `RD`), not an enum, and the entry stores the `profileVersion`. New kinds then need no contract change.
5. **RD** is just another profile (`RD.profile.json`), cash rather than a bond: it uses no BDT groups, only a small `cash` extension group (currency, issuer, decimals, token, platform).

Built now: the catalog, the generic validator, the profiles `DFABI` and `RD`, and the registry. Later, each as its own task: `SBN` (fixed-rate FR series with periodic coupons, plus zero-coupon SPN), `SRBI`, and `SUKUK` (BDT fields plus `extensions.sharia`). Their R/C classification needs the user's confirmation per instrument, because the coupon, rating, listing and sharia terms differ. The DFABI table below is the content of `DFABI.profile.json`.

## Shared record shape and catalog (authoritative, lead, 2026-10-16)

**Catalog:** `besu/docs/instrument-data/bdt-v1.2.catalog.json`, written by the lead from the PDF overview. It has **125 fields in 12 groups**, and every name was checked against the PDF text. Each field has a stable `id` (snake_case of group + name), `group`, `name` (as printed), `fieldType`, `dataType` and `repeatable`. Both tracks read this one file and nobody keeps a copy. A new instrument never needs a new catalog field unless BDT itself lacks it; then the field goes into an extension group, never into the BDT part.

**Record shape** (the same in both tracks, and hashed as canonical JSON with sorted keys and no whitespace):

```json
{
  "schema": "rd-dfabi-instrument/1",
  "kind": "DFABI",
  "profileVersion": "1",
  "bdt": { "<catalog id>": "<value>", "<repeatable catalog id>": ["<value>", "..."] },
  "extensions": { "bi": {}, "cash": {}, "sharia": {}, "schedule": [], "underlying": {}, "retail": {} }
}
```

- `bdt` keys are catalog `id`s only. They are neither printed labels nor camelCase, because ids are stable when labels are reworded.
- Values are strings. Decimals are decimal strings, dates are `YYYY-MM-DD` and Booleans are `"true"`/`"false"`, so that hashing never depends on number formatting.
- Absent means "not applicable". There are no nulls and no empty strings.

**Profiles** (`instrument-data/profiles/<KIND>.profile.json`) list catalog ids with `R` or `C`, plus declarative rules. The rule types are `fixed`, `oneOf`, `isin`, `lei`, `iso4217`, `date`, `dateAfter`, `decimal`, `integer`, `boolean`, `requiredIf` and `forbiddenIf`. The validator implements only these rule types. A profile may also declare which extension groups (and their fields) it uses.

## Coverage check: can BDT v1.2 + extensions describe the other instruments?

INFERENCE, per instrument. The user must confirm each profile before it is built.

| Instrument | Covered by BDT v1.2 fields | Gap, and the extension for it |
|---|---|---|
| SBN FR (fixed coupon) | Interest Type `Fixed`, Interest Rate, Interest Payment Frequency, Interest Commencement / First / Last Interest Payment Date, Day Count Fraction, Business Day Convention, Listing, Selling Restrictions, reopenings via Outstanding Amount Before/After Increase | Full coupon schedule rows: `extensions.schedule` |
| SPN / SPN-S (zero coupon) | Same as DFABI | none |
| SBN ritel (ORI, SR, SBR, ST) | as SBN FR. SBR/ST early redemption: Optionality (Call/Put Option = put, Optional Redemption Dates/Amount, Redemption Payment Basis) | Min/max order per investor, holding period, non-tradeable flag: `extensions.retail` |
| SRBI | as DFABI (discount, BI issuer, auction, Pricing Date) | Underlying SBN reference: `extensions.underlying` |
| Sukuk (SBSN PBS/SPNS, sukuk ritel) | Amounts, Currency, Dates, Listing, Parties; return ("imbalan") through Interest Type/Rate/Frequency | Akad, underlying asset (BMN), sharia opinion reference: `extensions.sharia`. The BDT word "interest" is used for imbalan, which the profile documents. |
| RD (cash) | none, since it is not a bond | `extensions.cash` (currency, issuer, decimals, token, platform) |

Conclusion: every instrument above fits **catalog + profile + named extensions** with no validator or contract change. Only the extension group definitions (`sharia`, `schedule`, `underlying`, `retail`) are added when their profile is confirmed.

## DFABI record: the BDT v1.2 fields DFABI uses

**User decision (2026-10-16): use only the BDT v1.2 fields that apply to DFABI, not the whole taxonomy.** The schema contains exactly the fields below and is strict: an unknown field, or any field from the "Not used" list, fails validation. That way no placeholder or invented value can enter a record. Field names follow the BDT v1.2 overview exactly. The classification assumes DFABI is a zero-coupon, discount instrument issued by BI through auction, with no guarantor and no syndicate. That is inferred from the backend `seriesRegistrationFormSchema` (`discountRateBps`, `auctionType`, issuer). If a series breaks that assumption, the classification must change.

Status: **R** = required. **C** = conditional, present only when its condition holds and otherwise absent.

| BDT group | Field | Status | Value / source |
|---|---|---|---|
| Security identifier and status | Identifier Type | R | `ISIN` |
| | Identifier Value | R | ISIN with a valid ISO 6166 check digit; the backend ledger derives it from `seriesCode`. Never invented. |
| | Form of the Note | R | `Registered` (book-entry on DLT) |
| | Status of the Notes | R | input (seniority as stated in the series documentation) |
| | DLT Bond Indicator | R | `true` |
| | Issue Ratings Agency / Expected Issue Ratings Value | C | only if the series is rated |
| Issuer | Issuer Name | R | `Bank Indonesia` |
| | Issuer LEI | R | input, ISO 17442 (20 chars, mod-97 check); not hard-coded |
| | Issuer Ratings Agency / Value / Outlook | C | only if supplied |
| Amounts | Specified Denomination | R | `nominalPerUnit` |
| | Calculation Amount | R | = Specified Denomination |
| | Final Redemption Amount | R | from `redemptionPriceBps` (as % of Calculation Amount) |
| | Aggregate Nominal Amount | R | `nominalValue` |
| | Series Number | R | `seriesCode` |
| | Series Amount | R | `approvedTargetVolume` |
| | Tranche Number | R | the ERC-1400 partition (stealth) or the token set (Zeto) |
| | Tranche Amount | R | amount issued in this tranche |
| | Integral Multiples | C | only if trading is in multiples above the denomination |
| | Gross Proceeds / Net Proceeds | C | only after the auction settles |
| Currency | Specified Currency / Payment Currency / Settlement Currency | R | `IDR` (ISO 4217), all three |
| Interest & Calculations | Interest Type | R | `Zero coupon` |
| | Term | R | `tenorDays` |
| | Term Period | R | `Days` |
| | Day Count Fraction | R | `dayCountBasis`, mapped to a BDT list value |
| | Business Days | R | `IDJA` (Jakarta) |
| | Business Day Convention | R | input (BDT list value) |
| | Maturity Date | R | `maturityDate`, after Issue Date |
| | Accrued Interest | C | only on a secondary trade record |
| Parties | Clearing/Settlement System | R | the DLT platform (same value as DLT extension Name) |
| | Principal Paying Agent | R | BI (LEI as ID-Link) |
| | Calculation Agent | R | BI (LEI as ID-Link) |
| | Other Party Roles | C | the bond custodian, if separate from BI |
| Dates | Issue Date | R | `issueDate` |
| | Settlement Date | R | issue + `settlementCycleDays` |
| | Pricing Date | C | the auction date, when the series is auctioned |
| Pricing Data | Issue Price | R | derived from `discountRateBps`, `tenorDays` and `dayCountBasis`; the formula is documented and tested |
| | Indication of Yield | C | if published |
| Listing and Restrictions | Method of distribution | R | from `auctionType` |
| | Governing Law | R | `Indonesia` |
| | Documentation Name / Documentation Link | R | the series documentation |
| | Selling Restrictions | R | input (e.g. eligible participant types, per `eligiblePesertaTypes`) |
| | Listing / Listing Market Type | C | only if listed |
| | Use of Proceeds | C | if stated |
| DLT Platform Information | Type | R | `Hyperledger Besu` |
| | Accessibility | R | `Private` |
| | Name | R | stealth: `Besu stealth ERC-1400`; Zeto: `Paladin zeto domain` |
| | Identifier | R | network identifier (chainId `1337` for this exploration) |
| | Token Type | R | `Security` |
| | Smart Contract | R | the DfabiBond address (stealth) or the Zeto token address (Zeto) |
| | Role / Fee | C | if the platform operator role or a fee applies |

**Not used for DFABI** (excluded from the schema; the validator rejects them):
- **Guarantor:** the whole group (Guarantor Name, LEI, Ratings Agency/Value/Outlook).
- **Issuer:** Issuer Bloomberg Ticker.
- **Amounts:** Early Redemption Amount (no call or put).
- **Interest & Calculations:** Interest Payment Frequency, Interest Rate (zero coupon), Interest Rate Benchmark, Calculation Type, Determination Method, Observation Method, Period, Margin (%), BrokenDateType, Call/Put Option, EndDate, Yield to Call.
- **Parties:** Lead Manager, Joint Lead Managers, Joint Global Coordinators, Joint Bookrunners, Stabilisation Manager, Fiscal Agent, Trustee (no syndicate).
- **Pricing Data:** Fees, All-in Price, All-in Yield p.a., All-in Spread vs. Benchmark, Reoffer Price, Reoffer Yield p.a., Benchmark Bond Ticker / Interest Rate / Maturity Date / ISIN / Price / Yield p.a., Reoffer Spread vs. Benchmark, Mid Swap Rate, Reoffer Spread vs. Mid-Swaps, Expenses, Fee Allocation Type.
- **Listing and Restrictions:** PRIIPs Restriction (EU-only), Negative Pledge, Gross Up, Cross Default, Substitution or variation.

Backend fields with no BDT field (`cfi`, `fisn`, `eligiblePesertaTypes`, `reopeningMaximum`, `tradeable`, `exDate`, `templateId/Version`) go into an `extensions.bi` object in the same record. They are kept, not dropped.

## RD record (cash, not a bond, so BDT does not apply)

`kind: "RD"`, `currency: "IDR"` (ISO 4217, numeric 360), `issuer: { name: "Bank Indonesia", lei }`, `decimals` (stealth token: 0, whole rupiah; Zeto: the Zeto domain unit), `token` address, `platform` (`Hyperledger Besu`; plus `Paladin zeto domain` for Zeto), `tokenStandard` (`ERC-20 + ERC-5564 stealth` or `Zeto_Anon / Zeto_AnonNullifierKyc`).

## Done when (per track)

1. JSON Schemas for the DFABI (BDT v1.2) and RD records, with a validator and unit tests. Cover: a valid record passes; a bad ISIN check digit, a bad LEI checksum, a missing required group, a wrong currency, a Maturity Date before Issue Date, an unknown field, and any field from the "Not used for DFABI" list all fail; a C field without its condition fails; the canonical-JSON hash is stable.
2. `InstrumentRegistry` with tests: registrar-only, one entry per token plus versioning, and an event.
3. An E2E on the live network: register the RD and DFABI instruments, read them back, recompute `dataHash` from the JSON and match it (plus `setDocument` for stealth).
4. Sample records for one DFABI series and RD in `docs/`, with clearly fictional but valid identifiers (correct check digits) and a note that they are test data.

5. Profile-driven checks: the validator loads the catalog and profile files and contains no instrument-specific code (grep for `DFABI` in the validator source returns only test or fixture hits); a test registers a tiny fictional third profile (e.g. `TEST-FRN`, a floating-rate note using Interest Rate Benchmark and Margin) and validates a record for it with zero code changes; the registry accepts an arbitrary new `kind`.

## Implementation decisions (accepted by the lead, 2026-10-16)

- `registerVersion` must keep the same `kind` and `primaryId` as version 1 (`IdentityChanged`), so a version cannot change what the token is. A wrong ISIN at v1 cannot be corrected; the fix is a new token registration. Any allow-listed registrar may append a version (exploration setting; production would restrict this to the original registrant or BI).
- Extra rule types beyond the base list: `pattern` (regex, for addresses and links); `lei` with an optional `prefix` (`LEI-` in ID-Links); `iso4217` with optional `only[]`; `dateAfter` with optional `orEqual`; and `count {min,max}` for repeatable fields.
- A profile may `declare` an extension field that the catalog's reserved groups do not list yet. The shipped profiles do not use this.
- DFABI Pricing Date is C: forbidden unless Method of distribution = Auction, and optional when it is.
- Implementation: `besu/stealth-address/ts/instrument.ts` (validateRecord, recordHash, registrationArgs) and `src/InstrumentRegistry.sol`, commit 8a89bc3. The Zeto track imports the validator and copies the registry artifact.
