import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_PROTOCOL_FEE_BPS, Rule, splitPot } from "../native/split.mjs";

test("live 500 bps protocol fee on 1_000_000 units", () => {
  const legs = splitPot(1_000_000n, LIVE_PROTOCOL_FEE_BPS, 0n, 0n);
  assert.deepEqual(legs, {
    worker: 950_000n,
    protocol: 50_000n,
    operator: 0n,
    referrer: 0n,
  });
});

test("four legs and the dust stays with the worker", () => {
  const legs = splitPot(10_001n, 500n, 100n, 100n);
  assert.equal(legs.protocol, 500n);
  assert.equal(legs.operator, 100n);
  assert.equal(legs.referrer, 100n);
  assert.equal(legs.worker, 10_001n - 700n);
  assert.equal(legs.worker + legs.protocol + legs.operator + legs.referrer, 10_001n);
});

test("caps reject a worker share under 60 percent", () => {
  assert.throws(() => splitPot(1_000_000n, 2_000n, 2_000n, 1n), (err) => err.code === "combined-fee-above-cap");
  assert.throws(() => splitPot(1_000_000n, 2_001n, 0n, 0n), (err) => err.code === "protocol-fee-too-high");
  assert.throws(() => splitPot(1_000_000n, 0n, 2_001n, 0n), (err) => err.code === "operator-fee-too-high");
  assert.throws(() => splitPot(1_000_000n, 0n, 0n, 2_001n), (err) => err.code === "referrer-fee-too-high");
});

test("the binding caps still pay the worker", () => {
  const legs = splitPot(1_000_000n, 2_000n, 2_000n, 0n);
  assert.equal(legs.worker, 600_000n);
  assert.equal(legs.protocol, 200_000n);
  assert.equal(legs.operator, 200_000n);
});

test("a JSON number is not an amount", () => {
  assert.throws(() => splitPot(9007199254740993, 500n, 0n, 0n), (err) => err instanceof Rule && err.code === "pot-not-integer");
});

test("flooring three legs cannot invent a sompi", () => {
  const pot = 3n;
  const legs = splitPot(pot, 2_000n, 2_000n, 0n);
  assert.equal(legs.protocol, 0n);
  assert.equal(legs.operator, 0n);
  assert.equal(legs.worker, 3n);
});
