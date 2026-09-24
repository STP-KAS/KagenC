// KagenC on Testnet-10: fund, claim, submit, accept.
// Refuses any other network. Prints transaction ids only.

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { splitPot } from "../native/split.mjs";

const WASM = process.env.KASPA_WASM;
const WS_FROM = process.env.KASPA_WS_FROM;
const SECRET = process.env.FAUCET_SECRET;
const SILVERC = process.env.SILVERC;
const ENGINE = process.env.KAGEN_ENGINE;
const REWARD = 1_200_000_000n;
const FEE_CHIP = 20_000_000n;
const ZERO = "00".repeat(32);

function need(name, value) {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadKey() {
  const secret = readFileSync(need("FAUCET_SECRET", SECRET), "utf8");
  const pkLine = secret.split(/\r?\n/).find((line) => line.startsWith("receive-0-private-key:"));
  if (!pkLine) throw new Error("secret file has no receive key");
  return pkLine.split(":").slice(1).join(":").trim();
}

function xonly(kaspa, privateKey) {
  const bytes = [...Buffer.from(privateKey.toPublicKey().toXOnlyPublicKey().toString(), "hex")];
  if (bytes.length !== 32) throw new Error(`pubkey is ${bytes.length} bytes`);
  return bytes;
}

function freshKey(kaspa) {
  return new kaspa.PrivateKey(randomBytes(32).toString("hex"));
}

function engine(args) {
  const result = spawnSync(ENGINE, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "engine failed");
  return result.stdout.trim();
}

function entryOf(utxo, address) {
  return {
    address,
    outpoint: {
      transactionId: utxo.outpoint.transactionId,
      index: utxo.outpoint.index,
    },
    scriptPublicKey: utxo.entry.scriptPublicKey,
    amount: BigInt(utxo.amount),
    isCoinbase: Boolean(utxo.entry.isCoinbase),
    blockDaaScore: BigInt(utxo.entry.blockDaaScore),
  };
}

function rawSig(value) {
  let hex = String(value).replace(/^0x/, "").trim();
  if (hex.length === 132 && hex.startsWith("41")) hex = hex.slice(2);
  if (hex.length !== 130) throw new Error(`signature is ${hex.length / 2} bytes`);
  return hex;
}

function sigopsForUsed(used) {
  const need = BigInt(used);
  const free = 9999n;
  const per = 100_000n;
  const charged = need > free ? need - free : 0n;
  return Math.min(255, Math.max(1, Number((charged + per - 1n) / per)));
}

async function send(kaspa, rpc, key, from, outputs, priorityFee) {
  const { entries } = await rpc.getUtxosByAddresses([from]);
  const need = outputs.reduce((sum, output) => sum + output.amount, 0n) + priorityFee + 1_000_000n;
  const source = entries
    .filter((row) => BigInt(row.amount) >= need)
    .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))[0];
  const { transactions } = await kaspa.createTransactions({
    entries: source ? [source] : entries,
    outputs,
    priorityFee,
    changeAddress: from,
    networkId: "testnet-10",
  });
  const ids = [];
  for (const pending of transactions) {
    await pending.sign([key]);
    ids.push(String(await pending.submit(rpc)));
  }
  return ids;
}

async function ensureCoin(kaspa, rpc, key, from, target) {
  for (let step = 0; step < 24; step++) {
    const { entries } = await rpc.getUtxosByAddresses([from]);
    const fit = entries.find((row) => {
      const amount = BigInt(row.amount);
      return amount >= target + 1_000_000n && amount <= target * 8n;
    });
    if (fit) return;
    const bigger = entries
      .filter((row) => BigInt(row.amount) > target * 8n)
      .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
    if (!bigger.length) throw new Error("no coin large enough to split");
    const half = BigInt(bigger[0].amount) / 2n;
    await send(kaspa, rpc, key, from, [{ address: from, amount: half }], 100_000n);
    process.stdout.write(`split ${step + 1}\n`);
  }
  throw new Error("could not make a coin near the test size");
}

