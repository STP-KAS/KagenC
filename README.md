# KagenC

Experimental. Not advice. Not Kaspa core. Not an audit. Not the AgenC marketplace.

Testnet-10 only. The wallet path refuses every other network.

The earlier reading, which stays a reading, is [STP-KAS/agenc-on-kaspa](https://github.com/STP-KAS/agenc-on-kaspa). This repository is the implementation.

## Why

Kaspa's starting point is proof of work. The coins were issued by work, in the open, from 7 November 2021. No company premine sits under this escrow. Miners order transactions. They do not hold a key that can rewrite a covenant after the deposit is in it.

An agent cannot sit in a board meeting. It can check a script and a transaction. For a one-off job between parties who do not know each other, the useful object is a covenant: the rules are written for that job, everyone who has a part enters it, settlement is one transaction, and when it settles the agreement is gone.

That is the point Michael Sutton made on 23 September 2026, replying to BlackRock. BlackRock's paper, *The Machine-Native Economy* (September 2026), says agentic commerce needs "always-on rails built for high-frequency, low-value payments," and names x402 and other payment protocols. Sutton's reply is that an agent needs more than rails. It needs a way to compose a cheap enforceable covenant on demand, with fast rails where several parties can enter atomically. The example he gave is an agent hiring other agents it neither knows nor trusts, writing the rules for contribution, success, and payment, and letting the agreement disappear once it has settled.

KagenC is that shape for one job, in KAS, on testnet-10. It is not a claim that Kaspa is the whole agent economy. Argent, which Sutton's account points at, has no release tag. This covenant is SilverScript v1.0.0, compiler commit `3ed9733`, because that is the compiler the Kaspa pin board records as the one to use.

## What

A buyer locks KAS. A worker claims and commits a 32-byte hash of the work. The buyer accepts. One transaction pays four legs:

| Leg | Share |
| --- | --- |
| Worker | at least 60 percent, and any rounding dust |
| Treasury | the protocol fee, 500 basis points in the test |
| Operator | the store cut |
| Referrer | the demand cut |

Each fee is `floor(pot * bps / 10000)`. The combined fee cannot pass 4000 basis points. Those numbers are the ones AgenC publishes for its SOL escrow. The unit here is sompi, an integer. There is no JSON number and no stablecoin.

When the accept confirms, the covenant output is spent. Nothing remains that can be upgraded.

## How

`covenant/escrow.sil` is one output. The sompi on it are the escrow.

- Open. The buyer can cancel. The deposit comes back. A second input pays the miner, so the script never hardcodes a fee.
- Claim. The worker binds a key. The output value is checked in the script. `validateOutputState` checks the next script and does not check the amount, so the entry checks the amount itself.
- Submit. The worker commits the hash.
- Accept. The buyer signs. The four outputs are the split.
- After a DAA score, an unsubmitted claim can be unbound, a submission can pay without the buyer, and a silent resolver pays the worker. The coins do not sit forever. SilverScript can only express "not before this score," so that clock is written that way on purpose.

`script/tn10.mjs` is the testnet-10 driver. `explain.html` is the short page.

## Proof of work and proof of stake

Solana, where AgenC already runs, is proof of stake. Validators with stake propose and vote. That is a good fit for a marketplace made of accounts: listings, a bid book, a roster, reputation. AgenC's escrow there is an upgradeable program. Their own note says the upgrade keys still live on one host. An agent paid by that program is trusting the stake-weighted chain and those keys for as long as the coins are inside it.

Kaspa is proof of work. The security assumption is expended work, checked by every node, not a balance of stake. A covenant does not ask a validator to interpret a program account. The script either accepts the spend or it does not. Changing the split means creating a new output. It does not mean upgrading a program that already holds the money.

Both facts can be true. Solana is the better fit for the 101-instruction product AgenC already shipped. Kaspa is the better fit for the escrow itself, because the coins are the escrow and the rule is the script. A stablecoin does not decide that. AgenC's own 4-way hire loop is native SOL. KagenC's wage is KAS.

## What was done

The fee math, the worker floor, and the "money still moves if someone disappears" rule were taken from AgenC and re-implemented against Kaspa's UTXO script. The marketplace, the bid book, the roster, the feed, and the private-zk path were left where they are. vProgs and DAGKnight are not bridges in this repo. One is research. The other is a proposed ordering change. Neither pays the worker.

KCC-20 is still Draft, and there is no spendable L1 stable. `kcc-if/` keeps the conservation rule for a future token and refuses to broadcast while the master file still says so.

## Testing

The script engine from SilverScript v1.0.0 accepted cancel, claim, and accept, and refused a short refund and a redirected worker share. `node --test` is 28 tests, including the master-file sentences that keep the stable rail shut.

On testnet-10, one job went through all four steps. The script checked every one of them. The node accepted them.

| Step | Transaction |
| --- | --- |
| Fund | `153bb339951efc52665c38a2b03b45e7a31772a7f35199b59220bad38e64a501` |
| Claim | `b63c01738d8d91b00351313219dcf7d7c7b36ddeea11a9221ed6cfd6757fe309` |
| Submit | `04f943d4003d3dd0f0ee1c0526343c4775ea1cd4f4a5ab035e4732958c340867` |
| Accept | `703f7b4b1de2b4b28d1a159701ec7002805ee3b8d83e54479ebc651ab5c06907` |

The accept of a 1 KAS pot into four legs was rejected at first. Kaspa's storage-mass rule (KIP-0009) priced those four outputs at 977,779, above the standard limit of 500,000. Extra fee inputs brought the input side of that formula up, and the same output was then accepted. A smaller lesson from the same runs: the cancel and claim paths need a committed sigop count of 2, because they use about 112,000 script units and one sigop unit only covers 109,999. The wallet library this desk used also refuses to build a transaction it scores above 100,000 mass, which is tighter than the node. The accept was built by hand and the node took it.

An earlier claim, `f009004cc3954d88ca7d60bae60d0a4aee38214aed8bd97c9bc654235de6f0d1`, is still open. The submit encoder put the signature in the wrong slot, the process exited, and the worker key had not been written down. That 1 KAS stays in the claimed output. The key is now written for the length of a run and removed when the run finishes.

## Sources

- [tetsuo-ai/agenc-protocol](https://github.com/tetsuo-ai/agenc-protocol) `18795f05496e7a09d7830a27b17cc37720e500cc`. README, `docs/PROGRAM_SURFACE.md`, `docs/ZK_PRIVATE_FLOW.md`, `docs/X402_FAST_PATH.md`, `constants.rs`, `completion_helpers.rs`.
- [BlackRock, *The Machine-Native Economy*](https://www.blackrock.com/us/individual/literature/whitepaper/the-machine-native-economy.pdf), September 2026, and the post that linked it.
- Michael Sutton, 23 September 2026, reply to that post: agents need composable covenants, not only payment rails. https://x.com/michaelsuttonil/status/2102867441818698230
- [STP-KAS/kaspa-master-file](https://github.com/STP-KAS/kaspa-master-file), the pin board this was checked against. SilverScript v1.0.0 `3ed9733`. KCC-20 Draft. No spendable L1 stable. DAGKnight proposed. vProgs not a product.
- [kaspanet/silverscript](https://github.com/kaspanet/silverscript) tag v1.0.0. In particular: `validateOutputState` does not check the output amount, and `tx.daa` exists only as "not before."
- KIP-0009, the storage-mass formula, as implemented in rusty-kaspa. The 977,779 figure was computed from it and then matched the node's rejection.
- A public testnet-10 node, reached through the resolver. No local node and no miner were started.

## Thought process

The first version copied the economic loop and stopped at a local engine plus a cancel on testnet-10. That was a reading. This repository is the same covenant exercised through claim, submit, and accept on the network.

Two failures changed the code. The submit arguments put the signature after the hash, and the script expected the signature between the key and the hash. The accept of a 1 KAS pot into four small outputs is a legal script and an illegal standard transaction, because storage mass counts small outputs as expensive. The fix for a pot that is already funded is more inputs, which the formula rewards. The fix for a new pot is to fund enough that the four legs are not dust. Both are in the scripts.

PoW is the reason to do this on Kaspa. It is not a reason to pretend the marketplace moved. Sutton's sentence is the scope: one agreement, entered atomically, gone when it settles. A 101-instruction program is a different object, and it already exists on Solana.
