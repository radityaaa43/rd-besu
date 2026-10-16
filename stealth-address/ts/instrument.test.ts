import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  canonicalJson, catalog, deriveIssuePrice, isValidCurrency, isValidIsin, isValidLei, kindBytes32, loadProfile, profiles, recordHash,
  registrationArgs, validateRecord, type Profile,
} from './instrument.ts';

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const dfabi = () => json('../docs/samples/dfabi-bdt-v1.2.sample.json');
const rd = () => json('../docs/samples/rd.sample.json');
// Edit a record by path ('bdt.<id>', 'extensions.bi.x'); value undefined deletes the key.
function set(rec: any, path: string, value: unknown) {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce((o, k) => o[k], rec);
  if (value === undefined) delete parent[last];
  else parent[last] = value;
  return rec;
}
type Opts = Parameters<typeof validateRecord>[1];
const ok = (rec: unknown, opts?: Opts) => expect(validateRecord(rec, opts).errors).toEqual([]);
const bad = (rec: unknown, match: RegExp, opts?: Opts) => {
  const r = validateRecord(rec, opts);
  expect(r.valid).toBe(false);
  expect(r.errors.join(' | ')).toMatch(match);
};
const S = 'bdt.security_identifier_and_status_', I = 'bdt.issuer_', A = 'bdt.amounts_', C = 'bdt.currency_', IC = 'bdt.interest_calculations_';
const P = 'bdt.parties_', D = 'bdt.dates_', PR = 'bdt.pricing_data_', L = 'bdt.listing_and_restrictions_', DL = 'bdt.dlt_platform_information_';

describe('samples', () => {
  it('the DFABI sample and the RD sample are valid, and carry the TEST DATA note', () => {
    ok(dfabi());
    ok(rd());
    expect(dfabi()._note).toMatch(/TEST DATA/);
    expect(rd()._note).toMatch(/TEST DATA/);
  });
  it('the sample issue price is the derived price of its own discount rate', () => {
    const r = dfabi();
    expect(r.bdt.pricing_data_issue_price).toBe(
      deriveIssuePrice({ finalRedemptionAmount: r.bdt.amounts_final_redemption_amount, discountRateBps: r.extensions.bi.discountRateBps, termDays: r.bdt.interest_calculations_term, dayCountBasis: 360 }),
    );
  });
});

describe('checksums (public vectors, not made by this code)', () => {
  it('ISO 6166 ISIN', () => {
    for (const good of ['US0378331005', 'IDDFA0000013', 'XS2524143554', 'DE0001141869']) expect(isValidIsin(good)).toBe(true);
    for (const wrong of ['US0378331006', 'IDDFA0000012', 'us0378331005', 'US037833100', 'US03783310055', '', 'US03783310O5']) expect(isValidIsin(wrong)).toBe(false);
  });
  it('ISO 17442 LEI', () => {
    for (const good of ['HWUPKR0MPOU8FGXBT394', 'DG3RU1DBUFHT4ZF9WN62', 'TEST00FICTIVE0000145']) expect(isValidLei(good)).toBe(true);
    for (const wrong of ['HWUPKR0MPOU8FGXBT395', 'DG3RU1DBUFHT4ZF9WN63', 'hwupkr0mpou8fgxbt394', 'HWUPKR0MPOU8FGXBT39', '']) expect(isValidLei(wrong)).toBe(false);
  });
  it('ISO 4217 currency', () => {
    for (const good of ['IDR', 'USD', 'EUR']) expect(isValidCurrency(good)).toBe(true);
    for (const wrong of ['ZZZ', 'idr', 'ID', '']) expect(isValidCurrency(wrong)).toBe(false);
  });
  it('a record with a bad ISIN or LEI fails', () => {
    bad(set(dfabi(), S + 'identifier_value', ['IDDFA0000012']), /identifier_value.*ISIN/);
    bad(set(dfabi(), I + 'issuer_lei', 'TEST00FICTIVE0000146'), /issuer_lei.*LEI/);
    bad(set(dfabi(), P + 'principal_paying_agent', 'LEI-TEST00FICTIVE0000146'), /principal_paying_agent/);
    bad(set(dfabi(), P + 'calculation_agent', 'TEST00FICTIVE0000145'), /calculation_agent/); // no LEI- ID-Link prefix
    bad(set(rd(), 'extensions.cash.issuerLei', 'TEST00FICTIVE0000146'), /issuerLei.*LEI/);
  });
});