async function waitAmount(rpc, address, amount) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { entries } = await rpc.getUtxosByAddresses([address]);
    const hit = entries.find((row) => BigInt(row.amount) === amount);
    if (hit) return hit;
    await sleep(3000);
  }
  throw new Error(`output of ${amount} sompi was not visible`);
}

const usedCoins = new Set();

function coinId(utxo) {
  return `${utxo.outpoint.transactionId}:${utxo.outpoint.index}`;
}

async function takeChip(rpc, from) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { entries } = await rpc.getUtxosByAddresses([from]);
    const hit = entries.find((row) => BigInt(row.amount) === FEE_CHIP && !usedCoins.has(coinId(row)));
    if (hit) {
      usedCoins.add(coinId(hit));
      return hit;
    }
    await sleep(2000);
  }
  throw new Error("fee coin was not visible");
}

function forceOutputs(kaspa, tx, legs) {
  tx.outputs = legs.map((leg) => ({
    value: leg.amount,
    scriptPublicKey: kaspa.payToAddressScript(leg.address),
  }));
}

async function relay(kaspa, rpc, { artifactPath, entry, bytecode, argBefore, argAfter, signer, feeSigner, covenantUtxo, covenantAddress, feeUtxo, from, outputs, label }) {
  let sigops = 4;
  const before = argBefore ?? [];
  const after = argAfter ?? [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const zero = "00".repeat(65);
    const placeholder = engine(["--sigscript", artifactPath, entry, bytecode, ...before, zero, ...after]);
    const tx = kaspa.createTransaction(
      [entryOf(covenantUtxo, covenantAddress), entryOf(feeUtxo, from)],
      outputs,
      0n,
      "",
      1,
    );
    forceOutputs(kaspa, tx, outputs);
    tx.version = 0;
    const seen0 = tx.serializeToObject();
    const scriptIndex = seen0.inputs.findIndex((input) => BigInt(input.utxo.amount) === BigInt(covenantUtxo.amount));
    const feeIndex = scriptIndex === 0 ? 1 : 0;
    if (scriptIndex < 0) throw new Error("covenant input was not in the transaction");
    for (const input of tx.inputs) {
      input.computeBudget = 0;
      input.sigOpCount = 1;
    }
    tx.inputs[scriptIndex].sigOpCount = sigops;
    tx.inputs[feeIndex].sequence = BigInt(attempt * 10 + sigops);
    tx.inputs[scriptIndex].signatureScript = placeholder;
    const signature = rawSig(kaspa.createInputSignature(tx, scriptIndex, signer));
    const finalScript = engine(["--sigscript", artifactPath, entry, bytecode, ...before, signature, ...after]);
    tx.inputs[scriptIndex].signatureScript = finalScript;
    const signed = kaspa.signTransaction(tx, [feeSigner], false);
    signed.version = 0;
    for (const input of signed.inputs) {
      input.computeBudget = 0;
      input.sigOpCount = 1;
    }
    signed.inputs[scriptIndex].sigOpCount = sigops;
    signed.inputs[scriptIndex].signatureScript = finalScript;
    const rebuilt = kaspa.Transaction.deserializeFromObject(signed.serializeToObject());
    try {
      const result = await rpc.submitTransaction({ transaction: rebuilt });
      const id = String(result.transactionId);
      process.stdout.write(`${label} ${id}\n`);
      return id;
    } catch (err) {
      const text = String(err && err.message ? err.message : err);
      const used = text.match(/used=(\d+)/);
      if (!used || attempt === 4) throw err;
      const next = sigopsForUsed(used[1]);
      if (next <= sigops) throw err;
      sigops = next;
      process.stdout.write(`${label} retry sigops ${sigops}\n`);
    }
  }
  throw new Error(`${label} was not accepted`);
}

