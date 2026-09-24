//! Local consensus check for native/escrow.sil.
//! Uses the Kaspa script engine pinned by kaspanet/silverscript v1.0.0.
//! Does not touch a wallet or the network.

use std::collections::BTreeMap;
use std::process::ExitCode;

use blake2b_simd::Params as Blake2bParams;
use kaspa_consensus_core::hashing::sighash::{SigHashReusedValuesUnsync, calc_schnorr_signature_hash};
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::mass::units::SigopCount;
use kaspa_consensus_core::tx::{
    PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput, TransactionOutpoint, TransactionOutput,
    UtxoEntry, VerifiableTransaction,
};
use kaspa_consensus_core::Hash;
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::{
    EngineCtx, EngineFlags, TxScriptEngine, pay_to_script_hash_script, pay_to_script_hash_signature_script_with_flags,
};
use secp256k1::{Keypair, Message, Secp256k1, SecretKey};
use silverscript_abi::{encode_contract_entry_sig_script, encode_runtime_state_script, ArtifactValue, SilAbiArtifact};
use silverscript_lang::compiler::compile_to_sil_abi_artifact;

const SOURCE: &str = include_str!("../../covenant/escrow.sil");
const REWARD: i64 = 100_000;

struct Party {
    keypair: Keypair,
    pubkey: Vec<u8>,
}

fn party(seed: u8) -> Party {
    let secp = Secp256k1::new();
    let secret = SecretKey::from_slice(&[seed; 32]).expect("secret");
    let keypair = Keypair::from_secret_key(&secp, &secret);
    let (xonly, _) = keypair.x_only_public_key();
    Party { keypair, pubkey: xonly.serialize().to_vec() }
}

fn hash32(bytes: &[u8]) -> Vec<u8> {
    Blake2bParams::new().hash_length(32).to_state().update(bytes).finalize().as_bytes().to_vec()
}

fn p2pk(pubkey: &[u8]) -> ScriptPublicKey {
    let mut script = vec![0x20];
    script.extend_from_slice(pubkey);
    script.push(0xac);
    ScriptPublicKey::new(0, script.into())
}

fn compile(buyer: &Party, treasury: &Party, operator: &Party, referrer: &Party, resolver: &Party) -> SilAbiArtifact {
    let job = vec![0x11u8; 32];
    compile_to_sil_abi_artifact(
        SOURCE,
        &[
            buyer.pubkey.clone().into(),
            treasury.pubkey.clone().into(),
            operator.pubkey.clone().into(),
            referrer.pubkey.clone().into(),
            resolver.pubkey.clone().into(),
            ArtifactValue::Int(REWARD),
            ArtifactValue::Int(0),
            ArtifactValue::Int(0),
            ArtifactValue::Int(500),
            ArtifactValue::Int(250),
            ArtifactValue::Int(250),
            ArtifactValue::Int(1_000),
            ArtifactValue::Int(1_500),
            ArtifactValue::Int(2_000),
            job.into(),
        ],
    )
    .expect("covenant compiles")
}

fn with_state(abi: &SilAbiArtifact, phase: i64, worker: &[u8], artifact: &[u8]) -> Vec<u8> {
    let contract = abi.contracts.get("KagenC").expect("contract");
    let mut values = BTreeMap::new();
    values.insert("phase".into(), ArtifactValue::Int(phase));
    values.insert("worker".into(), ArtifactValue::Bytes(worker.to_vec()));
    values.insert("artifact".into(), ArtifactValue::Bytes(artifact.to_vec()));
    let state = encode_runtime_state_script(abi, &contract.runtime_state, &values).expect("state");
    let (prefix, current, suffix) = contract.compiled.script_parts(&contract.compiled.bytecode).expect("parts");
    assert_eq!(current.len(), state.len(), "state encoding changed width");
    [prefix, state.as_slice(), suffix].concat()
}

fn sigscript(abi: &SilAbiArtifact, bytecode: &[u8], entry: &str, args: &[ArtifactValue]) -> Vec<u8> {
    let prefix = encode_contract_entry_sig_script(abi, contract_name(abi), entry, args).expect("entry");
    pay_to_script_hash_signature_script_with_flags(
        bytecode.to_vec(),
        prefix,
        EngineFlags { covenants_enabled: true, ..Default::default() },
    )
    .expect("p2sh wrap")
}

fn sign(tx: &Transaction, entries: &[UtxoEntry], who: &Party) -> Vec<u8> {
    let reused = SigHashReusedValuesUnsync::new();
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let sig_hash = calc_schnorr_signature_hash(&populated, 0, SIG_HASH_ALL, &reused);
    let msg = Message::from_digest_slice(sig_hash.as_bytes().as_slice()).expect("sighash");
    let mut signature = who.keypair.sign_schnorr(msg).as_ref().to_vec();
    signature.push(SIG_HASH_ALL.to_u8());
    signature
}

