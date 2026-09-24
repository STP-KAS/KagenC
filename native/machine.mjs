// Native KAS task escrow. The coins in the covenant output are the escrow.
// No mint, no stable, no global account. Bonds are extra sompi in the same output.
// Reputation is not consulted: the basis points are fixed when the output is created.
// A 5/10/15 bps reputation discount exists in the Solana program and needs a
// reputation account this chain does not have, so it is not applied here.

import { Rule, asInt, splitPot } from "./split.mjs";

export { Rule };

export const PHASE = Object.freeze({
  OPEN: 0,
  CLAIMED: 1,
  SUBMITTED: 2,
  DISPUTED: 3,
});

const MAX_POT = 9_000_000_000_000_000n;
const NIL = "00".repeat(32);

function hex32(value, code) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Rule(code);
  return value;
}

function party(value, code) {
  if (typeof value !== "string" || value.length === 0) throw new Rule(code);
  return value;
}

function bounds(task) {
  for (const key of ["reward", "buyerBond", "workerBond"]) {
    const n = asInt(task[key], `${key}-not-integer`);
    if (n < 0n || n > MAX_POT) throw new Rule(`${key}-out-of-range`);
  }
  if (task.reward <= 0n) throw new Rule("reward-too-small");
  if (task.buyerBond + task.workerBond + task.reward > MAX_POT) throw new Rule("pot-overflow");
}

function copy(task) {
  return {
    phase: task.phase,
    buyer: task.buyer,
    treasury: task.treasury,
    operator: task.operator,
    referrer: task.referrer,
    resolver: task.resolver,
    worker: task.worker,
    reward: task.reward,
    buyerBond: task.buyerBond,
    workerBond: task.workerBond,
    protocolBps: task.protocolBps,
    operatorBps: task.operatorBps,
    referrerBps: task.referrerBps,
    deadlineDaa: task.deadlineDaa,
    reviewDaa: task.reviewDaa,
    silenceDaa: task.silenceDaa,
    jobSpec: task.jobSpec,
    artifact: task.artifact,
    held: task.held,
  };
}

export function fund(terms) {
  const task = {
    phase: PHASE.OPEN,
    buyer: party(terms.buyer, "buyer"),
    treasury: party(terms.treasury, "treasury"),
    operator: party(terms.operator, "operator"),
    referrer: party(terms.referrer, "referrer"),
    resolver: party(terms.resolver, "resolver"),
    worker: null,
    reward: asInt(terms.reward, "reward-not-integer"),
    buyerBond: asInt(terms.buyerBond, "buyerBond-not-integer"),
    workerBond: asInt(terms.workerBond, "workerBond-not-integer"),
    protocolBps: asInt(terms.protocolBps, "protocol-bps-not-integer"),
    operatorBps: asInt(terms.operatorBps, "operator-bps-not-integer"),
    referrerBps: asInt(terms.referrerBps, "referrer-bps-not-integer"),
    deadlineDaa: asInt(terms.deadlineDaa, "deadline-not-integer"),
    reviewDaa: asInt(terms.reviewDaa, "review-not-integer"),
    silenceDaa: asInt(terms.silenceDaa, "silence-not-integer"),
    jobSpec: hex32(terms.jobSpec, "job-spec"),
    artifact: null,
    held: 0n,
  };
  bounds(task);
  if (task.reviewDaa <= task.deadlineDaa) throw new Rule("review-before-deadline");
  if (task.silenceDaa <= task.reviewDaa) throw new Rule("silence-before-review");
  if (task.jobSpec === NIL) throw new Rule("empty-job-spec");
  if (task.referrerBps > 0n && task.referrer === task.buyer) throw new Rule("referrer-is-buyer");
  splitPot(task.reward, task.protocolBps, task.operatorBps, task.referrerBps);
  task.held = task.reward + task.buyerBond;
  return task;
}

function requirePhase(task, phase, code) {
  if (task.phase !== phase) throw new Rule(code);
}

function requireHeld(task, expected) {
  if (task.held !== expected) throw new Rule("held-mismatch");
}

function continuation(task, patch, value) {
  const next = copy(task);
  Object.assign(next, patch);
  next.held = value;
  return { task: next, outputs: [{ to: "covenant", sompi: value }] };
}

export function claim(task, { worker, now }) {
  requirePhase(task, PHASE.OPEN, "not-open");
  if (task.worker !== null || task.artifact !== null) throw new Rule("not-fresh");
  worker = party(worker, "worker");
  asInt(now, "daa-not-integer");
  if (worker === task.buyer) throw new Rule("worker-is-buyer");
  requireHeld(task, task.reward + task.buyerBond);
  const value = task.held + task.workerBond;
  return continuation(task, { phase: PHASE.CLAIMED, worker, artifact: null }, value);
}

export function submit(task, { worker, artifact, now }) {
  requirePhase(task, PHASE.CLAIMED, "not-claimed");
  asInt(now, "daa-not-integer");
  if (worker !== task.worker) throw new Rule("wrong-worker");
  artifact = hex32(artifact, "artifact");
  if (artifact === NIL) throw new Rule("empty-artifact");
  requireHeld(task, task.reward + task.buyerBond + task.workerBond);
  return continuation(task, { phase: PHASE.SUBMITTED, artifact }, task.held);
}

