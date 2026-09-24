import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { kccStableLanded, nativeCompilerPinned } from "../kcc-if/conserve.mjs";

const pins = JSON.parse(readFileSync(new URL("../pins.json", import.meta.url), "utf8"));

test("pins record the protocol commit and the fee ceiling", () => {
  assert.equal(pins.agencProtocol.commit, "18795f05496e7a09d7830a27b17cc37720e500cc");
  assert.equal(pins.fee.workerFloorBps, 6000);
  assert.equal(pins.fee.maxCombinedBps, 4000);
  assert.equal(pins.fee.liveProtocolBps, 500);
  assert.equal(pins.masterFile.spendableL1Stable, false);
  assert.equal(pins.masterFile.dagknightShipped, false);
  assert.equal(pins.masterFile.vprogsProduct, false);
  assert.equal(pins.masterFile.kcc20, "Draft");
});

test("the live master file, when pointed at, still holds those sentences", () => {
  const path = process.env.KASPA_MASTER_JSON;
  if (!path) {
    assert.fail("KASPA_MASTER_JSON is required on this desk");
  }
  const text = readFileSync(path, "utf8");
  assert.equal(nativeCompilerPinned(text), true);
  assert.equal(kccStableLanded(text), false);
  assert.match(text, /DAGKnight is KIP-2 Proposed/);
  assert.match(text, /No vProgs product/);
  assert.match(text, /No mainnet x402/);
  assert.match(text, /No spendable L1 stable/);
});