fn execute(tx: Transaction, entries: Vec<UtxoEntry>) -> Result<(), String> {
    let reused = SigHashReusedValuesUnsync::new();
    let cache = Cache::new(10_000);
    let input = tx.inputs[0].clone();
    let populated = PopulatedTransaction::new(&tx, entries);
    let cov = CovenantsContext::from_tx(&populated).map_err(|err| err.to_string())?;
    let utxo = populated.utxo(0).expect("utxo");
    let mut vm = TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        0,
        utxo,
        EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&cov),
        EngineFlags { covenants_enabled: true, ..Default::default() },
    );
    vm.execute().map_err(|err| format!("{err:?}"))
}

fn utxo(value: u64, bytecode: &[u8]) -> UtxoEntry {
    UtxoEntry::new(
        value,
        pay_to_script_hash_script(bytecode),
        0,
        false,
        Some(Hash::from_bytes([0x11; 32])),
    )
}

fn input(script: Vec<u8>) -> TransactionInput {
    TransactionInput {
        previous_outpoint: TransactionOutpoint { transaction_id: TransactionId::from_bytes([0x44; 32]), index: 0 },
        signature_script: script,
        sequence: 0,
        compute_commit: SigopCount(1).into(),
    }
}

fn signed_tx(bytecode: &[u8], abi: &SilAbiArtifact, entry: &str, args_with_sig_slot: usize, who: &Party, outputs: Vec<TransactionOutput>, value: u64) -> Transaction {
    let mut args = vec![ArtifactValue::Bytes(vec![0; 65]); args_with_sig_slot];
    // Caller fills non-sig args after this helper for the simple one-sig entries.
    let _ = (&mut args, entry);
    let placeholder = sigscript(abi, bytecode, entry, &[ArtifactValue::Bytes(vec![0; 65])]);
    let entries = vec![utxo(value, bytecode)];
    let mut tx = Transaction::new(1, vec![input(placeholder)], outputs, 0, Default::default(), 0, vec![]);
    let signature = sign(&tx, &entries, who);
    tx.inputs[0].signature_script = sigscript(abi, bytecode, entry, &[ArtifactValue::Bytes(signature)]);
    tx
}

fn expect_ok(name: &str, result: Result<(), String>) {
    if let Err(err) = result {
        eprintln!("FAIL {name}: {err}");
        std::process::exit(1);
    }
    println!("ok {name}");
}

fn expect_err(name: &str, result: Result<(), String>) {
    if result.is_ok() {
        eprintln!("FAIL {name}: script accepted a transaction it should refuse");
        std::process::exit(1);
    }
    println!("ok {name}");
}

fn decode_hex(s: &str) -> Vec<u8> {
    let s = s.trim();
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex")).collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn contract_name(abi: &SilAbiArtifact) -> &str {
    abi.contracts.keys().next().expect("one contract")
}

fn next_cli() -> ExitCode {
    let mut args = std::env::args().skip(2);
    let artifact_path = args.next().expect("artifact");
    let phase: i64 = args.next().expect("phase").parse().expect("phase");
    let worker = decode_hex(&args.next().expect("worker"));
    let artifact_bytes = decode_hex(&args.next().expect("artifact-bytes"));
    let text = std::fs::read_to_string(artifact_path).expect("read artifact");
    let abi: SilAbiArtifact = serde_json::from_str(&text).expect("artifact");
    println!("{}", encode_hex(&with_state(&abi, phase, &worker, &artifact_bytes)));
    ExitCode::SUCCESS
}

fn hash_cli() -> ExitCode {
    let hex = std::env::args().nth(2).expect("hex");
    println!("{}", encode_hex(&hash32(&decode_hex(&hex))));
    ExitCode::SUCCESS
}

