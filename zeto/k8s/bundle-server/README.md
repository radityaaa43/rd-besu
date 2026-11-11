# zeto S17 (part): bundle-server per party namespace, PVC `bundle-store`, upload endpoint

`final-design/zeto/PLAN.md` S17, "per-party bundle source and upload". Repo-only: nothing here is applied to a cluster.

```
./render.sh <bi|bank-a|bank-b|bank-c> --sink-image REF [--storage-class NAME]   # ns rd-zeto-<party>, to stdout
./test.sh                                                                        # offline: bash + python3 + PyYAML
cd ../../../opa/bundle-server && python3 -m unittest test_sink test_sink_bundles   # sink; needs the opa and openssl binaries
```

Renders ConfigMap `bundle-server-conf` (the nginx.conf of `opa/bundle-server`), PVC `bundle-store` (1Gi, RWO), Deployment `bundle-server`
(nginx serves the PVC read-only; the sink writes it and signs), Service (ClusterIP) and NetworkPolicy (ingress 8080/8081 only from `app=bank-gw` pods of the same ns).
The Secrets are NOT rendered: the party creates `opa-bundle-signing-<party>` (key `key.pem`, RSA private key) and `bundle-sink-token` (key `token`) in its own ns.

## Data flow: who signs what

`POST /bundles/<name>` on the sink (`opa/bundle-server/sink.py`, bearer token, body = tar.gz, max 10 MiB, name `^[a-z0-9][a-z0-9-]*$`):

| server | `PARTY_BUNDLE` (own names) | key id | own name: body = unsigned source, built + signed here | foreign name: body = signed bundle, stored AS-IS |
|---|---|---|---|---|
| BI | `bi,bank` | `bi` | `bi`, `bank` (node 1's bank bundle is BI's, `opa/keys.sh:2`) | none expected |
| bank-a/b/c | `bank` | `bank-a/b/c` | `bank` | `bi` |

- Own name, signed body, or foreign name, unsigned body: 422. Written append-only: `<name>/<revision>.tar.gz` + `.signatures.json`, revision = UTC timestamp + `-` + sha256 of the body; an existing file is never replaced (409). `<name>/latest.tar.gz` (symlink) is what nginx serves.
- Upload matrix (PLAN S17): `bi` source -> BI's gateway only; BI's server then POSTs the signed `bi` artifact to bank-gw-2..4 with BI's publisher-role cert; a bank's `bank` source -> that bank's gateway; BI's `bank` source -> bank-gw-1. A key signs only in its own namespace.
- The gateway's `bundles.<name>.resource` becomes `<name>/latest.tar.gz` (today `<N>/bi.tar.gz`, `opa/k8s/bank-gw-N.yaml:45-46`); `keyid` pins stay (`bundles.bank.signing.keyid`).

## Apply order (one party at a time; all CLUSTER-OP, own GO)

1. Party creates Secrets `opa-bundle-signing-<party>` and `bundle-sink-token` in `rd-zeto-<party>` (keys copied from `~/.opa-keys` now, destroyed at S22).
2. Build the image from `Dockerfile` (python + `sink.py` + opa 1.21.1), push, pin the digest.
3. `render.sh <party> --sink-image <ref@digest> [--storage-class X] | kubectl apply -f -`; wait for the PVC to bind and the pod Ready.
4. Upload the unsigned source through the party gateway (needs S16 gateway + the `sink` route/rego of the other S17 task), check `GET /status` shows the revision.
5. Rollback: delete the Deployment, ConfigMap, Service, NetworkPolicy and PVC `bundle-store`.

## Assumptions

- The sink signs with `opa build --signing-key --verification-key-id <keyid>`, as the Publisher does (`opa/README.md:60`); a test verifies the result with the public key via `opa build --verification-key`. Revision: if the source has no `.manifest`, `--revision <revision>` is set.
- The `sink` route of the envoy is in the `app=bank-gw` pod, so one NetworkPolicy rule covers OPA and the route. No kube-apiserver rule: Lensa reads the status through the gateway (S20), not the service proxy (the old `networkpolicy.yaml:249-251` rule is not carried over).
- Secret name was `sink-token` in G2; now `bundle-sink-token`, the live name (`opa/k8s/bundle-server.yaml:59`, `opa/README.md:330`); the gateway pods must mount the same one.
- `PARTY_BUNDLE` is a comma list (`bi,bank` on BI) because BI's server signs two bundles with one key.
- Sink memory limit 256Mi (was 96Mi): `opa build` runs in the sink container.

## Open questions

1. Image source: `openpolicyagent/opa:1.21.1-static` ships `/opa`; the Dockerfile is unbuilt (no docker here). Registry for the pushed image is not decided (cluster 2 must pull it too).
2. Cluster 2 storage class for bank-c: name and `WaitForFirstConsumer` binding are unverified; `render.sh` refuses bank-c without `--storage-class`.
3. The same `bank-gw-N.yaml` changes (resource path, secret name) belong to the gateway task, not here.
4. `opa build` writes member names with a leading `/`; the sink accepts that only for a signed (opa-made) body, never for a source archive.
