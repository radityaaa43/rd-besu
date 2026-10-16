import { readFileSync, readdirSync } from 'node:fs';
import { encodeBytes32String, keccak256, toUtf8Bytes } from 'ethers';

// Instrument records: one generic validator driven by data.
//   catalog  besu/docs/instrument-data/bdt-v1.2.catalog.json   every BDT field (stable id, types) and the extension groups
//   profile  besu/docs/instrument-data/profiles/<KIND>.profile.json   which fields one instrument type uses, and the rules
// This file knows rule TYPES (fixed, oneOf, isin, ...), never an instrument. A new instrument type is a new profile file.
//
// Record shape (all values are strings; repeatable catalog fields are arrays of strings; absent = not applicable):
//   { schema: 'rd-dfabi-instrument/1', kind, profileVersion, bdt: { <catalog id>: value }, extensions: { <group>: { <field>: value } } }

const DATA = new URL('../../docs/instrument-data/', import.meta.url);
export const SCHEMA = 'rd-dfabi-instrument/1';

// ---------- types ----------
export type Rule = { type: string; [param: string]: unknown };
export type FieldSpec = {
  status: 'R' | 'C'; // R: always required. C: conditional (requiredIf / forbiddenIf rules; a C field without a rule is optional)
  rules: Rule[];
  count?: { min?: number; max?: number }; // for repeatable fields: how many items
  declare?: { dataType: string; repeatable?: boolean }; // an extension field the catalog does not list yet (reserved groups)
};
export type Profile = {
  kind: string;
  version: string;
  catalog?: string;
  description?: string;
  primaryId?: string; // field whose (first) value identifies the instrument on chain: a catalog id or 'extensions.<group>.<field>'
  bdt: Record<string, FieldSpec>;
  extensions: Record<string, Record<string, FieldSpec>>;
};
type CatalogField = { id: string; group: string; name: string; fieldType: string; dataType: string; repeatable: boolean };
type ExtField = { name: string; dataType: string; repeatable: boolean };
export type Catalog = {
  fields: CatalogField[];
  groups: string[];
  extensionGroups: Record<string, { description: string; fields: ExtField[] }>;
};
export type ValidateOptions = {
  context?: string[]; // named situations a rule can depend on, e.g. 'secondaryTrade'
  profiles?: Profile[]; // profiles to use besides (and before) the shipped ones, e.g. a test fixture
};

// ---------- data ----------
const readJson = (url: URL) => JSON.parse(readFileSync(url, 'utf8'));
export const catalog: Catalog = readJson(new URL('bdt-v1.2.catalog.json', DATA));
export const profiles: Record<string, Profile> = {};
const profileDir = new URL('profiles/', DATA);
for (const f of readdirSync(profileDir).filter((n) => n.endsWith('.profile.json')).sort()) {
  const p: Profile = readJson(new URL(f, profileDir));
  profiles[p.kind] = p;
}
export const loadProfile = (kind: string): Profile | undefined => profiles[kind];
const catalogById = new Map(catalog.fields.map((f) => [f.id, f]));

// ---------- checksums ----------
const expand = (s: string) => [...s].map((c) => parseInt(c, 36)).join(''); // letters A..Z -> 10..35

// ISO 6166: 2 letters, 9 alphanumerics, 1 check digit; Luhn over the expanded digits.
export function isValidIsin(s: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) return false;
  let sum = 0;
  [...expand(s)].reverse().forEach((c, i) => {
    let d = Number(c);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  });
  return sum % 10 === 0;
}

// ISO 17442: 18 alphanumerics + 2 check digits; the expanded number mod 97 must be 1.
export const isValidLei = (s: string): boolean => /^[A-Z0-9]{18}[0-9]{2}$/.test(s) && BigInt(expand(s)) % 97n === 1n;

// ISO 4217 alphabetic codes in circulation (snapshot, not fetched).
const CURRENCIES = new Set(
  ('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWG').split(' '),
);
export const isValidCurrency = (s: string): boolean => CURRENCIES.has(s);

const isDate = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