describe('catalog (written by the lead) and profiles are data', () => {
  it('the catalog has 125 fields in 12 groups, unique ids, each with a type', () => {
    expect(catalog.fields.length).toBe(125);
    expect(catalog.groups.length).toBe(12);
    expect(new Set(catalog.fields.map((f) => f.id)).size).toBe(125);
  });
  it('the DFABI profile has 42 required fields (39 table rows) and 17 conditional fields (11 rows)', () => {
    const p = loadProfile('DFABI')!;
    const fields = Object.values(p.bdt);
    expect(fields.filter((f) => f.status === 'R').length).toBe(42);
    expect(fields.filter((f) => f.status === 'C').length).toBe(17);
  });
  it('profiles load by kind; RD uses no BDT field', () => {
    expect(Object.keys(profiles).sort()).toEqual(['DFABI', 'RD']);
    expect(Object.keys(loadProfile('RD')!.bdt)).toEqual([]);
    expect(loadProfile('NOPE')).toBeUndefined();
  });
  it('every id a shipped profile names exists in the catalog, and every rule type is one the validator knows', () => {
    const ids = new Set(catalog.fields.map((f) => f.id));
    for (const p of Object.values(profiles)) for (const id of Object.keys(p.bdt)) expect(ids.has(id)).toBe(true);
  });
  it('a profile that names a field the catalog does not have, or an unknown rule type, is refused when used', () => {
    const wrongId: Profile = { kind: 'X1', version: '1', bdt: { issuer_nope: { status: 'R', rules: [] } }, extensions: {} };
    expect(() => validateRecord({ schema: 'rd-dfabi-instrument/1', kind: 'X1', profileVersion: '1' }, { profiles: [wrongId] })).toThrow(/issuer_nope/);
    const wrongRule: Profile = { kind: 'X2', version: '1', bdt: { issuer_issuer_name: { status: 'R', rules: [{ type: 'magic' }] } }, extensions: {} };
    expect(() => validateRecord({ schema: 'rd-dfabi-instrument/1', kind: 'X2', profileVersion: '1' }, { profiles: [wrongRule] })).toThrow(/magic/);
  });
  it('the validator source holds no instrument name (profiles are data)', () => {
    const src = readFileSync(new URL('./instrument.ts', import.meta.url), 'utf8');
    for (const word of ['DFABI', 'Bank Indonesia', 'IDDFA', 'SRBI', 'SBN', 'TEST-FRN', 'Act/360', 'Zero coupon']) expect(src).not.toContain(word);
  });
});

describe('envelope', () => {
  it('schema, kind and profileVersion are required; the version must match the profile', () => {
    bad(set(dfabi(), 'schema', undefined), /schema/);
    bad(set(dfabi(), 'schema', 'rd-dfabi-instrument/2'), /schema/);
    bad(set(dfabi(), 'kind', undefined), /kind/);
    bad(set(dfabi(), 'kind', 'BOND'), /kind.*no profile/);
    bad(set(dfabi(), 'profileVersion', undefined), /profileVersion/);
    bad(set(dfabi(), 'profileVersion', '2'), /profileVersion/);
    bad(set(dfabi(), 'profileVersion', 1), /profileVersion/);
  });
  it('rejects non-objects', () => {
    for (const v of [null, 1, 'x', [], {}, undefined]) expect(validateRecord(v).valid).toBe(false);
  });
  it('_note is allowed and must be a string; any other top-level key is unknown', () => {
    ok(set(dfabi(), '_note', 'another note'));
    bad(set(dfabi(), '_note', 5), /_note/);
    bad(set(dfabi(), 'colour', 'red'), /colour/);
  });
  it('bdt may be absent for a profile with no required BDT field; extensions must be an object', () => {
    ok(set(rd(), 'bdt', undefined));
    bad(set(rd(), 'bdt', []), /bdt must be an object/);
    bad(set(rd(), 'extensions', []), /extensions must be an object/);
  });
});

