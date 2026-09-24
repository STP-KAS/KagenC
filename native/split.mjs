// Integer split of one escrowed pot.
// Same rounding as tetsuo-ai/agenc-protocol completion_helpers.rs
// at 18795f05496e7a09d7830a27b17cc37720e500cc:
// each fee is floor(pot * bps / 10000), and the worker keeps the dust.
// Amounts are bigint sompi (or token base units). Never a JSON number.

export const BPS = 10_000n;
export const MAX_PROTOCOL_FEE_BPS = 2_000n;
export const MAX_OPERATOR_FEE_BPS = 2_000n;
export const MAX_REFERRER_FEE_BPS = 2_000n;
export const MAX_COMBINED_FEE_BPS = 4_000n;
export const WORKER_FLOOR_BPS = 6_000n;
export const LIVE_PROTOCOL_FEE_BPS = 500n;

export class Rule extends Error {
  constructor(code) {
    super(code);
    this.name = "Rule";
    this.code = code;
  }
}

export function asInt(value, code) {
  if (typeof value !== "bigint") throw new Rule(code);
  return value;
}

function fee(pot, bps) {
  return (pot * bps) / BPS;
}

/**
 * @param {bigint} pot
 * @param {bigint} protocolBps
 * @param {bigint} operatorBps
 * @param {bigint} referrerBps
 * @returns {{ worker: bigint, protocol: bigint, operator: bigint, referrer: bigint }}
 */
export function splitPot(pot, protocolBps, operatorBps, referrerBps) {
  pot = asInt(pot, "pot-not-integer");
  protocolBps = asInt(protocolBps, "protocol-bps-not-integer");
  operatorBps = asInt(operatorBps, "operator-bps-not-integer");
  referrerBps = asInt(referrerBps, "referrer-bps-not-integer");
  if (pot <= 0n) throw new Rule("pot-too-small");
  if (protocolBps < 0n || protocolBps > MAX_PROTOCOL_FEE_BPS) throw new Rule("protocol-fee-too-high");
  if (operatorBps < 0n || operatorBps > MAX_OPERATOR_FEE_BPS) throw new Rule("operator-fee-too-high");
  if (referrerBps < 0n || referrerBps > MAX_REFERRER_FEE_BPS) throw new Rule("referrer-fee-too-high");
  const combined = protocolBps + operatorBps + referrerBps;
  if (combined > MAX_COMBINED_FEE_BPS) throw new Rule("combined-fee-above-cap");
  const workerBps = BPS - combined;
  if (workerBps < WORKER_FLOOR_BPS) throw new Rule("worker-floor");
  const protocol = fee(pot, protocolBps);
  const operator = fee(pot, operatorBps);
  const referrer = fee(pot, referrerBps);
  const worker = pot - protocol - operator - referrer;
  if (worker <= 0n) throw new Rule("worker-share-zero");
  if (worker + protocol + operator + referrer !== pot) throw new Rule("split-not-conserved");
  return { worker, protocol, operator, referrer };
}
