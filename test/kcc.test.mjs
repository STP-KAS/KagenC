import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { claim, submit } from "../native/machine.mjs";
import { conserve, kccStableLanded, nativeCompilerPinned } from "../kcc-if/conserve.mjs";
import { broadcastToken, fundToken, settleToken } from "../kcc-if/machine.mjs";

const hold = readFileSync(new URL("./fixtures/now-hold.txt", import.meta.url), "utf8");
const JOB = "33".repeat(32);
const ART = "ef".repeat(32);

function escrow() {
  const funded = fundToken({
    buyer: "buyer",
    treasury: "treasury",
    operator: "operator",
    referrer: "referrer",
    resolver: "resolver",
    reward: 1_000_000n,
    buyerBond: 0n,
    workerBond: 0n,
    protocolBps: 500n,
    operatorBps: 0n,
    referrerBps: 0n,
    deadlineDaa: 100n,
    reviewDaa: 150n,
    silenceDaa: 200n,
    jobSpec: JOB,
    extension: "draft-kcc20-field-order",
    unit: "token",
  });
  const claimed = claim(funded.task, { worker: "worker", now: 1n }).task;
  funded.task = submit(claimed, { worker: "worker", artifact: ART, now: 2n }).task;
  return funded;
}

test("the published master sentences keep the stable rail shut", () => {
  assert.equal(kccStableLanded(hold), false);
  assert.equal(nativeCompilerPinned(hold), true);
  assert.throws(() => broadcastToken(hold), (err) => err.code === "kcc-stable-not-landed");
});

test("a landed sentence pair is the only key that opens the rail", () => {
  assert.equal(kccStableLanded("KCC-20 Final and a spendable L1 stable"), true);
  assert.equal(kccStableLanded("No KCC-20 Final but a spendable L1 stable"), false);
});

test("token settlement conserves the pot and does not spend KAS as the wage", () => {
  const paid = settleToken(escrow(), "buyer");
  assert.equal(paid.counterfactual, true);
  assert.equal(paid.kasFee, "miner-only");
  const sum = paid.tokenOutputs.reduce((n, row) => n + row.amount, 0n);
  assert.equal(sum, 1_000_000n);
  assert.equal(paid.legs.protocol, 50_000n);
  assert.equal(paid.legs.worker, 950_000n);
});

test("tether is not a unit on either rail", () => {
  assert.throws(
    () =>
      fundToken({
        buyer: "buyer",
        treasury: "treasury",
        operator: "operator",
        referrer: "referrer",
        resolver: "resolver",
        reward: 10n,
        buyerBond: 0n,
        workerBond: 0n,
        protocolBps: 0n,
        operatorBps: 0n,
        referrerBps: 0n,
        deadlineDaa: 2n,
        reviewDaa: 3n,
        silenceDaa: 4n,
        jobSpec: JOB,
        extension: "usdt",
        unit: "tether",
      }),
    (err) => err.code === "native-or-tether-on-token-rail",
  );
});

test("the conserver rejects a broken token output", () => {
  const extension = "same";
  assert.throws(
    () => conserve([{ amount: 5n, owner: "a", extension }], [{ amount: 4n, owner: "b", extension }]),
    (err) => err.code === "token-not-conserved",
  );
  assert.throws(
    () =>
      conserve(
        [{ amount: 5n, owner: "a", extension }],
        [{ amount: 5n, owner: "b", extension: "other" }],
      ),
    (err) => err.code === "extension-mismatch",
  );
  assert.throws(
    () => conserve([{ amount: 5n, owner: "a", extension, kas: 1n }], [{ amount: 5n, owner: "b", extension }]),
    (err) => err.code === "kas-is-not-the-token",
  );
  assert.throws(
    () => conserve([{ amount: -1n, owner: "a", extension }], [{ amount: -1n, owner: "b", extension }]),
    (err) => err.code === "token-amount-negative",
  );
});
