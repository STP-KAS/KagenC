// Counterfactual conserver for a fungible covenant output.
// Field order follows Draft kcc-0020.md: amount, owner, owner_scheme,
// borrow_scheme, borrow_guard, extension_commitment.
// This file does not compile a KCC-20 program. Four public objects already
// share that name and they are not one ABI. Nothing here is broadcast unless
// the master-file text says a spendable L1 stable and a Final KCC-20 both exist.

import { Rule } from "../native/split.mjs";

export const FIELD_ORDER = Object.freeze([
  "amount",
  "owner",
  "owner_scheme",
  "borrow_scheme",
  "borrow_guard",
  "extension_commitment",
]);

export function kccStableLanded(nowText) {
  if (typeof nowText !== "string") return false;
  if (nowText.includes("No KCC-20 Final")) return false;
  if (nowText.includes("No spendable L1 stable")) return false;
  return nowText.includes("KCC-20 Final") && nowText.includes("spendable L1 stable");
}

export function nativeCompilerPinned(nowText) {
  return typeof nowText === "string" && nowText.includes("SilverScript v1.0.0 commit 3ed9733");
}

function cell(output) {
  if (output === null || typeof output !== "object") throw new Rule("token-shape");
  if (typeof output.amount !== "bigint") throw new Rule("token-amount-not-integer");
  if (output.amount < 0n) throw new Rule("token-amount-negative");
  if (typeof output.extension !== "string" || output.extension.length === 0) throw new Rule("extension");
  if (typeof output.owner !== "string" || output.owner.length === 0) throw new Rule("token-owner");
  if (output.kas !== undefined) throw new Rule("kas-is-not-the-token");
  return output;
}

export function conserve(inputs, outputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Rule("token-inputs");
  if (!Array.isArray(outputs) || outputs.length === 0) throw new Rule("token-outputs");
  const extension = cell(inputs[0]).extension;
  let inn = 0n;
  for (const input of inputs) {
    const row = cell(input);
    if (row.extension !== extension) throw new Rule("extension-mismatch");
    inn += row.amount;
  }
  let out = 0n;
  for (const output of outputs) {
    const row = cell(output);
    if (row.extension !== extension) throw new Rule("extension-mismatch");
    out += row.amount;
  }
  if (inn !== out) throw new Rule("token-not-conserved");
  return { amount: inn, extension };
}
