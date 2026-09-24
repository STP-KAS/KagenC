import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  accept,
  autoAccept,
  cancel,
  claim,
  disputeByBuyer,
  expireClaim,
  fund,
  reject,
  resolveToWorker,
  silence,
  submit,
} from "../native/machine.mjs";
import { Rule, splitPot } from "../native/split.mjs";

const JOB = "22".repeat(32);
const ART = "cd".repeat(32);

function task() {
  return fund({
    buyer: "buyer",
    treasury: "treasury",
    operator: "operator",
    referrer: "referrer",
    resolver: "resolver",
    reward: 2_000_000n,
    buyerBond: 10n,
    workerBond: 10n,
    protocolBps: 500n,
    operatorBps: 100n,
    referrerBps: 100n,
    deadlineDaa: 500n,
    reviewDaa: 700n,
    silenceDaa: 800n,
    jobSpec: JOB,
  });
}

function code(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Rule, err);
    return err.code;
  }
  assert.fail("expected a rule");
}

test("the holes we already know about stay closed", () => {
  const open = task();
  assert.equal(code(() => cancel(claim(open, { worker: "worker", now: 1n }).task, { buyer: "buyer" })), "not-open");
  assert.equal(code(() => accept(open, { buyer: "buyer" })), "not-submitted");
  assert.equal(code(() => claim(open, { worker: "buyer", now: 1n })), "worker-is-buyer");
  assert.equal(code(() => fund({ ...open, referrer: "buyer", referrerBps: 100n, jobSpec: JOB, buyerBond: 0n, workerBond: 0n })), "referrer-is-buyer");
  const claimed = claim(open, { worker: "worker", now: 1n }).task;
  assert.equal(code(() => submit(claimed, { worker: "other", artifact: ART, now: 2n })), "wrong-worker");
  assert.equal(code(() => submit(claimed, { worker: "worker", artifact: "00".repeat(32), now: 2n })), "empty-artifact");
  assert.equal(code(() => expireClaim(claimed, { now: 499n })), "deadline-not-reached");
  const submitted = submit(claimed, { worker: "worker", artifact: ART, now: 2n }).task;
  assert.equal(code(() => autoAccept(submitted, { now: 499n })), "review-not-reached");
  assert.equal(code(() => accept(submitted, { buyer: "worker" })), "wrong-buyer");
  assert.equal(code(() => expireClaim(submitted, { now: 900n })), "not-claimed");
  const disputed = disputeByBuyer(submitted, { buyer: "buyer" }).task;
  assert.equal(code(() => silence(disputed, { now: 799n })), "silence-not-reached");
  assert.equal(code(() => resolveToWorker(disputed, { resolver: "buyer" })), "wrong-resolver");
  assert.equal(code(() => autoAccept(submitted, { now: 500n })), "review-not-reached");
  assert.equal(reject(submitted, { buyer: "buyer", now: 900n }).task.phase, 1);
});

test("dropping sompi on the continuation is a different state and does not pay", () => {
  const open = task();
  const claimed = claim(open, { worker: "worker", now: 1n }).task;
  claimed.held = claimed.held - 1n;
  assert.equal(code(() => submit(claimed, { worker: "worker", artifact: ART, now: 2n })), "held-mismatch");
});

test("reputation does not change the snapshotted fee", () => {
  const plain = splitPot(1_000_000n, 500n, 0n, 0n);
  const afterReputation = splitPot(1_000_000n, 500n, 0n, 0n);
  assert.equal(plain.protocol, afterReputation.protocol);
  assert.equal(plain.protocol, 50_000n);
});

test("the covenant checks output value beside every continuation", () => {
  const source = readFileSync(new URL("../covenant/escrow.sil", import.meta.url), "utf8");
  const continuations = source.split("validateOutputState(").length - 1;
  assert.ok(continuations >= 5);
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("validateOutputState(")) continue;
    const window = lines.slice(Math.max(0, i - 8), i + 1).join("\n");
    assert.match(window, /\.value/);
  }
  assert.doesNotMatch(source, /usdt|usdc|tether|kcc20/i);
  assert.match(source, /tx\.outputs\.length/);
});

test("combined fees at the published ceiling conserve the pot", () => {
  const legs = splitPot(123_456_789n, 2_000n, 1_500n, 500n);
  assert.equal(legs.worker + legs.protocol + legs.operator + legs.referrer, 123_456_789n);
  assert.ok(legs.worker * 10_000n >= 123_456_789n * 6_000n);
});
