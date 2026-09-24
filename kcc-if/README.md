# If a stable had landed on KCC

The hire loop in AgenC does not need one.

At `18795f05`, `execute_completion_rewards` refuses an operator or referrer leg when the task has a token mint. The 4-way split is native SOL. A goods purchase can be an SPL token. That is a second rail, and the mint is whoever the listing names. The protocol does not name Tether.

On Kaspa, as of the master file this repo was checked against:

- KCC-20 is Draft. The file, the live program, and the reference pull are not one ABI.
- There is no spendable L1 stable.

`conserve.mjs` implements the conservation rule a fungible covenant would still need: integer amounts, the same extension commitment on every output, and a sum that matches. `broadcastToken` throws while the master text still says `No KCC-20 Final` and `No spendable L1 stable`. `settleToken` still runs, and it marks the result counterfactual.

KAS, in that picture, pays the miner. It is not the wage. The wage is the token amount. Nothing in this directory constructs a transaction.