describe('values are strings, repeatable fields are arrays', () => {
  it('numbers, booleans, nulls and empty strings are refused everywhere', () => {
    for (const v of [5, true, null, '', {}]) {
      bad(set(dfabi(), A + 'series_number', v), /series_number/);
      bad(set(dfabi(), 'extensions.bi.seriesId', v), /seriesId/);
    }
  });
  it('a repeatable field must be a non-empty array of strings and a plain field must not be an array', () => {
    bad(set(dfabi(), L + 'selling_restrictions', 'Eligible'), /selling_restrictions.*array/);
    bad(set(dfabi(), L + 'selling_restrictions', []), /selling_restrictions/);
    bad(set(dfabi(), L + 'selling_restrictions', ['ok', '']), /selling_restrictions/);
    bad(set(dfabi(), A + 'series_number', ['IDDFA031126091S']), /series_number.*array/);
    ok(set(dfabi(), L + 'selling_restrictions', ['one', 'two']));
  });
  it('identifier type and value are one pair (count 1..1), each item checked', () => {
    bad(set(dfabi(), S + 'identifier_type', ['ISIN', 'ISIN']), /identifier_type/);
    bad(set(dfabi(), S + 'identifier_value', ['IDDFA0000013', 'XS2524143554']), /identifier_value/);
    bad(set(dfabi(), S + 'identifier_type', ['SEDOL']), /identifier_type/);
  });
});

describe('required fields and groups', () => {
  it('every required field, removed alone, fails and names that field', () => {
    for (const [id, f] of Object.entries(loadProfile('DFABI')!.bdt)) {
      if (f.status !== 'R') continue;
      bad(set(dfabi(), 'bdt.' + id, undefined), new RegExp(`bdt\\.${id} is required`));
    }
    for (const [name, f] of Object.entries(loadProfile('RD')!.extensions.cash)) {
      if (f.status === 'R') bad(set(rd(), 'extensions.cash.' + name, undefined), new RegExp(`extensions\\.cash\\.${name} is required`));
    }
  });
  it('a missing bdt object or extension group fails', () => {
    bad(set(dfabi(), 'bdt', undefined), /issuer_issuer_lei is required/);
    bad(set(rd(), 'extensions', undefined), /extensions\.cash\.currency is required/);
    bad(set(rd(), 'extensions.cash', undefined), /extensions\.cash\.currency is required/);
  });
});

