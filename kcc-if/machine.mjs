// Same transitions as native/machine.mjs. The integers are token base units.
// KAS is the miner fee and is not an input to the sum.
// broadcastToken() throws until the master-file text says KCC-20 is Final
// and a spendable L1 stable exists. simulate still returns a result,
// marked counterfactual.

import { accept, fund, outputSum } from "../native/machine.mjs";
import { Rule } from "../native/split.mjs";
import { conserve, kccStableLanded } from "./conserve.mjs";

export function fundToken(terms) {
  if (terms.unit === "KAS" || terms.unit === "sompi" || terms.unit === "tether") {
    throw new Rule("native-or-tether-on-token-rail");
  }
  if (typeof terms.extension !== "string" || terms.extension.length === 0) throw new Rule("extension");
  return {
    counterfactual: true,
    extension: terms.extension,
    task: fund(terms),
  };
}

export function settleToken(escrow, buyer) {
  const paid = accept(escrow.task, { buyer });
  const inputs = [
    { amount: escrow.task.held, owner: "escrow", extension: escrow.extension },
  ];
  const tokenOutputs = paid.outputs.map((output) => ({
    amount: output.sompi,
    owner: output.to,
    extension: escrow.extension,
  }));
  conserve(inputs, tokenOutputs);
  if (outputSum(paid.outputs) !== escrow.task.held) throw new Rule("token-payout");
  return {
    counterfactual: true,
    legs: paid.legs,
    tokenOutputs,
    kasFee: "miner-only",
  };
}

export function broadcastToken(masterNowText) {
  if (!kccStableLanded(masterNowText)) throw new Rule("kcc-stable-not-landed");
  return { counterfactual: false };
}