async function main() {
  need("KASPA_WASM", WASM);
  need("KASPA_WS_FROM", WS_FROM);
  need("SILVERC", SILVERC);
  need("KAGEN_ENGINE", ENGINE);
  const require = createRequire(WS_FROM);
  globalThis.WebSocket = require("websocket").w3cwebsocket;
  const kaspa = await import(pathToFileURL(WASM).href);
  const net = new kaspa.NetworkId("testnet-10");
  if (!String(net).includes("testnet-10")) throw new Error("this wallet path is testnet-10 only");
  const buyerKey = new kaspa.PrivateKey(loadKey());
  const workerKey = freshKey(kaspa);
  const treasuryKey = freshKey(kaspa);
  const operatorKey = freshKey(kaspa);
  const referrerKey = freshKey(kaspa);
  const resolverKey = freshKey(kaspa);
  const from = buyerKey.toAddress(net).toString();
  const parties = [buyerKey, treasuryKey, operatorKey, referrerKey, resolverKey].map((key) => xonly(kaspa, key));
  const ctor = [
    ...parties.map((pub) => ({ kind: "bytes", value: pub })),
    { kind: "int", value: Number(REWARD) },
    { kind: "int", value: 0 },
    { kind: "int", value: 0 },
    { kind: "int", value: 500 },
    { kind: "int", value: 250 },
    { kind: "int", value: 250 },
    { kind: "int", value: 2_000_000_000 },
    { kind: "int", value: 2_000_000_001 },
    { kind: "int", value: 2_000_000_002 },
    { kind: "bytes", value: Array.from({ length: 32 }, () => 0x11) },
  ];
  const dir = mkdtempSync(join(tmpdir(), "kagenc-"));
  const artifactPath = join(dir, "kagenc.json");
  const argsPath = join(dir, "args.json");
  writeFileSync(argsPath, JSON.stringify(ctor));
  const compiled = spawnSync(
    SILVERC,
    [join(process.cwd(), "covenant", "escrow.sil"), "--constructor-args", argsPath, "-o", artifactPath],
    { encoding: "utf8" },
  );
  if (compiled.status !== 0) throw new Error(compiled.stderr || compiled.stdout || "silverc failed");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const openBytecode = Buffer.from(artifact.contracts.KagenC.compiled.bytecode).toString("hex");
  const workerPub = Buffer.from(xonly(kaspa, workerKey)).toString("hex");
  const workerHash = engine(["--hash", workerPub]);
  const proof = "ab".repeat(32);
  const claimedBytecode = engine(["--next", artifactPath, "1", workerHash, ZERO]);
  const submittedBytecode = engine(["--next", artifactPath, "2", workerHash, proof]);

  const rpc = new kaspa.RpcClient({
    resolver: new kaspa.Resolver(),
    encoding: kaspa.Encoding.Borsh,
    networkId: net,
  });
  await rpc.connect();
  const info = await rpc.getServerInfo();
  const networkId = String(info.networkId || info.network_id || "");
  if (!networkId.includes("testnet-10")) throw new Error("resolver is not testnet-10");

  await ensureCoin(kaspa, rpc, buyerKey, from, REWARD);
  for (let i = 0; i < 3; i++) {
    await ensureCoin(kaspa, rpc, buyerKey, from, FEE_CHIP);
    await send(kaspa, rpc, buyerKey, from, [{ address: from, amount: FEE_CHIP }], 100_000n);
  }

  const openAddress = kaspa.addressFromScriptPublicKey(kaspa.payToScriptHashScript(openBytecode), net).toString();
  const claimedAddress = kaspa.addressFromScriptPublicKey(kaspa.payToScriptHashScript(claimedBytecode), net).toString();
  const submittedAddress = kaspa.addressFromScriptPublicKey(kaspa.payToScriptHashScript(submittedBytecode), net).toString();

  const runPath = join(dir, "run.local.json");
  writeFileSync(
    runPath,
    JSON.stringify({
      buyer: buyerKey.toString(),
      worker: workerKey.toString(),
      treasury: treasuryKey.toString(),
      operator: operatorKey.toString(),
      referrer: referrerKey.toString(),
      resolver: resolverKey.toString(),
    }),
  );
  const fundIds = await send(kaspa, rpc, buyerKey, from, [{ address: openAddress, amount: REWARD }], 100_000n);
  process.stdout.write(`funded ${fundIds.join(",")}\n`);
  const openUtxo = await waitAmount(rpc, openAddress, REWARD);

  const claimFee = await takeChip(rpc, from);
  await relay(kaspa, rpc, {
    artifactPath,
    entry: "claim",
    bytecode: openBytecode,
    argBefore: [workerPub],
    signer: workerKey,
    feeSigner: buyerKey,
    covenantUtxo: openUtxo,
    covenantAddress: openAddress,
    feeUtxo: claimFee,
    from,
    outputs: [{ address: claimedAddress, amount: REWARD }],
    label: "claimed",
  });
  const claimedUtxo = await waitAmount(rpc, claimedAddress, REWARD);

  const submitFee = await takeChip(rpc, from);
  await relay(kaspa, rpc, {
    artifactPath,
    entry: "submit",
    bytecode: claimedBytecode,
    argBefore: [workerPub],
    argAfter: [proof],
    signer: workerKey,
    feeSigner: buyerKey,
    covenantUtxo: claimedUtxo,
    covenantAddress: claimedAddress,
    feeUtxo: submitFee,
    from,
    outputs: [{ address: submittedAddress, amount: REWARD }],
    label: "submitted",
  });
  const submittedUtxo = await waitAmount(rpc, submittedAddress, REWARD);

  const legs = splitPot(REWARD, 500n, 250n, 250n);
  const acceptFee = await takeChip(rpc, from);
  const workerAddress = workerKey.toAddress(net).toString();
  const treasuryAddress = treasuryKey.toAddress(net).toString();
  const operatorAddress = operatorKey.toAddress(net).toString();
  const referrerAddress = referrerKey.toAddress(net).toString();
  await relay(kaspa, rpc, {
    artifactPath,
    entry: "accept",
    bytecode: submittedBytecode,
    argBefore: [workerPub],
    signer: buyerKey,
    feeSigner: buyerKey,
    covenantUtxo: submittedUtxo,
    covenantAddress: submittedAddress,
    feeUtxo: acceptFee,
    from,
    outputs: [
      { address: workerAddress, amount: legs.worker },
      { address: treasuryAddress, amount: legs.protocol },
      { address: operatorAddress, amount: legs.operator },
      { address: referrerAddress, amount: legs.referrer },
    ],
    label: "accepted",
  });

  const paid = await waitAmount(rpc, workerAddress, legs.worker);
  if (BigInt(paid.amount) !== legs.worker) throw new Error("worker was not paid the floor");
  await waitAmount(rpc, treasuryAddress, legs.protocol);
  await waitAmount(rpc, operatorAddress, legs.operator);
  await waitAmount(rpc, referrerAddress, legs.referrer);
  process.stdout.write(
    `paid worker ${legs.worker} treasury ${legs.protocol} operator ${legs.operator} referrer ${legs.referrer}\n`,
  );

  for (const [key, amount] of [
    [workerKey, legs.worker],
    [treasuryKey, legs.protocol],
    [operatorKey, legs.operator],
    [referrerKey, legs.referrer],
  ]) {
    try {
      const back = amount - 5_000_000n;
      if (back <= 0n) continue;
      const ids = await send(kaspa, rpc, key, key.toAddress(net).toString(), [{ address: from, amount: back }], 1_000_000n);
      process.stdout.write(`returned ${ids.join(",")}\n`);
    } catch {
      process.stdout.write("return skipped\n");
    }
  }
  unlinkSync(runPath);
  await rpc.disconnect();
  process.stdout.write("cycle ok\n");
}

main().catch((err) => {
  const text = String(err && err.stack ? err.stack : err).replace(/kaspa(?:test)?:[a-z0-9]+/gi, "[address]");
  process.stderr.write(`${text}\n`);
  process.exit(1);
});
