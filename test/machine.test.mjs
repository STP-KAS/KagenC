import assert from "node:assert/strict";
import test from "node:test";
import {
  accept,
  assertTx,
  autoAccept,
  cancel,
  claim,
  disputeByBuyer,
  disputeByWorker,
  expireClaim,
  fund,
  outputSum,
  reject,
  resolveToBuyer,
  resolveToWorker,
  silence,
  submit,
} from "../native/machine.mjs";
import { LIVE_PROTOCOL_FEE_BPS } from "../native/split.mjs";

const JOB = "11".repeat(32);
const ART = "ab".repeat(32);

function open(extra = {}) {
  return fund({
    buyer: "buyer",
    treasury: "treasury",
    operator: "operator",
    referrer: "referrer",
    resolver: "resolver",
    reward: 1_000_000n,
    buyerBond: 0n,
    workerBond: 0n,
    protocolBps: LIVE_PROTOCOL_FEE_BPS,
    operatorBps: 250n,
    referrerBps: 250n,
    deadlineDaa: 1_000n,
    reviewDaa: 1_500n,
    silenceDaa: 2_000n,
    jobSpec: JOB,
    ...extra,
  });
}

function hired(extra) {
  const task = open(extra);
  const claimed = claim(task, { worker: "worker", now: 10n }).task;
  return submit(claimed, { worker: "worker", artifact: ART, now: 20n }).task;
}

test("accept pays four legs and returns no bond when none was posted", () => {
  const paid = accept(hired(), { buyer: "buyer" });
  assert.equal(outputSum(paid.outputs), 1_000_000n);
  assert.deepEqual(
    paid.outputs.map((row) => row.to),
    ["worker", "treasury", "operator", "referrer"],
  );
  assert.equal(paid.legs.protocol, 50_000n);
  assert.equal(paid.legs.operator, 25_000n);
  assert.equal(paid.legs.referrer, 25_000n);
  assert.equal(paid.legs.worker, 900_000n);
});

test("bonds come back to the side that posted them", () => {
  const paid = accept(hired({ buyerBond: 40_000n, workerBond: 40_000n }), { buyer: "buyer" });
  assert.equal(outputSum(paid.outputs), 1_080_000n);
  const bondBack = paid.outputs.filter((row) => row.sompi === 40_000n);
  assert.deepEqual(
    bondBack.map((row) => row.to),
    ["buyer", "worker"],
  );
});

test("cancel before claim returns the whole deposit to the buyer", () => {
  const task = open({ buyerBond: 5n });
  const out = cancel(task, { buyer: "buyer" });
  assert.equal(out.task, null);
  assert.deepEqual(out.outputs, [{ to: "buyer", sompi: 1_000_005n }]);
});

test("a no-show claim expires and the worker bond is handed back", () => {
  const task = open({ workerBond: 7n });
  const claimed = claim(task, { worker: "worker", now: 10n }).task;
  const expired = expireClaim(claimed, { now: 1_000n });
  assert.equal(expired.task.phase, 0);
  assert.equal(expired.task.worker, null);
  assert.equal(expired.task.held, 1_000_000n);
  assert.deepEqual(expired.outputs[1], { to: "worker", sompi: 7n });
});

test("buyer silence after a submission pays the worker", () => {
  const paid = autoAccept(hired(), { now: 1_500n });
  assert.equal(paid.legs.worker, 900_000n);
});

test("a dispute blocks the timeout pay until the resolver or the silence window", () => {
  const disputed = disputeByBuyer(hired(), { buyer: "buyer" }).task;
  assert.throws(() => autoAccept(disputed, { now: 5_000n }), (err) => err.code === "not-submitted");
  const paid = silence(disputed, { now: 2_000n });
  assert.equal(paid.outputs[0].to, "worker");
});

test("the resolver can send the pot back to the buyer and the worker bond with it", () => {
  let task = hired({ workerBond: 9n });
  task = disputeByWorker(task, { worker: "worker" }).task;
  const out = resolveToBuyer(task, { resolver: "resolver" });
  assert.deepEqual(out.outputs, [
    { to: "buyer", sompi: 1_000_000n },
    { to: "worker", sompi: 9n },
  ]);
});

test("the resolver can complete the same split the buyer would have", () => {
  let task = hired();
  task = disputeByWorker(task, { worker: "worker" }).task;
  const paid = resolveToWorker(task, { resolver: "resolver" });
  assert.equal(paid.legs.worker, 900_000n);
});

test("reject clears the artifact and keeps the coins", () => {
  const task = hired();
  const again = reject(task, { buyer: "buyer", now: 30n }).task;
  assert.equal(again.phase, 1);
  assert.equal(again.artifact, null);
  assert.equal(again.held, task.held);
});

test("a proposed transaction that short-pays the worker is refused", () => {
  const paid = accept(hired(), { buyer: "buyer" });
  const theft = paid.outputs.map((row) => ({ ...row }));
  theft[0] = { to: "worker", sompi: 1n };
  theft.push({ to: "thief", sompi: paid.legs.worker - 1n });
  assert.throws(() => assertTx(paid.outputs, theft), (err) => err.code === "output-count" || err.code === "output-value");
});