describe('fixed values and value rules', () => {
  it('currency must be IDR in all three fields, and an ISO 4217 code at all', () => {
    for (const f of ['specified_currency', 'payment_currency', 'settlement_currency']) {
      bad(set(dfabi(), C + f, 'USD'), new RegExp(f));
      bad(set(dfabi(), C + f, 'ZZZ'), new RegExp(f));
    }
    bad(set(rd(), 'extensions.cash.currency', 'USD'), /currency/);
  });
  it('fixed and oneOf values', () => {
    const cases: [string, unknown][] = [
      [S + 'form_of_the_note', 'Bearer'], [S + 'dlt_bond_indicator', 'false'], [I + 'issuer_name', 'Another Bank'], [IC + 'interest_type', 'Fixed'],
      [IC + 'term_period', 'MNTH'], [IC + 'business_days', 'TARGET2'], [IC + 'day_count_fraction', '30/360'], [L + 'governing_law', 'Luxembourg Law'],
      [DL + 'type', 'Ethereum'], [DL + 'accessibility', 'Public'], [DL + 'token_type', 'CBDC'], [DL + 'name', 'Something else'],
    ];
    for (const [path, value] of cases) bad(set(dfabi(), path, value), new RegExp(path.slice(4)));
  });
  it('patterns: contract address and document link', () => {
    bad(set(dfabi(), DL + 'smart_contract', '0x1234'), /smart_contract/);
    bad(set(dfabi(), L + 'documentation_link', 'ftp://x'), /documentation_link/);
    bad(set(rd(), 'extensions.cash.token', '0x1234'), /token/);
  });
  it('catalog data types apply on their own: decimal, integer, date, Boolean', () => {
    for (const v of ['1,000,000', '-5', '1e6', '1.', '.5', ' 1', 'abc']) bad(set(dfabi(), A + 'specified_denomination', v), /specified_denomination/);
    ok(set(dfabi(), A + 'final_redemption_amount', '100.5'));
    for (const v of ['9.1', '-1', 'x', '1e2']) bad(set(dfabi(), IC + 'term', v), /calculations_term/);
    bad(set(dfabi(), DL + 'identifier', 'chain'), /identifier/);
    bad(set(dfabi(), 'extensions.bi.tradeable', 'yes'), /tradeable/);
    ok(set(dfabi(), 'extensions.bi.tradeable', 'false'));
    bad(set(dfabi(), 'extensions.bi.discountRateBps', '5.75'), /discountRateBps/); // integer basis points
    bad(set(dfabi(), 'extensions.bi.exDate', '0'), /exDate/); // a date
    ok(set(dfabi(), 'extensions.bi.exDate', '2027-01-01'));
  });
  it('RD cash fields', () => {
    ok(set(set(set(rd(), 'extensions.cash.platform', ['Hyperledger Besu', 'Paladin zeto domain']), 'extensions.cash.tokenStandard', 'Zeto_AnonNullifierKyc'), 'extensions.cash.decimals', '2'));
    bad(set(rd(), 'extensions.cash.issuerName', 'Other Bank'), /issuerName/);
    for (const v of ['-1', '0.5', 'x']) bad(set(rd(), 'extensions.cash.decimals', v), /decimals/);
    for (const v of [[], ['Ethereum'], 'Hyperledger Besu']) bad(set(rd(), 'extensions.cash.platform', v), /platform/);
    bad(set(rd(), 'extensions.cash.tokenStandard', 'ERC-721'), /tokenStandard/);
  });
});

describe('dates', () => {
  it('a Maturity Date on or before the Issue Date fails', () => {
    bad(set(dfabi(), IC + 'maturity_date', '2026-11-03'), /maturity_date/);
    bad(set(dfabi(), IC + 'maturity_date', '2026-10-01'), /maturity_date/);
    ok(set(dfabi(), IC + 'maturity_date', '2026-11-04'));
  });
  it('settlement before issue and issue before pricing fail; settlement on the issue date is fine', () => {
    bad(set(dfabi(), D + 'settlement_date', '2026-11-02'), /settlement_date/);
    ok(set(dfabi(), D + 'settlement_date', '2026-11-03'));
    bad(set(dfabi(), D + 'pricing_date', '2026-11-04'), /issue_date/);
    ok(set(dfabi(), D + 'pricing_date', '2026-11-03'));
  });
  it('impossible and badly formatted dates fail; leap days are real dates', () => {
    for (const d of ['2026-02-30', '2026-13-01', '03-11-2026', '2026-11-3', '2026-11-03T00:00:00Z', '20261103']) bad(set(dfabi(), D + 'issue_date', d), /issue_date/);
    const leap = set(set(set(dfabi(), D + 'issue_date', '2028-02-29'), D + 'settlement_date', '2028-03-01'), D + 'pricing_date', '2028-02-28');
    ok(set(leap, IC + 'maturity_date', '2029-02-02'));
    bad(set(dfabi(), D + 'issue_date', '2027-02-29'), /issue_date/);
  });
});

