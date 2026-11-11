import assert from "node:assert/strict";
import { test } from "node:test";
import { reportGroupParams } from "../src/flows";

// A report-only group has no use for external calls (paladin@v1.0.0 PenteDomain.java:697 defaults them off).
test("the report group config turns external calls off", () => {
  const p = reportGroupParams("g", []);
  assert.equal(p.externalCallsEnabled, false);
  assert.equal(p.evmVersion, "shanghai"); // must stay: the Pente privacy group's EVM version (noto+pente/contracts/foundry.toml)
});
