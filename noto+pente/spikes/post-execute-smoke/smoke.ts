/*
 * Task #10 post-execute read-only smoke test (per the lead's rule 4), run against the REAL
 * contract-data-bank{1..4}.json files the real --execute just wrote. No transactions sent --
 * every call here is a read (balances/getSeries/findGroupsWithMembers/validateClientConfig).
 *
 * Run: NODE_PATH=../../bond/node_modules:../../swap-noto/node_modules ../../bond/node_modules/.bin/ts-node smoke.ts
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

const OUT_DIR = "/home/ecs-user/alibaba-kube/Paladin/bootstrap/out";

async function main(): Promise<boolean> {
  const banks = [
    { bankId: "bank1", nodeIdx: 0 },
    { bankId: "bank2", nodeIdx: 1 },
    { bankId: "bank3", nodeIdx: 2 },
    { bankId: "bank4", nodeIdx: 3 },
  ];

  const configs: Record<string, PaladinClientConfig> = {};
  for (const b of banks) {
    const file = `${OUT_DIR}/contract-data-${b.bankId}.json`;
    const cfg = loadClientConfigFile(file, { nodeUrl: nodeConnections[b.nodeIdx].clientOptions.url! });
    validateClientConfig(cfg);
    configs[b.bankId] = cfg;
    check(`${b.bankId}: loadClientConfigFile + validateClientConfig`, true);
  }

  const bank1Client = await connectPaladinClient(configs.bank1);
  const bank2Client = await connectPaladinClient(configs.bank2);
  const bank3Client = await connectPaladinClient(configs.bank3);
  const bank4Client = await connectPaladinClient(configs.bank4);

  // getSeries on the registry -- no series registered yet, a clean "not found" is the pass.
  const cashToken = (configs.bank1.contractData as { cashToken: string }).cashToken;
  try {
    await bank1Client.getSeries(cashToken);
    check("getSeries on an unregistered token (empty registry)", false, "expected a not-found error, got a result");
  } catch (e) {
    check("getSeries on an unregistered token (empty registry) -- cleanly rejects, registry is live", true, (e as Error).message);
  }

  // Cash balances -- each investor reads its OWN balance from its OWN node.
  const bal2 = await bank2Client.balances(cashToken);
  const bal3 = await bank3Client.balances(cashToken);
  const bal4 = await bank4Client.balances(cashToken);
  check("investor2 cash balance == 1000000 (from node2)", bal2.available === "1000000", bal2);
  check("investor3 cash balance == 1000000 (from node3)", bal3.available === "1000000", bal3);
  check("investor4 cash balance == 1000000 (from node4)", bal4.available === "1000000", bal4);

  // findGroupsWithMembers from the INVESTOR side -- same group the bootstrap pre-created.
  const bondCustodianLookup = (configs.bank1.identities as { bondCustodian: string }).bondCustodian;
  const groupIds = (configs.bank1.contractData as { groupIds: Record<string, string> }).groupIds;
  for (const [client, bankId, cfg] of [
    [bank2Client, "bank2", configs.bank2],
    [bank3Client, "bank3", configs.bank3],
    [bank4Client, "bank4", configs.bank4],
  ] as const) {
    const investorLookup = `${cfg.identity}@${cfg.nodeId}`;
    const expectedGroupId = groupIds[bankId];
    const found = await client.findGroupsWithMembers([investorLookup, bondCustodianLookup]);
    check(`${bankId}: findGroupsWithMembers finds its investor+custodian group from the investor side`, found.length === 1 && found[0].groupId.toLowerCase() === expectedGroupId.toLowerCase(), { found, expectedGroupId });
  }

  logger.log(`\n${failures === 0 ? "ALL SMOKE CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
