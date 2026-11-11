# OPA gateway for Paladin + Besu (Zeto first)

Each bank runs its own gateway `bank-gw-N`: one pod with Envoy and OPA (`ext_authz`) in front of the bank's
Paladin RPC (`:8548`) and Besu RPC (`:8545`). OPA loads two bundles and a Paladin request passes only when both allow:

- `bundles/bi`: BI's rules, the same for every bank (entrypoint `gw/allow`, Zeto, Atom, Besu methods, log mask, OPA API lock).
- `bundles/bank`: each bank's own rules, code only (here: Zeto outputs only to its counterparties). The bank's data is a `seeds/bank-*.json` document.
- `seeds/`: first version of each editable document: `bi.json` (limits, hours, holidays, frozen) and `bank-a`, `bank-b`, `bank-c`, `bank-bi` (counterparties). Each file holds one document per platform, `{"zeto": {...}, "noto": {...}}`.

**Document model:** each platform (Zeto, Noto with Pente) has its own policy. BI has one document per platform (`data.bi.config.policy.zeto|noto`) and each bank has one document per platform (`data.bank.config.policy.zeto|noto`), each with its own version, draft and approval. The structural keys (`nodes`, `participants`, contracts, groups, factories, `paladin`, `besu`) stay in `bundles/bi/bi/config/data.json`. The gateways still load the same two bundles, `bi` (roots `gw`, `bi`, `system`) and `bank` (root `bank`). A Zeto rule reads only `policy.zeto`, a Noto rule only `policy.noto`, so a freeze, closed hours, a removed counterparty or a daily limit on one platform never touches the other. Atom (public) and Pente rules have no per-platform values. Helpers: `bi.clock.token_open(platform, token)`, `bi.ident.frozen_nodes(platform)`.

```
Lensa ──pf──▶ bank-gw-N ─ Envoy :8548 ─ext_authz(target=paladin)─▶ paladin-nodeN:8548
                        ─ Envoy :8545 ─ext_authz(target=besu)────▶ besu-node-validator-N:8545
paladin-nodeN ──direct──▶ besu-node-validator-N   (not through the gateway)

bank-gw-N OPA ──poll 5-15 s──▶ bundle-server :80  /N/bi.tar.gz, /N/bank.tar.gz   (nginx; ConfigMap bank-gw-N-bundles)
              ──decision logs, bundle status──▶ bundle-server :8081  (sink: logs to stdout, last status per gateway)
Lensa Publisher ── kubectl apply ConfigMap bank-gw-N-bundles ──▶ (no restart) ── reads the sink status until the new revision shows
```

The gateway does not read bundle files any more: its OPA pulls **signed** bundles from `bundle-server` (ns `paladin`, no PVC) and activates a
bundle only when its signature verifies. Keys are per owner (`keys.sh`): `bi.tar.gz` must verify with BI's key (`bi`), and `bank.tar.gz`
with the key of that gateway's bank (`bank-a|b|c`; node 1's bank bundle is BI's, key `bi`). The OPA ConfigMap holds all four public keys, but
each gateway pins the key per bundle (`--set=bundles.bank.signing.keyid=...` in `k8s/bank-gw-N.yaml`), so a bank's key cannot sign another bank's
bundle, and an unsigned or wrongly signed bundle keeps the old one running. Private keys live outside the repo (`OPA_KEYS_DIR`, default `~/.opa-keys`, mode 600).

## What the rules cover