describe('strict: unknown fields, and every BDT field the profile does not list', () => {
  it('an unknown field fails at every level', () => {
    bad(set(dfabi(), 'bdt.not_a_catalog_id', 'x'), /not_a_catalog_id.*catalog/);
    bad(set(dfabi(), 'extensions.other', {}), /extensions\.other/);
    bad(set(dfabi(), 'extensions.bi.mystery', 'x'), /extensions\.bi\.mystery/);
    bad(set(dfabi(), 'extensions.bi.symbol', 'DFB1'), /extensions\.bi\.symbol/); // not in the catalog's bi list
    bad(set(rd(), 'extensions.cash.nickname', 'x'), /nickname/);
  });
  it('every catalog field the DFABI profile does not list is rejected as "not used by profile"', () => {
    const p = loadProfile('DFABI')!;
    let checked = 0;
    for (const f of catalog.fields) {
      if (p.bdt[f.id]) continue;
      bad(set(dfabi(), 'bdt.' + f.id, f.repeatable ? ['1'] : '1'), new RegExp(`bdt\\.${f.id} is not used by profile DFABI`));
      checked++;
    }
    expect(checked).toBe(125 - 59);
    for (const id of ['guarantor_guarantor_name', 'issuer_issuer_bloomberg_ticker', 'amounts_early_redemption_amount', 'interest_calculations_interest_rate', 'interest_calculations_margin',
      'optionality_call_put_option', 'parties_trustee', 'pricing_data_all_in_price', 'pricing_data_mid_swap_rate', 'listing_and_restrictions_prohibition_of_sales_to_uk_eea_retail_investors_priips_restriction']) {
      expect(p.bdt[id], id).toBeUndefined();
    }
  });
  it('every catalog field is rejected in an RD record', () => {
    for (const f of catalog.fields) bad(set(rd(), 'bdt', { [f.id]: f.repeatable ? ['1'] : '1' }), new RegExp(`bdt\\.${f.id} is not used by profile RD`));
  });
});

describe('conditional (C) fields', () => {
  it('ratings come as a pair (agency + value); an outlook needs the agency', () => {
    ok(set(set(dfabi(), S + 'issue_ratings_agency', ['Fitch']), S + 'expected_issue_ratings_value', ['AA']));
    bad(set(dfabi(), S + 'issue_ratings_agency', ['Fitch']), /expected_issue_ratings_value is required/);
    bad(set(dfabi(), S + 'expected_issue_ratings_value', ['AA']), /issue_ratings_agency is required/);
    ok(set(set(set(dfabi(), I + 'issuer_ratings_agency', ['Fitch']), I + 'issuer_ratings_value', ['BBB']), I + 'issuer_ratings_outlook', ['Stable']));
    bad(set(dfabi(), I + 'issuer_ratings_agency', ['Fitch']), /issuer_ratings_value is required/);
    bad(set(dfabi(), I + 'issuer_ratings_outlook', ['Stable']), /issuer_ratings_outlook is not allowed/);
  });
  it('gross and net proceeds only once the series has a pricing date (an auction)', () => {
    ok(set(set(dfabi(), A + 'gross_proceeds', '492732640000'), A + 'net_proceeds', '492000000000'));
    for (const f of ['gross_proceeds', 'net_proceeds']) {
      const rec = set(set(dfabi(), L + 'method_of_distribution', 'Private placement'), D + 'pricing_date', undefined);
      bad(set(rec, A + f, '1'), new RegExp(`${f} is not allowed`));
      bad(set(set(dfabi(), D + 'pricing_date', undefined), A + f, '1'), new RegExp(`${f} is not allowed`)); // Auction but no pricing date yet
    }
  });
  it('accrued interest only on a secondary trade record (context)', () => {
    bad(set(dfabi(), IC + 'accrued_interest', '10'), /accrued_interest is not allowed/);
    ok(set(dfabi(), IC + 'accrued_interest', '10'), { context: ['secondaryTrade'] });
  });
  it('pricing date only when the series is auctioned (allowed then, not required)', () => {
    ok(set(dfabi(), D + 'pricing_date', undefined));
    bad(set(dfabi(), L + 'method_of_distribution', 'Private placement'), /pricing_date is not allowed/);
    ok(set(set(dfabi(), L + 'method_of_distribution', 'Private placement'), D + 'pricing_date', undefined));
  });
  it('listing and listing market type come together', () => {
    ok(set(set(dfabi(), L + 'listing', ['Indonesia Stock Exchange']), L + 'listing_market_type', 'RMKT'));
    bad(set(dfabi(), L + 'listing', ['Indonesia Stock Exchange']), /listing_market_type is required/);
    bad(set(dfabi(), L + 'listing_market_type', 'RMKT'), /listing is required/);
  });
  it('other party roles: LEI ID-Links, repeatable', () => {
    ok(set(dfabi(), P + 'other_party_roles', ['LEI-TEST00FICTIVE0000242', 'LEI-TEST00FICTIVE0000145']));
    for (const v of [[], ['LEI-TEST00FICTIVE0000243'], ['TEST00FICTIVE0000242'], 'LEI-TEST00FICTIVE0000242']) bad(set(dfabi(), P + 'other_party_roles', v), /other_party_roles/);
  });
  it('optional fields are valid when present', () => {
    ok(set(dfabi(), PR + 'indication_of_yield', '5.9'));
    ok(set(dfabi(), A + 'integral_multiples', '1000'));
    ok(set(dfabi(), L + 'use_of_proceeds', 'General purposes'));
    ok(set(set(dfabi(), DL + 'role', 'Notary'), DL + 'fee', 'None'));
    bad(set(dfabi(), PR + 'indication_of_yield', 'high'), /indication_of_yield/);
  });
});