export function reject(task, { buyer, now }) {
  requirePhase(task, PHASE.SUBMITTED, "not-submitted");
  asInt(now, "daa-not-integer");
  if (buyer !== task.buyer) throw new Rule("wrong-buyer");
  requireHeld(task, task.reward + task.buyerBond + task.workerBond);
  return continuation(task, { phase: PHASE.CLAIMED, artifact: null }, task.held);
}

export function cancel(task, { buyer }) {
  requirePhase(task, PHASE.OPEN, "not-open");
  if (buyer !== task.buyer) throw new Rule("wrong-buyer");
  if (task.worker !== null) throw new Rule("worker-still-bound");
  requireHeld(task, task.reward + task.buyerBond);
  return {
    task: null,
    outputs: [{ to: task.buyer, sompi: task.held }],
  };
}

export function expireClaim(task, { now }) {
  requirePhase(task, PHASE.CLAIMED, "not-claimed");
  now = asInt(now, "daa-not-integer");
  if (now < task.deadlineDaa) throw new Rule("deadline-not-reached");
  requireHeld(task, task.reward + task.buyerBond + task.workerBond);
  const keep = task.reward + task.buyerBond;
  const next = copy(task);
  next.phase = PHASE.OPEN;
  next.worker = null;
  next.artifact = null;
  next.held = keep;
  const outputs = [{ to: "covenant", sompi: keep }];
  if (task.workerBond > 0n) outputs.push({ to: task.worker, sompi: task.workerBond });
  return { task: next, outputs };
}

function payout(task) {
  requireHeld(task, task.reward + task.buyerBond + task.workerBond);
  if (task.worker === null) throw new Rule("no-worker");
  if (task.operatorBps > 0n && task.operator === task.worker) throw new Rule("operator-is-worker");
  const legs = splitPot(task.reward, task.protocolBps, task.operatorBps, task.referrerBps);
  const outputs = [{ to: task.worker, sompi: legs.worker }];
  if (legs.protocol > 0n) outputs.push({ to: task.treasury, sompi: legs.protocol });
  if (legs.operator > 0n) outputs.push({ to: task.operator, sompi: legs.operator });
  if (legs.referrer > 0n) outputs.push({ to: task.referrer, sompi: legs.referrer });
  if (task.buyerBond > 0n) outputs.push({ to: task.buyer, sompi: task.buyerBond });
  if (task.workerBond > 0n) outputs.push({ to: task.worker, sompi: task.workerBond });
  const sum = outputs.reduce((n, output) => n + output.sompi, 0n);
  if (sum !== task.held) throw new Rule("payout-not-conserved");
  return { task: null, outputs, legs };
}

export function accept(task, { buyer }) {
  requirePhase(task, PHASE.SUBMITTED, "not-submitted");
  if (buyer !== task.buyer) throw new Rule("wrong-buyer");
  if (task.artifact === null) throw new Rule("no-artifact");
  return payout(task);
}

export function autoAccept(task, { now }) {
  requirePhase(task, PHASE.SUBMITTED, "not-submitted");
  now = asInt(now, "daa-not-integer");
  if (now < task.reviewDaa) throw new Rule("review-not-reached");
  if (task.artifact === null) throw new Rule("no-artifact");
  return payout(task);
}

export function disputeByBuyer(task, { buyer }) {
  requirePhase(task, PHASE.SUBMITTED, "not-submitted");
  if (buyer !== task.buyer) throw new Rule("wrong-buyer");
  requireHeld(task, task.reward + task.buyerBond + task.workerBond);
  return continuation(task, { phase: PHASE.DISPUTED }, task.held);
}

export function disputeByWorker(task, { worker }) {
  requirePhase(task, PHASE.SUBMITTED, "not-submitted");
  if (worker !== task.worker) throw new Rule("wrong-worker");
  requireHeld(task, task.reward + task.buyerBond + task.workerBond);
  return continuation(task, { phase: PHASE.DISPUTED }, task.held);
}

export function resolveToWorker(task, { resolver }) {
  requirePhase(task, PHASE.DISPUTED, "not-disputed");
  if (resolver !== task.resolver) throw new Rule("wrong-resolver");
  return payout(task);
}

export function resolveToBuyer(task, { resolver }) {
  requirePhase(task, PHASE.DISPUTED, "not-disputed");
  if (resolver !== task.resolver) throw new Rule("wrong-resolver");
  requireHeld(task, task.reward + task.buyerBond + task.workerBond);
  const outputs = [{ to: task.buyer, sompi: task.reward + task.buyerBond }];
  if (task.workerBond > 0n) outputs.push({ to: task.worker, sompi: task.workerBond });
  const sum = outputs.reduce((n, output) => n + output.sompi, 0n);
  if (sum !== task.held) throw new Rule("refund-not-conserved");
  return { task: null, outputs };
}

export function silence(task, { now }) {
  requirePhase(task, PHASE.DISPUTED, "not-disputed");
  now = asInt(now, "daa-not-integer");
  if (now < task.silenceDaa) throw new Rule("silence-not-reached");
  return payout(task);
}

export function assertTx(expected, proposed) {
  if (!Array.isArray(proposed) || proposed.length !== expected.length) throw new Rule("output-count");
  for (let i = 0; i < expected.length; i++) {
    if (proposed[i].to !== expected[i].to) throw new Rule("output-dest");
    if (typeof proposed[i].sompi !== "bigint" || proposed[i].sompi !== expected[i].sompi) {
      throw new Rule("output-value");
    }
  }
}

export function outputSum(outputs) {
  return outputs.reduce((n, output) => n + output.sompi, 0n);
}