| Door | Allowed | Notes |
|---|---|---|
| Paladin | reads from `bi/config/data.json` `paladin.read_methods` | any other method is denied (`keymgr_sign`, `pstate_storeState`, batches, ...) |
| Paladin, Zeto | a private tx is Zeto when `domain` is `zeto` or `to` is an RD/DFABI contract in `zeto.contracts` (the SDK sends writes without `domain`; only deploys carry it). `mint` (issuer node only), `transfer`, `createLock`, `spendLock`, `delegateLock`, `cancelLock` on the RD/DFABI contracts; `from` must be the node's own identity | outputs to the 4 participants, amount > 0; transfers and locks capped per tx (sum) |
| Paladin, public | `create` on the Zeto/Noto Atom factories; `execute`/`cancel` on any other address; `delegateLock` on an RD/DFABI Zeto contract from the node's own identity | an Atom's address is known only on chain; Zeto V1 hands a DvP lock to the Atom with a public `delegateLock` (paladin-sdk `delegateLockV1`), never blocked, like the private DvP-finishing calls |
| Paladin, Zeto, limits | BI: `max_per_tx`, `max_mint_per_tx`, `hours` per token, `holidays`, `frozen`; bank: `max_per_tx`, `hours`, `daily_limit` (never looser than BI) | Values are read from the Zeto document (`policy.zeto`) of BI and of the bank; the daily limit asks the bank's own Paladin node for today's total with one query (`ptx_queryTransactionsFull`, domain `zeto`, `created` from 00:00 WIB as UTC, no `from` filter), counting Zeto `transfer` and `createLock`, `http.send` timeout 2s, fails closed (no answer, a JSON-RPC error, non-200 or a full page of 1000 denies); counted on submit and without a lock |
| Identities | compared by node (`name@node`, exactly one `@`, both parts non-empty) | a bank is its node: `stress-n2-00@node2` is bank A; freezing `bankC@node4` freezes every `*@node4`; counterparties and participants match by node |
| Paladin, reports | `pgroup_sendMessage` topic `zeto-report-v1` on the node's own {bank, BI} group | |
| Paladin, Noto | a private tx is Noto when `domain` is `noto` or `to` is in `noto.contracts` (Zeto wins if both). `mint` (issuer node only), `burn` (issuer node only, its own holdings: token open, 0 < amount <= `max_mint_per_tx`; a bank's burn is denied), `transfer` ({to, amount}), `lock` ({amount}), `prepareUnlock` (recipients), `delegateLock`; `from` must be the node's own identity; anything else (`burnFrom`, `transferFrom`, deploys, unknown contract) is denied | its own policy documents (`policy.noto` of BI and of the bank: caps `max_per_tx`/`max_mint_per_tx`, hours, holidays, frozen, the bank's counterparties, `max_per_tx`, `daily_limit`), independent of Zeto's; `lock` and `prepareUnlock` need both tokens open; a `prepareUnlock` whose recipients are only the sender (DvP rollback) and `delegateLock` are never blocked; the daily limit is the bank's Noto one: one query for domain `noto`, counting Noto `transfer` and `prepareUnlock` except rollbacks, Zeto spend does not count; a burn sends nothing out, so no bank rule applies to it |
| Paladin, Noto, balances | BI: optional `max_balance`, `min_balance`, `max_supply` per token in `policy.noto` (absent = no check) | `bundles/bi/bi/noto/balance.rego` (`bi.balance`, last in `gw/allow`). Node1 is the Noto notary and sees every state, so a gateway asks it with `http.send` (`ptx_call` `balanceOf` from BI's identity; supply = sum of confirmed `NotoCoin` and `NotoLockedCoin` states), timeout 2s, fails closed. Gateways 2-4 reach node1:8548 only through the `bank-gw` rule in `k8s/networkpolicy.yaml`. Counted at check time, no lock; in-flight txs are not counted |
| Paladin, Pente | `pgroup_sendTransaction` only into a group in `pente.groups` (the Noto hooks' cash and issuer-custodian groups) | membership itself is Paladin's; any other private domain is denied |
| Paladin, Noto deploy | issuer node only (`bi.notosetup`): `pgroup_createGroup` (pente, all members on the node), `pgroup_sendTransaction` deploy into a group (no `to`, constructor + bytecode), `ptx_sendTransaction` private Noto deploy (`notaryMode` hooks, notary on the node), public deploy (no `to`, bytecode) | what `bootstrap-noto` needs before `data.json` knows the new contracts; after the deploys its mint/lock/... hit unknown contracts and stay denied. `bootstrap-noto` rewrites `noto.contracts`, `pente.groups` and the Noto atom factory in `data.json` (commit it, BI republishes); Noto health in Lensa is not ready while the loaded addresses are not in `data.json` |
| Besu | method allowlist, every call in a batch | `admin_*`, `qbft_*`, `perm_*`, `debug_*`, `txpool_*` denied |

Not covered: the duty to report to BI after a bank-to-bank transfer (BI's reconciliation flags `unreported`),
and whether `delegateLock` hands a lock to a legitimate Atom.

**Placeholders:** `max_per_tx` (`RD: 1000000000`, `DFABI: 1000`) in `seeds/bi.json` until BI sets the real limits.

## Lensa: Halaman Kebijakan

Lensa edits the documents (BI's `bi`, each bank's `bank-a|b|c`, one per platform) on the screen **Kebijakan**
(`/besu/zeto/kebijakan`, `/besu/noto/kebijakan`, `/fabricx/kebijakan`, `/iroha3/kebijakan`: each registered platform has its own policy; disabled with a reason on Stealth, which has none). Fabric-X and Iroha 3 are registered but not enforced yet: their documents can be drafted, approved and published, but no gateway reads them (the screen says so). A change is drafted by one
person, approved by a different one, then published to the gateways. Design: `docs/superpowers/specs/2026-11-05-halaman-kebijakan-design.md`;
plan: `docs/superpowers/plans/2026-11-05-halaman-kebijakan.md`; routes and state: `frontend/ARCHITECTURE.md` section 8.

- **Turn on:** set `OPA_BIN=/home/ecs-user/.local/bin/opa` and `OPA_KEYS_DIR=/home/ecs-user/.opa-keys` in `~/.config/lensa/lensa.env` and restart `lensa.service`. Without either, or when setup fails, every `/api/policy*` route answers 501 and the rest of Lensa works.
- **State:** `frontend/server/state/policy/<owner>/<platform>/` (platform = a registry id: `zeto`, `noto`, `fabricx`, `iroha3`) holds `v<N>.json`, `pending.json` and `audit.jsonl`; each platform has its own versions. Version 1 is `seeds/<owner>.json[platform]`. Files directly under `<owner>/` are the pre-split history: on boot `PolicyStore.migrate()` copies them to `<owner>/zeto/` (numbers kept) and starts `<owner>/noto/` at v1 with the same doc; the originals are left in place.
- **Check before a draft is stored:** the `check` packages of both bundles (shape, ranges, bank not looser than BI, identities: exactly one `@`) and `opa test`; a failure answers 422 with the messages ("Kebijakan tidak valid" for a check error, "Uji kebijakan gagal" when any `opa test` case fails). A validator that returns no list at all (for example a renamed package) is a server error, never "valid".
- **Publish** (after approval), one gateway at a time, for the gateways whose Deployment `bank-gw-<node>` exists (BI's change: all four, a bank's: its own node):
  1. `opa build -b --signing-key` for `bi` (BI's key) and `bank` (the bank's key) (the bank bundle builds alone and reads BI's values as data only);
  2. apply ConfigMap `bank-gw-<node>-bundles` (`bi.tar.gz`, `bank.tar.gz`). No Deployment is touched, nothing restarts, Lensa's port-forward stays up;
  3. wait (180 s) until the gateway reports `bi-zeto.<n>-noto.<n>-fabricx.<n>-iroha3.<n>` and `<bank>-zeto.<n>-...` (every platform's current version, in registry order; node 1's bank bundle is `bank-bi-...`) as active revisions to the sink (the kubelet refreshes the mounted ConfigMap in up to about 90 s, then OPA polls within 15 s). A bundle that fails verification is never activated, so it never reports. If the sink cannot be read, that counts as not confirmed (fail closed);
  4. on failure the previous ConfigMap is put back and the change shows "Gagal diterbitkan" with "Terbitkan ulang".
- **Guard:** the kube module refuses any name outside `<name>-gw-[1-4]` and `<name>-gw-[1-4]-bundles` (`bank-gw-N` today, another platform's gateway once it lists one in the registry); its only other call is a read of the sink status.
- **Status on the screen:** the revisions a gateway last reported (a report older than 60 s counts as not ready). Raw: `kubectl get --raw /api/v1/namespaces/paladin/services/bundle-server:sink/proxy/status` (per gateway: `age_s` and, per bundle, `revision`, `code`, `message`; `code: bundle_error` with a message such as `failed to verify JWT signature` is a refused bundle).
- **Build only, no cluster:** `OPA_KEYS_DIR=~/.opa-keys npm run policy:build -w server -- <node> <outdir>` (from `frontend/`; unsigned when `OPA_KEYS_DIR` is not set, which the gateways refuse).
- **Live:** first publishes ran 2026-11-05 (BI v3, v4) to all four gateways from the screen.

## Adding a platform

Fabric-X (`fabricx`) and Iroha 3 (`iroha3`) are already registered with a policy document each (a copy of the Zeto seed, v1), so
their screens work today. Putting a platform behind the gateway needs only the pieces below; nothing in the shared layer
(`gw.rego`, `bi.check`, `bank.check`, the store, the Publisher, the routes, the screen) is edited.

1. **Registry entry**, `frontend/server/src/policy/platforms.ts` (`PLATFORMS` and `REGISTRY`, the only list of platforms; the store, bundles, revisions, routes, `/api/meta` and the web screen all derive from it):
   - `label`: the name on the screen;
   - `gateways`: sink names (`<name>-gw-<node>`, node 1..4) of the gateways that enforce it. The Publisher waits for the union of every platform's gateways, once each, and skips a name whose Deployment does not exist, so `[]` (today for fabricx and iroha3) or a gateway not deployed yet never makes a publish time out or fail;
   - `enforced`: `false` until the gateway reads the documents; the screen then says "Belum ditegakkan gateway: dokumen dapat disusun, tetapi belum memengaruhi transaksi";
   - `usage` (optional): the daily-usage source behind "Terpakai hari ini", `(party, limits) => Promise<{ RD, DFABI: { used, limit } }>`, read from the bank's own node. Without it `/api/policy/usage` answers 501 "Pemakaian harian belum tersedia untuk platform ini".
   Also add the key `<id>` to every `seeds/*.json` (incl. `bank-bi.json`); `PolicyStore.migrate()` creates v1 of a registered platform that has no directory yet (maker and checker "migrasi", reason "Platform <label> didaftarkan"), idempotent.
2. **Rego packages** `bi.platform.<id>` (in `bundles/bi/bi/platform/<id>/`) and `bank.platform.<id>` (in `bundles/bank/bank/platform/<id>/`), each with `allow` (default false). `gw.allow` passes any target other than `paladin` and `besu` only when BOTH allow; a target with no packages is undefined, so denied. The packages read:
   - `data.bi.config.policy.<id>` and `data.bank.config.policy.<id>`, the platform's documents (the Lensa-edited keys);
   - the shared helpers `bi.clock.token_open(platform, token)` (operating hours and holidays of that platform's BI document) and `bi.ident.frozen_nodes(platform)` (nodes frozen in it) in the BI bundle; the bank bundle has its own copies of what it needs and never calls BI's functions, so it builds alone (`opa build -b bundles/bank`);
   - structural data of their own under `data.bi.config.<id>` (contracts, channels, ...) in `bundles/bi/bi/config/data.json`.
   `bi.check` and `bank.check` need no change: they validate every document under `policy` and report "Kebijakan <id>: dokumen tidak ada" for each id in `data.bi.config.platforms`, which `Opa.assemble` writes from the registry. Tests: a package of its own in `test/`, plus its fixtures in `test/fixtures.rego` (see `test/gw/platform_test.rego` and the test-only `stub` packages for the dispatch). The platform's rules must never read `target` from the request body or headers; `gw.rego` reads it only from Envoy's `context_extensions`.
3. **Its gateway**: Envoy with `context_extensions: {target: <id>, node: nodeN}` on the listener that fronts the platform's API (exactly like `envoy/nodeN.yaml`), the OPA-Envoy sidecar pulling `N/bi.tar.gz` and `N/bank.tar.gz` from `bundle-server` with the same signing keys (`signing.keyid` pinned per bundle), decision logs to the sink, and the gateway's sink name (the label it reports with) listed in `gateways` of the registry entry. The ConfigMap `<name>-gw-N-bundles` that Lensa writes is the one the bundle-server serves for that gateway.
4. **Shared document fields** every platform document has: `max_per_tx` and `max_mint_per_tx` (per token), `hours` (per token: `days`, `open`, `close`), `holidays`, `frozen` for BI's; `counterparties` (and optional `max_per_tx`, `daily_limit`, `hours`) for a bank's. Extra fields are allowed (Noto's `max_balance`, `min_balance`, `max_supply` are examples): the checks ignore unknown keys, so a platform may add its own, validated by its own rules in its package or in a new `check` rule file. The screen edits the shared fields and shows the Noto-only ones for Noto only.
5. **Adapter hook for usage**: the `usage` function above is the only adapter hook; it queries the platform's own node/ledger for what the bank sent today (00:00 WIB), the same way the gateway computes the daily limit, and throws instead of answering when the answer cannot be complete.

Revisions: a bundle is built with `--revision <bundle>-zeto.<n>-noto.<n>-fabricx.<n>-iroha3.<n>` (platforms in registry order; bundle = `bi`, `bank-a|b|c`, or `bank-bi` for node 1). The Publisher also reads the older `bi-z<n>-n<m>` that gateways report until the first publish in the new format (fabricx and iroha3 read as not reported) and logs that fallback once per process.

## Fabric-X rules (`fabricx`)

Gateways `fx-gw-1..4` (ns `fabricx`) are designed in `fabric-x/opa/DESIGN.md`. Envoy :8443 requires mTLS. Behind it, OPA and fxapi (`rdbi-driver serve`) hold only that party's view-client key. The body is one fxapi request, and `node` is `node1..4` (= `issuer`, `bank2..4`). Rules: `bundles/bi/bi/platform/fabricx`, `bundles/bank/bank/platform/fabricx`; tests: `test/fabricx`.

| Op | Where | BI (`policy.fabricx`) | Bank (`policy.fabricx` of the gateway's bank) |
|---|---|---|---|
| `issue` | node1 only | `max_mint_per_tx`, hours, recipient not frozen | counterparty, hours, `max_per_tx` |
| `award` | node1 only, prechecked at the bank | DFABI ≤ `max_mint_per_tx`, RD ≤ `max_per_tx`, both tokens open, bank not frozen | DFABI leg: counterparty, hours of both tokens, `max_per_tx` |
| `transfer` | sender's gateway | `max_per_tx`, hours, sender and recipient not frozen | counterparty, hours, `max_per_tx`, `daily_limit` |
| `swap` (DvP) | seller's gateway, prechecked at the buyer's | both legs ≤ `max_per_tx`, both tokens open, neither bank frozen | seller's leg: counterparty, both tokens' hours, `max_per_tx`, `daily_limit` |
| `precheck` | the gateway of the party that gives the leg | the same checks as the initiator's side | buyer's leg: counterparty, both tokens' hours, `max_per_tx`, `daily_limit` |
| `redeem` | holder's gateway (a bank) | `max_per_tx`, hours, holidays, holder not frozen | hours, `max_per_tx`, `daily_limit` |
| reads | own node only | `balance`, `history`, `records`, `finality`, `report`, `usage` | none |

- Anything else is denied: other ops, unknown tokens or nodes, a non-POST request, or an amount that is not a positive uint64 decimal string.
- **Redeem differs from Noto's burn.** Noto's burn is issuer-only. In Fabric-X the holder redeems and BI co-signs on chain (the issuer node has no redeem view), so BI keeps control on the ledger. Redeem counts toward `daily_limit` like a transfer. An amount above the holder's balance is rejected by the view ("insufficient funds").
- `daily_limit` comes from the party's own token records (`rd_dfabi_v2`) via fxapi `usage` on 127.0.0.1:8080 (2s, fail closed). Counted are transfers, DvP legs and redeems since 00:00 WIB; change is excluded.
- **Known gap (DvP and award precheck):** it is enforced by the gateways, not by the buyer's node. A modified initiator that bypasses its own gateway can skip the precheck.

## Test

```
opa check --strict bundles/bi bundles/bank test
opa test --coverage bundles/bi bundles/bank test
regal lint bundles test
opa build -b bundles/bi -o /dev/null && opa build -b bundles/bank -o /dev/null   # each bundle must build alone
for f in k8s/*.yaml; do kubectl apply --dry-run=client -f $f; done                # manifests (client side only)
(cd ../../frontend/server && npx vitest run test/gateway-mtls.test.ts)            # mTLS client paths against a cert-requiring server
```

## Live state (2026-11-06)

All four gateways `bank-gw-1..4` run in namespace `paladin`, **enforcing** (`opa.yaml` `dry-run: false`,
`envoy/nodeN.yaml` `failure_mode_allow: false`, fail closed). Lensa's Paladin forwards (`frontend/deploy/forwards.conf`)
go through them. The Paladin `ext_authz` timeout (7s) must stay above the Rego `http.send` budget of one request: `gw.rego:17-22` ANDs three allows, so at most three sequential calls of 2s (the daily limit in `paladin.rego:178`, plus two supply reads on a Noto mint in `balance.rego:96`) = 6s. (Changed from 3s on 2026-11-11 in the repo; the live gateways keep 3s until the next gateway rollout.)
A gateway rollout drops that node's Lensa forward for 1 to 2 minutes; systemd restarts it.

Deployed 2026-11-06 (every step below was run): signed bundles from `bundle-server` (`bank-gw-opa-v2`; a BI publish reaches all
four gateways in about a minute, no rollout), NetworkPolicy on node1..4 plus `paladin-rpc-from-ingress-nginx` (the public
Ingress still points at the nodes, by decision of the user on 2026-11-06, review by 2026-12-06), mTLS on both doors (`bank-gw-N-mtls`, Lensa `LENSA_GW_MTLS_DIR`), and Lensa's
Besu traffic through bank-gw-1 on 38545 (`LENSA_BESU_RPC`). Scenarios S1 to S6 passed (44/44) before the deploy.

### Deploy the bundle server and signed bundles (ordered; one-time migration of the live gateways)

Run from `besu/opa` (`npm` from `frontend/`) with `export KUBECONFIG=~/.kube/alibaba.yaml`. Do not publish from the Kebijakan screen between step 5 and 6.

1. **Keys:** `bash keys.sh`. Creates `~/.opa-keys/{bi,bank-a,bank-b,bank-c}.pem` (private, mode 600, never overwritten) and `.pub`, and renders
   `~/.opa-keys/opa-config.yaml` (`opa.yaml` plus the public keys). Back up the `.pem` files outside the host; never commit them.
2. **Signed bundles into the existing ConfigMaps** (current policy values, one per node; same names the old file mounts use):
   `OPA_BIN=$HOME/.local/bin/opa OPA_KEYS_DIR=$HOME/.opa-keys npm run policy:build -w server -- N /tmp/gw-N` (N = 1..4), then
   `kubectl -n paladin create configmap bank-gw-N-bundles --from-file=/tmp/gw-N/bi.tar.gz --from-file=/tmp/gw-N/bank.tar.gz --dry-run=client -o yaml | kubectl apply -f -`.
3. **Config ConfigMaps:**
   `kubectl -n paladin create configmap bank-gw-opa-v2 --from-file=opa.yaml=$HOME/.opa-keys/opa-config.yaml` (new name, so a gateway still on the old manifest never reads the new config),
   `kubectl -n paladin create configmap bundle-server-conf --from-file=nginx.conf=bundle-server/nginx.conf`,
   `kubectl -n paladin create configmap bundle-server-sink --from-file=sink.py=bundle-server/sink.py`.
4. **Bundle server:** `kubectl apply -f k8s/bundle-server.yaml`, `kubectl -n paladin rollout status deploy/bundle-server`. Check it serves:
   `kubectl get --raw /api/v1/namespaces/paladin/services/bundle-server:bundles/proxy/2/bi.tar.gz | wc -c` (non-zero) and the sink answers `{}`:
   `kubectl get --raw /api/v1/namespaces/paladin/services/bundle-server:sink/proxy/status`.
5. **Roll the gateways one at a time** (2, 3, 4, then 1). Each rollout drops that node's Lensa forward for about 5 s, for the last time:
   `kubectl apply -f k8s/bank-gw-N.yaml`, `kubectl -n paladin rollout status deploy/bank-gw-N`, then the sink status shows `bank-gw-N` with revisions for `bi` and `bank` and no `code`.
   A new pod that cannot verify or download its bundles never becomes Ready (`maxUnavailable: 0` keeps the old pod serving): look at `kubectl -n paladin logs deploy/bank-gw-N -c opa` and the sink status `message`.
6. **Lensa:** deploy this version, add `OPA_KEYS_DIR=/home/ecs-user/.opa-keys` to `~/.config/lensa/lensa.env`, restart `lensa.service`. Publish one harmless change from the screen and watch the gateway
   status turn to the new version without a port-forward drop.
7. **Check decisions:** `kubectl -n paladin logs deploy/bundle-server -c sink | grep '"gateway":"bank-gw-2"' | tail` shows decisions of all four gateways (masked like the console log).

Rebuild one node's gateway later: `kubectl -n paladin create configmap bank-gw-N-envoy --from-file=envoy.yaml=envoy/nodeN.yaml`, then step 2 for N, then `kubectl apply -f k8s/bank-gw-N.yaml`.

Rollback (the old manifests and the old `bank-gw-opa` ConfigMap are untouched, `bank-gw-N-bundles` still holds a valid bundle pair):
- one gateway: `git show 6e7955e:besu/opa/k8s/bank-gw-N.yaml | kubectl apply -f -` (back to file-mounted, unsigned bundles; `bank-gw-opa` is still the old config);
- all: do that for N = 1..4, then `kubectl delete -f k8s/bundle-server.yaml` and `kubectl -n paladin delete configmap bank-gw-opa-v2 bundle-server-conf bundle-server-sink`;
- Lensa: redeploy commit `6e7955e` (its publisher patches annotations and restarts, and writes unsigned bundles, which only the old gateways accept) and remove `OPA_KEYS_DIR`. Never mix: new Lensa with old gateways, or old Lensa with new gateways, does not confirm a publish.
- Rotate a key: delete `<id>.pem`, `bash keys.sh`, recreate `bank-gw-opa-v2` (step 3), re-sign (step 2 or a publish), `kubectl -n paladin rollout restart deploy/bank-gw-N`.

Read denials, all four gateways in one place: `kubectl -n paladin logs deploy/bundle-server -c sink | grep '"result":false'` (each line has `labels.gateway`).
The console log of one gateway still works: `kubectl -n paladin logs deploy/bank-gw-N -c opa | grep '"result":false'`. Request bodies are masked in both (`system.log.mask`).
Back to dry-run: set `dry-run: true` in `opa.yaml` and `failure_mode_allow: true` in `envoy/nodeN.yaml`, re-run `bash keys.sh`, recreate `bank-gw-opa-v2` and the Envoy ConfigMaps, `kubectl rollout restart` the gateways.
Remove a gateway: point its forward back at `svc/paladin-nodeN`, `kubectl delete -f k8s/bank-gw-N.yaml` and its ConfigMaps.

## Closing the bypasses (three steps, each opt-in and reversible)

Written 2026-11-06 from a read-only look at the live cluster. Order: **1 (Besu route), then 2 (NetworkPolicy), then 3 (mTLS)**.
All three are applied live since 2026-11-06 (see Live state); the steps stay here for a rebuild and the rollbacks.

### 1. Lensa's Besu traffic through the gateway

Before: the `besu` forward ran `127.0.0.1:8545` straight to `besu-node-validator-1`, and `127.0.0.1:8545` is held by a foreign
port-forward (never kill it). Now the `besu` line of `frontend/deploy/forwards.conf` is `besu paladin bank-gw-1 38545:8545`.

- Lensa has **one** Besu URL (`BESU_RPC`, the Stealth adapter's provider, the health probe), so all parties go through
  **bank-gw-1's Besu door**. The Besu rules are BI's and identical on every gateway (`bi.besu`: a method allowlist, no party or
  node in it), so routing through one gateway changes no verdict. The only consequence is availability: if bank-gw-1 or
  validator-1 is down, Stealth is down (before: same, validator-1 was the target).
- The env var `LENSA_BESU_RPC` picks the URL; it wins over the URL stored in `state/stealth.json` (`rpcUrl`). Unset, Lensa keeps `127.0.0.1:8545`.
- Rego needed no change. Everything Lensa sends is already allowed (ethers: `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`,
  `eth_getLogs`, `eth_call`, `eth_estimateGas`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_getTransactionCount`,
  `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_getCode`, `eth_sendRawTransaction`; WebSocket and filters are not used).
  `test/gw/gw_test.rego` now pins this set on all four gateways, and that `eth_subscribe`, filters, `eth_sendTransaction`,
  `eth_accounts`, `txpool_*` stay denied. A request body over 1 MiB is refused by Envoy (`max_request_bytes`); a contract deploy is far below it.
- `bootstrap-stealth` (operator CLI) still takes its own `RPC_URL`; it is not routed.

Live steps:

1. Merge/pull on the Lensa host (no restart yet; `forwards.conf` is read when a forward starts).
2. `systemctl --user restart lensa-pf@besu` (it was waiting on 8545; it now forwards `38545` to `svc/bank-gw-1:8545`).
3. Check: `curl -s -XPOST 127.0.0.1:38545 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'` answers a block number; `eth_getBlockByNumber` works; `admin_peers` answers 403.
4. Add `LENSA_BESU_RPC=http://127.0.0.1:38545` to `~/.config/lensa/lensa.env`, `systemctl --user restart lensa.service`.
5. Check Stealth in Lensa (a read, then a payment). Denials: `kubectl -n paladin logs deploy/bank-gw-1 -c opa | grep '"result":false'`.

Rollback: remove `LENSA_BESU_RPC` from `lensa.env`, restart `lensa.service` (back on 8545). The forward on 38545 can stay.

### 2. NetworkPolicy (`k8s/networkpolicy.yaml`)

**The CNI enforces it.** The cluster runs Terway v1.15.0 (`terway-eniip` DaemonSet, containers `terway` + `policy` on all 21 nodes;
`kube-system/eni-config`: `network_policy_provider: ebpf`, `disable_network_policy: "false"`), not Flannel. Namespaces
`fabricx-*`, `iroha3` and `kaleido` already carry policies, including `default-deny-all` (Ingress+Egress) next to Ready pods with
kubelet probes, so node-to-pod probe traffic is not cut by policy here. Namespaces `paladin` and `besu` had **no** policy before.

Ingress only, no egress rule, selects the Paladin and Besu pods only. Every allowed flow and where it comes from:

| To | Port | From | Evidence |
|---|---|---|---|
| `paladin-nodeN` (label `app=paladin`, `app.kubernetes.io/instance=nodeN`) | 8548 | `bank-gw-N` pods (`app=bank-gw,node=nodeN`) | `bank-gw-N-envoy` cluster `paladin-nodeN:8548`; OPA sidecar daily-limit `http.send` to `data.nodes.nodeN.paladin_url` runs in the same pod |
| same | 8548, 8549 | `paladin-operator` | operator in ns `paladin` reconciles the `Paladin` CRs against the node RPC |
| same | 8548, 8549 | ns `dfabi` pods `app=bankN-backend` only | `deploy/bankN-backend` env `PALADIN_NODE_URL=http://paladin-nodeN.paladin.svc.cluster.local:8548`, `PALADIN_WS_URL=ws://...:8549`. The gateway has no WS door, so DFABI cannot be moved behind it |
| same | 9000 | pods `app=paladin` in ns `paladin` | Paladin gRPC transport: `Paladin` CR `transports[grpc]` port 9000, `externalHostname paladin-nodeN.paladin.svc.cluster.local` |
| same | 6100 | anyone | metrics, unchanged |
| `paladin-*` (object `paladin-rpc-from-ingress-nginx`) | 8548 | ns `kube-system`, pods `app=ingress-nginx` and `app.kubernetes.io/name=ack-ingress-nginx-v1` | `Ingress paladin-nodeN` (nginx, basic auth, `paladin-nodeN.apse5.kld.bi-sandbox.com`, public LB 8.215.48.50) points at `svc/paladin-nodeN:8548`. **This is a live bypass of the gateway**; kept so nothing is cut, see below |
| `besu-node-validator-N` (label `app.kubernetes.io/part-of=besu-node-validator-N`) | 8545 | `bank-gw-N` pods (ns `paladin`) | `bank-gw-N-envoy` cluster `besu-node-validator-N.besu.svc.cluster.local:8545` |
| same | 8545, 8546 | `paladin-nodeN` pod (ns `paladin`) | ConfigMap `paladin-nodeN` `blockchain.http.url`/`ws.url` = `besu-node-validator-N...:8545`/`:8546`; `Paladin` CR `baseLedgerEndpoint` |
| same | 30303 TCP+UDP | any pod in ns `besu` | QBFT P2P: ConfigMap `besu-peers` (`static-nodes.json`, `...besu-node-validator-M-0...besu.svc...:30303`), `discovery-enabled=true` |
| same | 9545 | anyone | Besu metrics, unchanged |

Nothing else was found: no workload, Job, CronJob, ConfigMap, Secret or Ingress in any other namespace names these hosts
(searched all namespaces; `kaleido` runs its own nodes). 8547 (GraphQL) is off in `config.toml`. No NodePort or LoadBalancer
exposes Paladin or Besu. Kubelet probes (`tcpSocket 8548` on Paladin, `httpGet /liveness :8545` on Besu) come from the node itself.
Things the policy **cannot** see: `kubectl port-forward` (the kubelet dials the pod from its node, so it bypasses
NetworkPolicy; that is how Lensa and the foreign 8545 forward still reach pods) and anything running as `hostNetwork`.

Live steps (one node at a time, node 4 first; the flows are the same for every node):

1. `kubectl apply -f k8s/networkpolicy.yaml -l node=node4` (two objects: `paladin-node4-ingress`, `besu-node-validator-4-ingress`).
2. Check, one minute apart:
   - `kubectl -n paladin get pods` and `kubectl -n besu get pods`: no restarts, `READY` unchanged (probes).
   - Lensa: a Zeto read and a transfer on node 4 (through `bank-gw-4`); Besu still gives new blocks (`eth_blockNumber` twice on `127.0.0.1:38545`).
   - `kubectl -n dfabi logs deploy/bank4-backend --tail=20`: no connection errors. `kubectl -n paladin get paladin`: the operator still sees the node.
   - Negative, only when you decide to test (it creates a pod): `kubectl -n paladin run np-probe --rm -it --image=busybox:1.36 --restart=Never -- wget -qO- -T3 http://paladin-node4:8548` must time out.
3. Repeat with `-l node=node3`, `node2`, `node1`, then `-l node=all` (the ingress-nginx allowance, needed as long as the public Ingress points at the nodes).

Rollback: `kubectl delete -f k8s/networkpolicy.yaml -l node=node4` (or without `-l` for all); traffic is open again immediately. The Besu liveness
probe waits 180 s then runs every 60 s with 3 failures to restart: if a validator restarts after step 2, delete its object first.

**Public ingress bypass.** Decision owner: the user. Decided: 2026-11-06. Review date: 2026-12-06 (also in `../NOTES.md`, "Monthly checks"). `paladin-rpc-from-ingress-nginx` keeps the existing public route working. To put the public route
behind OPA, apply `k8s/ingress-via-gateway.yaml` (same hosts, annotations, TLS secrets; backend `bank-gw-N:8548`), check one
call through `https://paladin-node2.apse5.kld.bi-sandbox.com`, then `kubectl -n paladin delete networkpolicy paladin-rpc-from-ingress-nginx`.
That changes what external callers may do (OPA rules apply: Zeto, and Noto and Pente scoped as in the rules table). It cannot be combined with step 3 (mTLS) unless the
Ingress also gets `backend-protocol: HTTPS` and a client cert (`nginx.ingress.kubernetes.io/proxy-ssl-secret`). Rollback: re-apply the old Ingress
(`kubectl -n paladin get ingress paladin-nodeN -o yaml` saved before, backend `paladin-nodeN:8548`).

### 3. mTLS Lensa to the gateway (`mtls/`)

Envoy requires a client certificate on **both doors** (8548 Paladin, 8545 Besu): `DownstreamTlsContext` with
`require_client_certificate: true`, TLS 1.2+, trusted CA `/mtls/ca.crt`. `mtls/envoy-mtls.sh envoy/nodeN.yaml` prints the
plain `envoy/nodeN.yaml` with that inserted; the plain file stays the source of truth. The readiness probe stays
`tcpSocket 8548` (a TCP connect needs no handshake, verified against a live Envoy). `k8s/bank-gw-N.yaml` mounts the optional Secret
`bank-gw-N-mtls` at `/mtls`; while the Secret does not exist the volume is empty and nothing changes.

Lensa side, opt-in with `LENSA_GW_MTLS_DIR=<dir with ca.crt, lensa.crt, lensa.key>`: gateway URLs turn into `https://`, the Paladin
SDK client gets `requestConfig.httpsAgent` (`besu/zeto/src/common.ts`, `besu/noto+pente/common/src/config.ts`), JSON-RPC calls,
the health probe and the ethers provider use the same agent (`frontend/server/src/gateway.ts`). Set but unreadable: Lensa does
not start (no silent downgrade). Unset: plain http, as now. The server cert has SANs `bank-gw-N[.paladin[.svc[.cluster.local]]]`,
`localhost`, `127.0.0.1`, so the port-forwarded `https://127.0.0.1:315x8` verifies.

Keys are made on the host, outside the repo, and never committed: `mtls/gen-certs.sh` writes `~/.opa-mtls/` (dir 700, files 600;
it refuses a directory inside the repo). CA 5 years, leaf certs 1 year (re-issue with `FORCE=1 mtls/gen-certs.sh`, then redo step 2 and 3 below).

Scope of this mTLS: Lensa to the gateway only. Envoy to Paladin (`paladin-nodeN:8548`) and Envoy to Besu (`besu-node-validator-N:8545`) is plaintext HTTP inside the
cluster (the `paladin` and `besu` clusters in `envoy/nodeN.yaml` have no `transport_socket`: `grep -c transport_socket envoy/node1.yaml` prints 0). In ns `paladin`
a NetworkPolicy limits who may reach the nodes (`k8s/networkpolicy.yaml`). The `fx-gw-N` gateways in ns `fabricx` are selected by no NetworkPolicy: the four live
`rdbi-*-ingress` policies select only `rdbi-*` pods (`kubectl get networkpolicy -n fabricx`, 2026-11-11), and `fabric-x/opa/DESIGN.md:126` says "fx-gw pods are not
selected". Whether to add one is an open decision (see `fabric-x/opa/DESIGN.md:140-144` for the neighbouring open decision on the `rdbi-driver-files` Secret).
Certificate dates (read 2026-11-11): leaf certs `gw-1..4`, `fx-gw-1..4` and `lensa` expire on 2027-11-06, the CA on 2031-11-05. Check them every month:
`openssl x509 -in ~/.opa-mtls/<name>.crt -noout -enddate` (`../NOTES.md`, "Monthly checks").

Live steps (the flip is all-or-nothing for Lensa: its env switches every gateway at once, so expect Lensa to be down while the four
rollouts run, about 10 s each plus the forward restart; do it when no stress run is going):

1. `mtls/gen-certs.sh`
2. For N in 1..4: `D=~/.opa-mtls; kubectl -n paladin create secret generic bank-gw-N-mtls --from-file=tls.crt=$D/gw-N.crt --from-file=tls.key=$D/gw-N.key --from-file=ca.crt=$D/ca.crt`
3. For N in 1..4: `kubectl apply -f k8s/bank-gw-N.yaml` (mounts the Secret; envoy config still plain; wait for the rollout).
4. For N in 1..4, one at a time: `mtls/envoy-mtls.sh envoy/nodeN.yaml > /tmp/nodeN.mtls.yaml`; then
   `kubectl -n paladin create configmap bank-gw-N-envoy --from-file=envoy.yaml=/tmp/nodeN.mtls.yaml --dry-run=client -o yaml | kubectl apply -f -`;
   `kubectl -n paladin rollout restart deploy/bank-gw-N`; wait; `rm /tmp/nodeN.mtls.yaml`.
   Direct check through a forward: `curl -s -o /dev/null -w '%{http_code}\n' --cacert ~/.opa-mtls/ca.crt --cert ~/.opa-mtls/lensa.crt --key ~/.opa-mtls/lensa.key https://127.0.0.1:31648/ -d '{"jsonrpc":"2.0","id":1,"method":"transport_nodeName","params":[]}'`
   answers 200; the same without `--cert/--key` fails the handshake.
5. Add `LENSA_GW_MTLS_DIR=/home/ecs-user/.opa-mtls` to `~/.config/lensa/lensa.env`; `systemctl --user restart lensa.service`.
   Step 4 breaks plain-http Lensa, so do 4 and 5 back to back.
6. Check Lensa: network screen shows all Paladin nodes and Besu up, a Zeto transfer, a Stealth read.

Rollback: remove `LENSA_GW_MTLS_DIR` from `lensa.env`; for N in 1..4 re-create `bank-gw-N-envoy` from plain `envoy/nodeN.yaml`
(`kubectl -n paladin create configmap bank-gw-N-envoy --from-file=envoy.yaml=envoy/nodeN.yaml --dry-run=client -o yaml | kubectl apply -f -`),
`rollout restart deploy/bank-gw-N`, restart `lensa.service`. The Secrets can stay.

Not covered: the client cert is not bound to a party (one `lensa` cert for all four doors: it proves "this is Lensa", not
"this is bank A"); cert rotation needs the rollout restart (Envoy reads files at start).

## Redeploying Noto (runbook)

Only for a Noto redeploy (new chain or new contracts). A full `npm run bootstrap noto` cannot finish through the
gateways: its deploys pass on node1 (`bi.notosetup`), but the same run then mints, distributes, runs a DvP and the banks'
purchase demo (each investor node creates its investor-custodian group and deploys `BondSubscription`) against
contracts and groups the live bundle does not know yet. There is deliberately no two-phase bootstrap; the redeploy goes
around the gateways instead. That is an operator bypass: do it only with the user's explicit approval, each time, and
announce the window to the lead (no policy publish meanwhile).

1. Stop Lensa's Paladin forwards: `systemctl --user stop lensa-pf@paladin-node{1,2,3,4}` (Lensa's Paladin models are
   down until step 5).
2. Forward each node directly on the same local ports (a kubelet port-forward; the NetworkPolicy does not apply):
   `kubectl -n paladin port-forward pod/paladin-node1-0 31548:8548`, node2 `31648`, node3 `31748`, node4 `31848`.
3. In `frontend/server`: `npm run bootstrap noto -- --force`, without `LENSA_GW_MTLS_DIR` (plain http to the direct
   forwards). It writes `state/noto.json` and the new contract-data file, and rewrites `bundles/bi/bi/config/data.json`
   (`noto.contracts`, `pente.groups`, the Noto atom factory).
4. Stop the direct forwards.
5. Start the Lensa forwards again: `systemctl --user start lensa-pf@paladin-node{1,2,3,4}`.
6. Commit `data.json` before anything else: the Publisher ships the main checkout's working tree.
7. Restart Lensa, so it loads the new contract data.
8. BI republishes the Noto policy. A change with no effect is enough, e.g. a dummy holiday, then restore it. This puts
   the new addresses into the bundles of bank-gw-1..4.
9. Verify, then report to the lead:
   - Lensa's Noto health is ready, with no missing-address message.
   - The sink shows the new `bi-…` revision on bank-gw-1..4.
   - Over mTLS on `:31648`, a Noto transfer probe to the new RD contract is allowed, and one to the old address is denied.
   - One Noto transfer through Lensa succeeds.

## Bundle-server hardening (in the repo, not rolled out)

What changes: (1) the sink (`bundle-server/sink.py`) requires `Authorization: Bearer <token>` on `POST /logs` and `POST /status` (401 otherwise); with
`SINK_TOKEN_FILE` unset it behaves as before. The gateways' OPA sends the token: `opa.yaml` `services.sink.credentials.bearer.token_path: /sink-token/token`
(opa v1.21.1 docs/configuration.md, "Services > Bearer Token"; `decision_logs` and `status` both use service `sink`; OPA re-reads the file on every request).
The token is the Secret `bundle-sink-token`, made by `keys.sh` in `$OPA_KEYS_DIR/sink-token` (outside the repo, never overwritten), mounted at `/sink-token` in
bundle-server's sink container and in every gateway's `opa` container (`k8s/bundle-server.yaml`, `k8s/bank-gw-N.yaml`). The sink's volume is not optional (a missing Secret stops the sink: it fails closed); the gateways' volumes are `optional: true` (a missing Secret costs their decision logs and status posts, and a Publisher confirm shows "Gagal", but never the gateway itself).
(2) NetworkPolicy `bundle-server-ingress` (`k8s/networkpolicy.yaml`, label `node=bundle-server`): ingress only from `app=bank-gw` pods and the `fx-gw` pods of ns
`fabricx` on 8080 and 8081, and from the two kube-apiserver addresses on 8081. (3) The sink is in memory by decision: it keeps the last status per gateway and writes decision logs to stdout.

Decisions and risks (read before the rollout request):
- `GET /status` has NO token. Lensa reads it through the API-server service proxy (`frontend/server/src/policy/kube.ts:65`), which cannot add the header; access to it is guarded by k8s RBAC on `services/proxy`. The integrity risk (a fake status that Lensa trusts) is on the POST route, which is now guarded.
- The apiserver rule is an ASSUMPTION: the two `ipBlock` /32 addresses are the endpoints of `kubernetes` in `default` (`kubectl get endpoints kubernetes -n default`, 2026-11-11: 172.24.11.240, 172.24.40.81). That the proxy reaches the pod from them can only be proven live. Proof after applying: Lensa's publish still confirms (the Publisher reads GET /status). If not: delete the NetworkPolicy object (rollback), find the real source address, fix the `ipBlock`.
- The fx-gw OPA (fabric-x repo, `fabric-x/opa`) also posts to this sink and has no token yet: after the sink enforces the token its decision logs and status posts get 401 (enforcement is not affected). It needs the same Secret in ns `fabricx` and `services.sink.credentials` in its config; that is a change in the fabric-x repo and a part of the same rollout.
- Rollout is a cluster write and needs `lead`'s GO and the user's approval; order: 1. `bash keys.sh`, create the Secret `bundle-sink-token` in ns `paladin` (and `fabricx`) from `$OPA_KEYS_DIR/sink-token`; 2. re-create `bank-gw-opa-v2` from the new `opa-config.yaml`; 3. apply `k8s/bundle-server.yaml` (the sink now checks the token); 4. apply `k8s/bank-gw-1..4.yaml` one at a time (README, "Deploy ..."), each waits for Ready and an active bundle revision in `GET /status`; 5. apply `networkpolicy.yaml -l node=bundle-server` and re-check publish. Rollback: delete the NetworkPolicy; re-apply the old manifests and the old ConfigMap.
- Token rotation: the sink reads the token file once at start (`sink.py`, `read_token`), so a new token needs a restart of bundle-server after the Secret changes; the gateways' OPA re-reads `token_path` on every request, so they follow without a restart.
- Post-apply check (after step 5): `kubectl get --raw /api/v1/namespaces/paladin/services/bundle-server:sink/proxy/status` must still print the gateways' bundle status (this is the path Lensa's Publisher uses). Rollback of the NetworkPolicy: `kubectl -n paladin delete networkpolicy bundle-server-ingress`.
- Tests: `cd bundle-server && python3 -m unittest test_sink` (token check: rejected without or with a wrong token, accepted with it, GET open, no token configured = open, token file read/empty).
- `POST /bundles/<name>` (own bundle: unsigned source built and signed with the party's key; foreign name: signed bundle stored as-is; append-only revisions in `BUNDLE_STORE`, `latest.tar.gz` served by nginx): `bundle-server/sink.py`, tests `python3 -m unittest test_sink_bundles` (needs `opa` and `openssl`); per-party manifests in `zeto/k8s/bundle-server/` (not rolled out).

## Not done (production hardening)

1. The public ingress still bypasses the gateway until `k8s/ingress-via-gateway.yaml` is applied (decision above: owner the user, 2026-11-06, review 2026-12-06).
2. DFABI `bankN-backend` talks to Paladin directly (needs the WebSocket port, which the gateway does not proxy).
3. Bundles are signed per owner, but custody is not separated yet: all four private keys sit in one directory on the Lensa host. In production each owner signs on its own side and publishes to its own bundle server.
4. `bundle-server` is one replica without authentication, and no NetworkPolicy: anyone inside the cluster can post fake decision logs or a fake bundle status (Lensa could then confirm a publish that no gateway loaded; it cannot make a gateway load an unsigned bundle). A restarted gateway cannot become Ready while the bundle server is down (`persist` is off: no PVC); running gateways keep their bundles. **In the repo since 2026-11-11, NOT rolled out:** a bearer token on the two POST routes and a NetworkPolicy for bundle-server (section "Bundle-server hardening" below). The sink stays in memory by decision; a durable sink is a separate user item (about 1 day of work).
