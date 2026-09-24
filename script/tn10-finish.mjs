// Finish a submitted KagenC output whose four pay legs are too small
// for a two-input accept. Extra fee inputs raise the input side of the
// KIP-0009 storage-mass formula. Testnet-10 only. Prints transaction ids only.

import { createRequire } from "node:module";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { splitPot } from "../native/split.mjs";

const WASM = process.env.KASPA_WASM;
const WS_FROM = process.env.KASPA_WS_FROM;
const ENGINE = process.env.KAGEN_ENGINE;
const DIR = process.env.RESUME_DIR;
const REWARD = 100_000_000n;
const CHIP = 10_000_000n;
const CHIPS = 12;

function need(name, value) {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function engine(args) {
  const result = spawnSync(ENGINE, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "engine failed");
  return result.stdout.trim();
}

function rawSig(value) {
  let hex = String(value).replace(/^0x/, "").trim();
  if (hex.length === 132 && hex.startsWith("41")) hex = hex.slice(2);
  if (hex.length !== 130) throw new Error(`signature is ${hex.length / 2} bytes`);
  return hex;
}

function ownedTransaction(kaspa, utxos, outputs, owner) {
  return new kaspa.Transaction({
    version: 0,
    inputs: utxos.map((utxo) => new kaspa.TransactionInput({
      previousOutpoint: { transactionId: utxo.outpoint.transactionId, index: utxo.outpoint.index },
      signatureScript: "",
      sequence: 0n,
      sigOpCount: 1,
      utxo: {
        address: utxo.address || owner,
        outpoint: utxo.outpoint,
        amount: BigInt(utxo.amount),
        scriptPublicKey: utxo.entry.scriptPublicKey,
        blockDaaScore: BigInt(utxo.entry.blockDaaScore),
        isCoinbase: Boolean(utxo.entry.isCoinbase),
      },
    })),
    outputs: outputs.map((output) => new kaspa.TransactionOutput(output.amount, kaspa.payToAddressScript(output.address))),
    lockTime: 0n,
    gas: 0n,
    payload: "",
    subnetworkId: "0000000000000000000000000000000000000000",
  });
}

function entryOf(utxo, address) {
  return {
    address,
    outpoint: { transactionId: utxo.outpoint.transactionId, index: utxo.outpoint.index },
    scriptPublicKey: utxo.entry.scriptPublicKey,
    amount: BigInt(utxo.amount),
    isCoinbase: Boolean(utxo.entry.isCoinbase),
    blockDaaScore: BigInt(utxo.entry.blockDaaScore),
  };
}

async function main() {
  need("KASPA_WASM", WASM);
  need("KASPA_WS_FROM", WS_FROM);
  need("KAGEN_ENGINE", ENGINE);
  need("RESUME_DIR", DIR);
  const require = createRequire(WS_FROM);
  globalThis.WebSocket = require("websocket").w3cwebsocket;
  const kaspa = await import(pathToFileURL(WASM).href);
  const net = new kaspa.NetworkId("testnet-10");
  const run = JSON.parse(readFileSync(join(DIR, "run.local.json"), "utf8"));
  const artifactPath = join(DIR, "kagenc.json");
  const buyerKey = new kaspa.PrivateKey(run.buyer);
  const workerKey = new kaspa.PrivateKey(run.worker);
  const treasuryKey = new kaspa.PrivateKey(run.treasury);
  const operatorKey = new kaspa.PrivateKey(run.operator);
  const referrerKey = new kaspa.PrivateKey(run.referrer);
  const from = buyerKey.toAddress(net).toString();
  const workerPub = Buffer.from(workerKey.toPublicKey().toXOnlyPublicKey().toString(), "hex").toString("hex");
  const workerHash = engine(["--hash", workerPub]);
  const proof = "ab".repeat(32);
  const submittedBytecode = engine(["--next", artifactPath, "2", workerHash, proof]);
  const submittedAddress = kaspa
    .addressFromScriptPublicKey(kaspa.payToScriptHashScript(submittedBytecode), net)
    .toString();

  const rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: net });
  await rpc.connect();
  const info = await rpc.getServerInfo();
  if (!String(info.networkId || "").includes("testnet-10")) throw new Error("resolver is not testnet-10");

  for (let step = 0; step < 24; step++) {
    const { entries } = await rpc.getUtxosByAddresses([from]);
    const small = entries.filter((row) => {
      const amount = BigInt(row.amount);
      return amount >= 5_000_000n && amount <= 12_000_000n;
    });
    process.stdout.write(`small ${small.length}\n`);
    if (small.length >= CHIPS) break;
    const parent = entries
      .filter((row) => BigInt(row.amount) > 12_000_000n)
      .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))[0];
    if (!parent) throw new Error(`only ${small.length} fee coins, and nothing larger to split`);
    const half = BigInt(parent.amount) / 2n;
    const change = BigInt(parent.amount) - half - 500_000n;
    const splitTx = ownedTransaction(kaspa, [parent], [
      { address: from, amount: half },
      { address: from, amount: change },
    ], from);
    const signedSplit = kaspa.signTransaction(splitTx, [buyerKey], false);
    await rpc.submitTransaction({ transaction: signedSplit });
    process.stdout.write(`split ${step + 1}\n`);
    await sleep(1000);
  }

  let submitted;
  let chips = [];
  for (let attempt = 0; attempt < 20 && chips.length < CHIPS; attempt++) {
    const cov = await rpc.getUtxosByAddresses([submittedAddress]);
    submitted = cov.entries.find((row) => BigInt(row.amount) === REWARD);
    const wallet = await rpc.getUtxosByAddresses([from]);
    chips = wallet.entries
      .filter((row) => {
        const amount = BigInt(row.amount);
        return amount >= 5_000_000n && amount <= 12_000_000n;
      })
      .slice(0, CHIPS);
    if (!submitted || chips.length < CHIPS) await sleep(3000);
  }
  if (!submitted || chips.length < CHIPS) throw new Error(`need the deposit and ${CHIPS} fee coins, have ${chips.length}`);

  const legs = splitPot(REWARD, 500n, 250n, 250n);
  const outputs = [
    { address: workerKey.toAddress(net).toString(), amount: legs.worker },
    { address: treasuryKey.toAddress(net).toString(), amount: legs.protocol },
    { address: operatorKey.toAddress(net).toString(), amount: legs.operator },
    { address: referrerKey.toAddress(net).toString(), amount: legs.referrer },
  ];
  const entries = [entryOf(submitted, submittedAddress), ...chips.map((row) => entryOf(row, from))];
  const zero = "00".repeat(65);
  const placeholder = engine(["--sigscript", artifactPath, "accept", submittedBytecode, workerPub, zero]);
  process.stdout.write(`accept-build inputs ${entries.length}\n`);
  const tx = ownedTransaction(
    kaspa,
    [submitted, ...chips],
    outputs,
    from,
  );
  tx.outputs = outputs.map((leg) => ({ value: leg.amount, scriptPublicKey: kaspa.payToAddressScript(leg.address) }));
  tx.version = 0;
  const seen = tx.serializeToObject();
  const scriptIndex = seen.inputs.findIndex((input) => BigInt(input.utxo.amount) === REWARD);
  if (scriptIndex < 0) throw new Error("deposit input missing");
  for (const input of tx.inputs) {
    input.computeBudget = 0;
    input.sigOpCount = 1;
  }
  tx.inputs[scriptIndex].sigOpCount = 4;
  tx.inputs[scriptIndex].signatureScript = placeholder;
  const signature = rawSig(kaspa.createInputSignature(tx, scriptIndex, buyerKey));
  const finalScript = engine(["--sigscript", artifactPath, "accept", submittedBytecode, workerPub, signature]);
  tx.inputs[scriptIndex].signatureScript = finalScript;
  const signed = kaspa.signTransaction(tx, [buyerKey], false);
  signed.version = 0;
  for (const input of signed.inputs) {
    input.computeBudget = 0;
    input.sigOpCount = 1;
  }
  signed.inputs[scriptIndex].sigOpCount = 4;
  signed.inputs[scriptIndex].signatureScript = finalScript;
  const accepted = await rpc.submitTransaction({ transaction: kaspa.Transaction.deserializeFromObject(signed.serializeToObject()) });
  process.stdout.write(`accepted ${String(accepted.transactionId)}\n`);
  unlinkSync(join(DIR, "run.local.json"));
  await rpc.disconnect();
}

main().catch((err) => {
  const text = String(err && err.stack ? err.stack : err).replace(/kaspa(?:test)?:[a-z0-9]+/gi, "[address]");
  process.stderr.write(`${text}\n`);
  process.exit(1);
});