// ---------- rule types ----------
type Ctx = { path: string; rule: Rule; get: (ref: string) => string | string[] | undefined };
// A value rule returns an error text, or null when the value passes. Applied to each item of a repeatable field.
const VALUE_RULES: Record<string, (v: string, c: Ctx) => string | null> = {
  fixed: (v, { rule }) => (v === rule.value ? null : `must be "${rule.value}"`),
  oneOf: (v, { rule }) => ((rule.values as string[]).includes(v) ? null : `must be one of ${(rule.values as string[]).join(', ')}`),
  isin: (v) => (isValidIsin(v) ? null : 'is not a valid ISIN (ISO 6166 check digit)'),
  lei: (v, { rule }) => {
    const prefix = (rule.prefix as string | undefined) ?? '';
    return v.startsWith(prefix) && isValidLei(v.slice(prefix.length)) ? null : `is not a valid LEI (ISO 17442 mod-97)${prefix ? ` with prefix ${prefix}` : ''}`;
  },
  iso4217: (v, { rule }) => {
    if (!isValidCurrency(v)) return 'is not an ISO 4217 currency code';
    const only = rule.only as string[] | undefined;
    return !only || only.includes(v) ? null : `must be one of ${only.join(', ')}`;
  },
  date: (v) => (isDate(v) ? null : 'is not a YYYY-MM-DD date'),
  decimal: (v) => (/^\d+(\.\d+)?$/.test(v) ? null : 'is not a decimal string'),
  integer: (v) => (/^\d+$/.test(v) ? null : 'is not an integer string'),
  boolean: (v) => (v === 'true' || v === 'false' ? null : 'must be "true" or "false"'),
  pattern: (v, { rule }) => (new RegExp(rule.regex as string).test(v) ? null : `does not match ${rule.regex}`),
  // After another date field (strictly, or on-or-after with orEqual). Skipped when the other field is absent or not a date.
  dateAfter: (v, { rule, get }) => {
    const other = get(rule.other as string);
    if (typeof other !== 'string' || !isDate(v) || !isDate(other)) return null;
    return (rule.orEqual ? v >= other : v > other) ? null : `must be ${rule.orEqual ? 'on or after' : 'after'} ${rule.other}`;
  },
};
const PRESENCE_RULES = new Set(['requiredIf', 'forbiddenIf']);
const KNOWN_RULES = new Set([...Object.keys(VALUE_RULES), ...PRESENCE_RULES]);

// Catalog data types are checked on their own, whatever the profile says.
const IMPLICIT: Record<string, string> = { decimal: 'decimal', integer: 'integer', dateformat: 'date', date: 'date', Boolean: 'boolean', boolean: 'boolean' };

// ---------- profile checks ----------
type FieldDef = { dataType: string; repeatable: boolean };
const checked = new WeakSet<Profile>();

function extDef(profile: Profile, group: string, name: string): FieldDef {
  const spec = profile.extensions[group][name];
  const listed = catalog.extensionGroups[group]?.fields.find((f) => f.name === name);
  if (listed) return { dataType: listed.dataType, repeatable: listed.repeatable };
  if (spec.declare) return { dataType: spec.declare.dataType, repeatable: !!spec.declare.repeatable };
  throw new Error(`profile ${profile.kind}: extensions.${group}.${name} is not in the catalog and has no "declare"`);
}

function checkProfile(profile: Profile) {
  if (checked.has(profile)) return;
  const specs: [string, FieldSpec][] = [];
  for (const [id, spec] of Object.entries(profile.bdt)) {
    if (!catalogById.has(id)) throw new Error(`profile ${profile.kind}: ${id} is not a catalog id`);
    specs.push([id, spec]);
  }
  for (const [group, fields] of Object.entries(profile.extensions)) {
    for (const [name, spec] of Object.entries(fields)) {
      extDef(profile, group, name);
      specs.push([`extensions.${group}.${name}`, spec]);
    }
  }
  for (const [path, spec] of specs) {
    if (spec.status !== 'R' && spec.status !== 'C') throw new Error(`profile ${profile.kind}: ${path} status must be R or C`);
    for (const rule of spec.rules) {
      if (!KNOWN_RULES.has(rule.type)) throw new Error(`profile ${profile.kind}: ${path} has unknown rule type "${rule.type}"`);
    }
  }
  checked.add(profile);
}

