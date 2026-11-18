// Minimal stand-in for Paladin's examples/common (paladin-example-common): node connections
// from ../config.json, poll timeouts, and the checkDeploy/checkReceipt helpers.
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import { ITransactionReceipt, PaladinConfig } from "@lfdecentralizedtrust/paladin-sdk";

export const DEFAULT_POLL_TIMEOUT = 30000;
export const LONG_POLL_TIMEOUT = 120000;

export interface NodeConnection {
  name: string;
  id: string;
  clientOptions: PaladinConfig;
}

// Opt-in mTLS to the OPA gateways (besu/opa/README.md): LENSA_GW_MTLS_DIR holds ca.crt, lensa.crt, lensa.key. Unset: plain http.
// Per-party gateway CAs (rd-zeto-* namespaces): LENSA_GW_MTLS_DIR/<BI|A|B|C>/ holds that party's files; node1..4 = BI, A, B, C.
const mtlsDir = process.env.LENSA_GW_MTLS_DIR;
const NODE_PARTY = ["BI", "A", "B", "C"];
const mtlsFor = (node: number) => {
  if (!mtlsDir) return undefined;
  const party = path.join(mtlsDir, NODE_PARTY[node] ?? "");
  const dir = fs.existsSync(path.join(party, "ca.crt")) ? party : mtlsDir;
  return { ca: fs.readFileSync(path.join(dir, "ca.crt")), cert: fs.readFileSync(path.join(dir, "lensa.crt")), key: fs.readFileSync(path.join(dir, "lensa.key")) };
};

// ZETO_NODE_URLS=url1,url2,url3,url4 overrides the node URLs (e.g. port-forwards straight to svc/paladin-nodeN:8548, no gateway).
// An http:// override is used as is, without mTLS.
const urlOverride = (process.env.ZETO_NODE_URLS ?? "").split(",").filter(Boolean);
export const nodeConnections: NodeConnection[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"),
).map((n: { name: string; id: string; client: { url: string } }, i: number) => {
  if (urlOverride[i]) return { name: n.name, id: n.id, clientOptions: { url: urlOverride[i] } };
  const mtls = mtlsFor(i);
  return {
    name: n.name,
    id: n.id,
    clientOptions: mtls
      ? { url: n.client.url.replace(/^http:/, "https:"), requestConfig: { httpsAgent: new https.Agent({ ...mtls, keepAlive: true }) } }
      : { url: n.client.url },
  };
});

export function checkDeploy(contract: { address: string } | undefined): contract is { address: string } {
  if (contract === undefined) {
    console.error("Failed!");
    return false;
  }
  console.log(`Success! address: ${contract.address}`);
  return true;
}

export function checkReceipt(receipt: ITransactionReceipt | undefined): receipt is ITransactionReceipt {
  if (receipt === undefined) {
    console.error("Failed!");
    return false;
  } else if (receipt.failureMessage !== undefined) {
    console.error(`Failed: ${receipt.failureMessage}`);
    return false;
  }
  console.log("Success!");
  return true;
}