fn sigscript_cli() -> ExitCode {
    let mut args = std::env::args().skip(2);
    let artifact_path = args.next().expect("artifact");
    let entry = args.next().expect("entry");
    let bytecode = decode_hex(&args.next().expect("bytecode"));
    let mut values = Vec::new();
    for arg in args {
        values.push(ArtifactValue::Bytes(decode_hex(&arg)));
    }
    let text = std::fs::read_to_string(artifact_path).expect("read artifact");
    let abi: SilAbiArtifact = serde_json::from_str(&text).expect("artifact");
    let script = sigscript(&abi, &bytecode, &entry, &values);
    println!("{}", encode_hex(&script));
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        Some("--sigscript") => return sigscript_cli(),
        Some("--next") => return next_cli(),
        Some("--hash") => return hash_cli(),
        _ => {}
    }
    let buyer = party(1);
    let treasury = party(2);
    let operator = party(3);
    let referrer = party(4);
    let resolver = party(5);
    let worker = party(6);
    let abi = compile(&buyer, &treasury, &operator, &referrer, &resolver);
    let open = abi.contracts.get("KagenC").expect("contract").compiled.bytecode.clone();

    let cancel_out = vec![TransactionOutput { value: REWARD as u64, script_public_key: p2pk(&buyer.pubkey), covenant: None }];
    let cancel = signed_tx(&open, &abi, "cancel", 1, &buyer, cancel_out, REWARD as u64);
    expect_ok("cancel", execute(cancel, vec![utxo(REWARD as u64, &open)]));

    let short = vec![TransactionOutput { value: (REWARD as u64) - 1, script_public_key: p2pk(&buyer.pubkey), covenant: None }];
    let short_tx = signed_tx(&open, &abi, "cancel", 1, &buyer, short, REWARD as u64);
    expect_err("cancel refuses a short refund", execute(short_tx, vec![utxo(REWARD as u64, &open)]));

    let worker_hash = hash32(&worker.pubkey);
    let claimed = with_state(&abi, 1, &worker_hash, &[0u8; 32]);
    let claim_out = vec![TransactionOutput {
        value: REWARD as u64,
        script_public_key: pay_to_script_hash_script(&claimed),
        covenant: None,
    }];
    let claim_placeholder = sigscript(
        &abi,
        &open,
        "claim",
        &[ArtifactValue::Bytes(worker.pubkey.clone()), ArtifactValue::Bytes(vec![0; 65])],
    );
    let claim_entries = vec![utxo(REWARD as u64, &open)];
    let mut claim_tx = Transaction::new(1, vec![input(claim_placeholder)], claim_out, 0, Default::default(), 0, vec![]);
    let claim_sig = sign(&claim_tx, &claim_entries, &worker);
    claim_tx.inputs[0].signature_script = sigscript(
        &abi,
        &open,
        "claim",
        &[ArtifactValue::Bytes(worker.pubkey.clone()), ArtifactValue::Bytes(claim_sig)],
    );
    expect_ok("claim", execute(claim_tx, claim_entries));

    let proof = vec![0xabu8; 32];
    let submitted = with_state(&abi, 2, &worker_hash, &proof);
    let legs_worker = 90_000u64;
    let accept_outs = vec![
        TransactionOutput { value: legs_worker, script_public_key: p2pk(&worker.pubkey), covenant: None },
        TransactionOutput { value: 5_000, script_public_key: p2pk(&treasury.pubkey), covenant: None },
        TransactionOutput { value: 2_500, script_public_key: p2pk(&operator.pubkey), covenant: None },
        TransactionOutput { value: 2_500, script_public_key: p2pk(&referrer.pubkey), covenant: None },
    ];
    let accept_placeholder = sigscript(
        &abi,
        &submitted,
        "accept",
        &[ArtifactValue::Bytes(worker.pubkey.clone()), ArtifactValue::Bytes(vec![0; 65])],
    );
    let accept_entries = vec![utxo(REWARD as u64, &submitted)];
    let mut accept_tx = Transaction::new(1, vec![input(accept_placeholder)], accept_outs, 0, Default::default(), 0, vec![]);
    let accept_sig = sign(&accept_tx, &accept_entries, &buyer);
    accept_tx.inputs[0].signature_script = sigscript(
        &abi,
        &submitted,
        "accept",
        &[ArtifactValue::Bytes(worker.pubkey.clone()), ArtifactValue::Bytes(accept_sig)],
    );
    expect_ok("accept", execute(accept_tx, accept_entries));

    let stolen = vec![
        TransactionOutput { value: 1, script_public_key: p2pk(&worker.pubkey), covenant: None },
        TransactionOutput { value: 5_000, script_public_key: p2pk(&treasury.pubkey), covenant: None },
        TransactionOutput { value: 2_500, script_public_key: p2pk(&operator.pubkey), covenant: None },
        TransactionOutput { value: REWARD as u64 - 7_501, script_public_key: p2pk(&buyer.pubkey), covenant: None },
    ];
    let stolen_placeholder = sigscript(
        &abi,
        &submitted,
        "accept",
        &[ArtifactValue::Bytes(worker.pubkey.clone()), ArtifactValue::Bytes(vec![0; 65])],
    );
    let stolen_entries = vec![utxo(REWARD as u64, &submitted)];
    let mut stolen_tx = Transaction::new(1, vec![input(stolen_placeholder)], stolen, 0, Default::default(), 0, vec![]);
    let stolen_sig = sign(&stolen_tx, &stolen_entries, &buyer);
    stolen_tx.inputs[0].signature_script = sigscript(
        &abi,
        &submitted,
        "accept",
        &[ArtifactValue::Bytes(worker.pubkey.clone()), ArtifactValue::Bytes(stolen_sig)],
    );
    expect_err("accept refuses a redirected worker share", execute(stolen_tx, stolen_entries));

    println!("engine passed");
    ExitCode::SUCCESS
}
