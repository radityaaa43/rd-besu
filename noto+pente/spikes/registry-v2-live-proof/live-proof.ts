/*
 * Task #11 live proof: BondSeriesRegistry v2 + paladin-client 0.4.1.
 *
 * Scenario A: issueSeries on registry v2 from node1 (BI) -> getSeries from node2 (investor2's
 *   OWN separate client instance, which never called issueSeries for this token) returns
 *   publicTracker -- proves the registry itself carries the field.
 * Scenario B: that SAME investor2 client calls getDistributionState + getPrice successfully,
 *   with no SeriesContext of its own for this token -- proves D1/D2's cross-process fix (the
 *   whole point of task #11): these two methods no longer depend on the in-memory cache.
 * Scenario C: BI-restart simulation. A BRAND NEW client instance (fresh connect(), its own
 *   empty seriesContexts) resumes the BI-private half via resumeSeries(token, groupId,
 *   privateTracker) -- using ONLY what the ORIGINAL issueSeries call returned (standing in for
 *   what BI's backend DB would have persisted) -- then sends a REAL private transaction
 *   (beginDistribution) into the issuer+custodian group it never personally deployed.
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node live-proof.ts
 */
import { nodeConnections } from "paladin-example-common";
import { connect as connectPaladinClient, loadClientConfigFile, validateClientConfig } from "../../common/paladin-client/src/index";
import type { PaladinClientConfig } from "../../common/paladin-client/src/types";

const logger = console;
let failures = 0;
function check(label: string, pass: boolean, detail?: unknown) {
  if (pass) {
    console.log(`OK   - ${label}`);
  } else {
    failures++;
    console.error(`FAIL - ${label}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor<T>(label: string, fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 40000): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (pred(last)) return last;
    } catch {
      // keep retrying until timeout -- the condition itself may throw while not-yet-true
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}, last value: ${JSON.stringify(last)}`);
}

const OUT_DIR = "/home/ecs-user/alibaba-kube/Paladin/bootstrap/out";

async function main(): Promise<boolean> {
  const runId = Date.now();

  const bank1Cfg: PaladinClientConfig = loadClientConfigFile(`${OUT_DIR}/contract-data-bank1.json`, { nodeUrl: nodeConnections[0].clientOptions.url! });
  const bank2Cfg: PaladinClientConfig = loadClientConfigFile(`${OUT_DIR}/contract-data-bank2.json`, { nodeUrl: nodeConnections[1].clientOptions.url! });
  validateClientConfig(bank1Cfg);
  validateClientConfig(bank2Cfg);
  check("bank1/bank2 contract-data files pass validateClientConfig (v2 registry)", true);

  const cashToken = (bank1Cfg.contractData as { cashToken: string }).cashToken;

  const biClient = await connectPaladinClient(bank1Cfg);
  const investor2Client = await connectPaladinClient(bank2Cfg);

  // =========================================================================================
  // Scenario A: issueSeries on v2 -> getSeries from a DIFFERENT process/client returns publicTracker
  // =========================================================================================
  logger.log("\n=== Scenario A: issueSeries (v2) + cross-process getSeries ===");
  const seriesParams = {
    instrumentType: "SUKUK",
    seriesCode: `R2-${runId}`,
    isin: "ID1000099999",
    currencyToken: cashToken,
    faceValue: "1000000",
    issueDate: "2026-10-06T00:00:00.000Z",
    maturityDate: "2030-10-06T00:00:00.000Z",
    transferRestricted: true,
    termsHash: "0x" + "cd".repeat(32),
  };
  const { token, privateTracker, publicTracker, groupId } = await biClient.issueSeries(seriesParams);
  logger.log(`token=${token} privateTracker=${privateTracker} publicTracker=${publicTracker} groupId=${groupId}`);

  // investor2Client never called issueSeries for this token -- its own seriesContexts has
  // nothing for it. getSeries is a pure registry read, so this must already work.
  // norm: getSeries's publicTracker comes back without a "0x" prefix (same as currencyToken,
  // existing behavior, not something this task changes) -- normalize before comparing.
  const norm = (a: string) => (a.startsWith("0x") ? a : "0x" + a).toLowerCase();
  const seriesFromInvestor = await investor2Client.getSeries(token);
  check("Scenario A: getSeries from investor2's client returns the real publicTracker", norm(seriesFromInvestor.publicTracker) === norm(publicTracker), seriesFromInvestor);

  // =========================================================================================
  // Setup for scenario B/C: mint supply, then (via the RESUMED BI client) start a distribution
  // round, so getDistributionState/getPrice have real state to read.
  // =========================================================================================
  await biClient.mintTranche(token, "1000");

  // =========================================================================================
  // Scenario C: BI-restart simulation -- a BRAND NEW client instance, empty seriesContexts,
  // resumes the BI-private half from exactly what issueSeries returned (standing in for BI's
  // own persisted DB row), then sends a REAL private tx into the group it never deployed.
  // =========================================================================================
  logger.log("\n=== Scenario C: BI restart -> resumeSeries -> real private tx ===");
  const freshBiClient = await connectPaladinClient(bank1Cfg); // fresh connect() = fresh PaladinClientImpl = empty seriesContexts
  let threwBeforeResume = false;
  try {
    await freshBiClient.getDistributionState(token);
  } catch {
    // Not expected to throw PD_CLIENT_UNKNOWN_SERIES here -- getDistributionState no longer
    // needs seriesContexts at all post-0.4.1. This call is just establishing there's nothing
    // ELSE accidentally relying on the pre-resume cache; a real throw here would be a surprise,
    // not the point of this scenario. Swallow and move on either way.
    threwBeforeResume = true;
  }
  logger.log(`(diagnostic only, not a pass/fail gate) freshBiClient.getDistributionState before resumeSeries threw=${threwBeforeResume}`);

  await freshBiClient.resumeSeries(token, groupId, privateTracker);
  // beginDistribution needs ctx.privateTracker.sendTransaction -- a REAL private transaction
  // into the issuer+custodian group -- so a success here is proof resumeSeries rebuilt a
  // working BondTracker handle, not just a non-throwing stub. (A second mintTranche here
  // would need setActive() first -- BondTracker's own "unissued or fully active" guard,
  // unrelated to resumeSeries -- so this proof goes straight to beginDistribution, same as
  // the real one-mint-then-distribute lifecycle.)
  await freshBiClient.beginDistribution(token, { price: "1", minimumDenomination: "1" });
  const distAfterResume = await waitFor("distribution started after resumeSeries", () => freshBiClient.getDistributionState(token), (d) => d.status === "DISTRIBUTION_STARTED");
  check("Scenario C: resumeSeries + beginDistribution succeeded on a brand-new client instance", distAfterResume.status === "DISTRIBUTION_STARTED", distAfterResume);

  // =========================================================================================
  // Scenario B: investor2's client (still the ORIGINAL instance from Scenario A, never ran
  // issueSeries OR resumeSeries for this token) reads distribution state + price successfully.
  // =========================================================================================
  logger.log("\n=== Scenario B: cross-process getDistributionState + getPrice ===");
  const distFromInvestor = await waitFor("investor2 sees DISTRIBUTION_STARTED", () => investor2Client.getDistributionState(token), (d) => d.status === "DISTRIBUTION_STARTED");
  check("Scenario B: getDistributionState from investor2's client (no SeriesContext for this token) succeeds", distFromInvestor.status === "DISTRIBUTION_STARTED", distFromInvestor);

  const price = await investor2Client.getPrice(token, "10");
  check("Scenario B: getPrice from investor2's client succeeds", typeof price === "string" && price.length > 0, price);

  logger.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