// ---------- validation ----------
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function validateRecord(record: unknown, opts: ValidateOptions = {}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const done = () => ({ valid: errors.length === 0, errors });
  if (!isPlain(record)) return errors.push('record must be an object'), done();

  for (const key of Object.keys(record)) {
    if (!['_note', 'schema', 'kind', 'profileVersion', 'bdt', 'extensions'].includes(key)) errors.push(`${key} is an unknown field`);
  }
  if ('_note' in record && typeof record._note !== 'string') errors.push('_note must be a string');
  if (record.schema !== SCHEMA) errors.push(`schema must be "${SCHEMA}"`);
  if (!isText(record.kind)) return errors.push('kind is required'), done();
  const profile = opts.profiles?.find((p) => p.kind === record.kind) ?? profiles[record.kind];
  if (!profile) return errors.push(`kind "${record.kind}" has no profile`), done();
  checkProfile(profile);
  if (record.profileVersion !== profile.version) errors.push(`profileVersion must be "${profile.version}" (profile ${profile.kind})`);

  if ('bdt' in record && !isPlain(record.bdt)) errors.push('bdt must be an object');
  if ('extensions' in record && !isPlain(record.extensions)) errors.push('extensions must be an object');
  const bdt = isPlain(record.bdt) ? record.bdt : {};
  const exts = isPlain(record.extensions) ? record.extensions : {};

  // Unknown or unused fields.
  for (const id of Object.keys(bdt)) {
    if (!catalogById.has(id)) errors.push(`bdt.${id} is not a catalog field`);
    else if (!profile.bdt[id]) errors.push(`bdt.${id} is not used by profile ${profile.kind}`);
  }
  for (const [group, fields] of Object.entries(exts)) {
    if (!profile.extensions[group]) errors.push(`extensions.${group} is not declared by profile ${profile.kind}`);
    else if (!isPlain(fields)) errors.push(`extensions.${group} must be an object`);
    else for (const name of Object.keys(fields)) if (!profile.extensions[group][name]) errors.push(`extensions.${group}.${name} is not declared by profile ${profile.kind}`);
  }

  // A field reference is a catalog id or 'extensions.<group>.<field>'.
  const get = (ref: string): string | string[] | undefined => {
    const v = ref.startsWith('extensions.') ? (exts[ref.split('.')[1]] as Record<string, unknown> | undefined)?.[ref.split('.')[2]] : bdt[ref];
    return typeof v === 'string' || Array.isArray(v) ? (v as string | string[]) : undefined;
  };
  const holds = (when: Record<string, unknown>): boolean => {
    if (typeof when.context === 'string') return (opts.context ?? []).includes(when.context) === (when.active !== false);
    const v = get(when.ref as string);
    const items = v === undefined ? [] : Array.isArray(v) ? v : [v];
    if ('present' in when) return (v !== undefined) === when.present;
    if ('equals' in when) return items.includes(when.equals as string);
    if ('notEquals' in when) return !items.includes(when.notEquals as string);
    throw new Error(`profile ${profile.kind}: a "when" needs present, equals, notEquals or context`);
  };

  const fields: { path: string; ref: string; spec: FieldSpec; def: FieldDef; value: unknown }[] = [];
  for (const [id, spec] of Object.entries(profile.bdt)) {
    const c = catalogById.get(id)!;
    fields.push({ path: `bdt.${id}`, ref: id, spec, def: { dataType: c.dataType, repeatable: c.repeatable }, value: bdt[id] });
  }
  for (const [group, specs] of Object.entries(profile.extensions)) {
    for (const [name, spec] of Object.entries(specs)) {
      const g = exts[group];
      fields.push({ path: `extensions.${group}.${name}`, ref: `extensions.${group}.${name}`, spec, def: extDef(profile, group, name), value: isPlain(g) ? g[name] : undefined });
    }
  }

  for (const { path, ref, spec, def, value } of fields) {
    const presence = spec.rules.filter((r) => PRESENCE_RULES.has(r.type));
    const must = spec.status === 'R' || presence.some((r) => r.type === 'requiredIf' && holds(r.when as Record<string, unknown>));
    const mustNot = presence.some((r) => r.type === 'forbiddenIf' && holds(r.when as Record<string, unknown>));
    if (value === undefined) {
      if (must && !mustNot) errors.push(`${path} is required`);
      continue;
    }
    if (mustNot) {
      errors.push(`${path} is not allowed here`);
      continue;
    }
    // Shape: a string, or for a repeatable field a non-empty array of strings. Never numbers, booleans, null or "".
    let items: string[];
    if (def.repeatable) {
      if (!Array.isArray(value)) { errors.push(`${path} must be an array of strings`); continue; }
      if (!value.every(isText) || value.length === 0) { errors.push(`${path} must be a non-empty array of non-empty strings`); continue; }
      items = value;
      const n = items.length;
      if ((spec.count?.min !== undefined && n < spec.count.min) || (spec.count?.max !== undefined && n > spec.count.max)) {
        errors.push(`${path} must have ${spec.count.min ?? 0} to ${spec.count.max ?? 'any number of'} items, has ${n}`);
        continue;
      }
    } else {
      if (!isText(value)) { errors.push(`${path} must be a non-empty string${Array.isArray(value) ? ', not an array' : ''}`); continue; }
      items = [value];
    }
    const rules: Rule[] = [...(IMPLICIT[def.dataType] ? [{ type: IMPLICIT[def.dataType] }] : []), ...spec.rules.filter((r) => !PRESENCE_RULES.has(r.type))];
    for (const item of items) {
      for (const rule of rules) {
        const problem = VALUE_RULES[rule.type](item, { path, rule, get });
        if (problem) errors.push(`${path}: "${item}" ${problem}`);
      }
    }
  }
  return done();
}