describe('a new instrument type is data only (zero code change)', () => {
  const frnProfile = json('./fixtures/TEST-FRN.profile.json') as Profile;
  const frn = () => json('./fixtures/TEST-FRN.record.json');
  const o = { profiles: [frnProfile] };
  it('a fictional floating-rate profile (Interest Rate Benchmark + Margin) validates a record with the unchanged validator', () => {
    expect(loadProfile('TEST-FRN')).toBeUndefined(); // not shipped with the repo
    ok(frn(), o);
  });
  it('and enforces its own rules: benchmark list, margin required, fixed Floating, maturity after issue, and BDT fields it does not list', () => {
    bad(set(frn(), IC + 'interest_rate_benchmark', 'LIBOR'), /interest_rate_benchmark/, o);
    bad(set(frn(), IC + 'margin', undefined), /margin is required/, o);
    bad(set(frn(), IC + 'interest_type', 'Zero coupon'), /interest_type/, o);
    bad(set(frn(), IC + 'maturity_date', '2026-01-15'), /maturity_date/, o);
    bad(set(frn(), A + 'calculation_amount', '1'), /amounts_calculation_amount is not used by profile TEST-FRN/, o);
    ok(set(frn(), D + 'pricing_date', '2026-01-10'), o);
  });
  it('the same FRN fields are rejected by the DFABI profile', () => {
    bad(set(dfabi(), IC + 'interest_rate_benchmark', 'SOFR'), /interest_rate_benchmark is not used by profile DFABI/);
    bad(set(dfabi(), IC + 'margin', '1.25'), /margin is not used by profile DFABI/);
  });
  it('an extension group declared by a profile is accepted, one it does not declare is refused', () => {
    const withExt: Profile = { ...frnProfile, kind: 'TEST-EXT', extensions: { sharia: { akad: { status: 'R', declare: { dataType: 'string' }, rules: [{ type: 'oneOf', values: ['ijarah', 'wakalah'] }] } } } };
    const rec = set(set(frn(), 'kind', 'TEST-EXT'), 'extensions', { sharia: { akad: 'ijarah' } });
    ok(rec, { profiles: [withExt] });
    bad(set(frn(), 'kind', 'TEST-EXT'), /extensions\.sharia\.akad is required/, { profiles: [withExt] });
    bad(set(set(frn(), 'kind', 'TEST-EXT'), 'extensions', { sharia: { akad: 'murabaha' } }), /akad/, { profiles: [withExt] });
  });
  it('registration args come from the profile: kind as bytes32, profile version, primary id, data hash', () => {
    const a = registrationArgs(dfabi());
    expect(a.kind).toBe(kindBytes32('DFABI'));
    expect(a.kind).toBe('0x4446414249' + '00'.repeat(27));
    expect(a.profileVersion).toBe('1');
    expect(a.primaryId).toBe('IDDFA0000013'); // first item of the repeatable identifier value
    expect(a.dataHash).toBe(recordHash(dfabi()));
    expect(registrationArgs(rd()).primaryId).toBe('IDR');
    const f = registrationArgs(frn(), o);
    expect(f.kind).toBe(kindBytes32('TEST-FRN'));
    expect(f.primaryId).toBe('IDDFA0000013');
    expect(() => registrationArgs(set(dfabi(), I + 'issuer_lei', 'X'))).toThrow(/issuer_lei/); // never registers an invalid record
    expect(() => kindBytes32('x'.repeat(32))).toThrow();
  });
});