// ---------- hash ----------
// Canonical JSON: keys sorted, no whitespace. Values must be strings, arrays, objects or null.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: number is not finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (isPlain(value)) {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: cannot encode a ${typeof value}`);
}

// keccak256 of the canonical JSON bytes (UTF-8): the dataHash stored in the InstrumentRegistry.
export const recordHash = (record: unknown): string => keccak256(toUtf8Bytes(canonicalJson(record)));

export const kindBytes32 = (kind: string): string => encodeBytes32String(kind);

// The arguments of InstrumentRegistry.register(token, kind, profileVersion, primaryId, dataHash, dataUri), minus token and uri.
// Throws on an invalid record, so an invalid record is never registered.
export function registrationArgs(record: unknown, opts: ValidateOptions = {}) {
  const { valid, errors } = validateRecord(record, opts);
  if (!valid) throw new Error('invalid instrument record: ' + errors.join('; '));
  const r = record as { kind: string; profileVersion: string };
  const profile = opts.profiles?.find((p) => p.kind === r.kind) ?? profiles[r.kind];
  if (!profile.primaryId) throw new Error(`profile ${profile.kind} has no primaryId`);
  const raw = profile.primaryId.startsWith('extensions.')
    ? (record as any).extensions?.[profile.primaryId.split('.')[1]]?.[profile.primaryId.split('.')[2]]
    : (record as any).bdt?.[profile.primaryId];
  const primaryId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof primaryId !== 'string') throw new Error(`primaryId ${profile.primaryId} is missing from the record`);
  return { kind: kindBytes32(r.kind), profileVersion: r.profileVersion, primaryId, dataHash: recordHash(record) };
}

// ---------- issue price of a discount (zero-coupon) instrument ----------
// Issue Price = R * (1 - d * t / B), in percent of the Calculation Amount, where
//   R = Final Redemption Amount (percent), d = discount rate per year = discountRateBps / 10000,
//   t = Term in days, B = day-count basis (360 or 365).
// Exact integer arithmetic, rounded half up to 6 decimals, returned as a decimal string.
export function deriveIssuePrice(p: { finalRedemptionAmount: string; discountRateBps: string; termDays: string; dayCountBasis: number }): string {
  const dec = /^(\d+)(?:\.(\d+))?$/.exec(p.finalRedemptionAmount);
  if (!dec || !/^\d+$/.test(p.discountRateBps) || !/^\d+$/.test(p.termDays) || !Number.isInteger(p.dayCountBasis) || p.dayCountBasis <= 0) {
    throw new Error('deriveIssuePrice: bad input');
  }
  const t = BigInt(p.termDays);
  const basis = BigInt(p.dayCountBasis);
  if (t === 0n) throw new Error('deriveIssuePrice: the term must be at least one day');
  const factor = 10000n * basis - BigInt(p.discountRateBps) * t; // (1 - d*t/B) * 10000 * B
  if (factor <= 0n) throw new Error('deriveIssuePrice: the discount would make the price zero or negative');
  const scale = dec[2]?.length ?? 0;
  const numerator = BigInt(dec[1] + (dec[2] ?? '')) * factor * 10n ** 6n;
  const denominator = 10000n * basis * 10n ** BigInt(scale);
  const micro = (2n * numerator + denominator) / (2n * denominator); // round half up
  return `${micro / 10n ** 6n}.${(micro % 10n ** 6n).toString().padStart(6, '0')}`;
}