describe('issue price derivation: P = R * (1 - d * t / B)', () => {
  // R: Final Redemption Amount in percent of the Calculation Amount; d = discountRateBps / 10000 per year;
  // t = Term in days; B = day-count basis (360 or 365). Exact integer arithmetic, rounded half up to 6 decimals.
  it('matches hand-computed vectors', () => {
    expect(deriveIssuePrice({ finalRedemptionAmount: '100', discountRateBps: '500', termDays: '91', dayCountBasis: 360 })).toBe('98.736111');
    expect(deriveIssuePrice({ finalRedemptionAmount: '100', discountRateBps: '575', termDays: '91', dayCountBasis: 360 })).toBe('98.546528');
    expect(deriveIssuePrice({ finalRedemptionAmount: '100', discountRateBps: '600', termDays: '182', dayCountBasis: 365 })).toBe('97.008219');
    expect(deriveIssuePrice({ finalRedemptionAmount: '99.5', discountRateBps: '0', termDays: '30', dayCountBasis: 360 })).toBe('99.500000');
    expect(deriveIssuePrice({ finalRedemptionAmount: '100', discountRateBps: '1', termDays: '1', dayCountBasis: 360 })).toBe('99.999972');
  });
  it('rounds half up and refuses nonsense', () => {
    // 0.000005 * (1 - 0.0001/360) = 0.00000499999861 -> 0.000005 ; 0.000004 * ... -> 0.000004
    expect(deriveIssuePrice({ finalRedemptionAmount: '0.000005', discountRateBps: '1', termDays: '1', dayCountBasis: 360 })).toBe('0.000005');
    // exactly half: R = 0.0000005, no discount -> rounds up to 0.000001
    expect(deriveIssuePrice({ finalRedemptionAmount: '0.0000005', discountRateBps: '0', termDays: '1', dayCountBasis: 360 })).toBe('0.000001');
    expect(deriveIssuePrice({ finalRedemptionAmount: '0.0000004', discountRateBps: '0', termDays: '1', dayCountBasis: 360 })).toBe('0.000000');
    for (const bad of [{ termDays: '0' }, { dayCountBasis: 0 }, { discountRateBps: '-1' }, { discountRateBps: '99999999' }, { finalRedemptionAmount: '1e2' }, { termDays: '1.5' }]) {
      expect(() => deriveIssuePrice({ finalRedemptionAmount: '100', discountRateBps: '500', termDays: '91', dayCountBasis: 360, ...bad })).toThrow();
    }
  });
});

describe('canonical JSON and the data hash', () => {
  it('sorts keys, no whitespace, keeps array order and unicode', () => {
    expect(canonicalJson({ b: '1', a: { d: ['3', '1', '2'], c: null }, e: 'ü"\n' })).toBe('{"a":{"c":null,"d":["3","1","2"]},"b":"1","e":"ü\\"\\n"}');
    expect(canonicalJson([{ z: '1', y: '2' }])).toBe('[{"y":"2","z":"1"}]');
  });
  it('is stable under key order and changes with any value', () => {
    const a = dfabi();
    const reverseKeys = (v: any): any =>
      Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, reverseKeys(v[k])])) : v;
    const shuffled = reverseKeys(a);
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(a));
    expect(canonicalJson(shuffled)).toBe(canonicalJson(a));
    expect(recordHash(shuffled)).toBe(recordHash(a));
    expect(recordHash(set(dfabi(), A + 'tranche_amount', '500000000001'))).not.toBe(recordHash(a));
  });
  it('equals an independent keccak256 of the canonical bytes (@noble/hashes)', () => {
    for (const rec of [dfabi(), rd()]) expect(recordHash(rec)).toBe('0x' + bytesToHex(keccak_256(utf8ToBytes(canonicalJson(rec)))));
  });
  it('refuses values JSON cannot carry deterministically', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(canonicalJson({ a: undefined, b: '1' })).toBe('{"b":"1"}'); // dropped like JSON.stringify
  });
});
