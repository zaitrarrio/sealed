//! Writes deterministic RaptorQ test vectors (JSON) produced by the reference `raptorq` crate.
//!
//! Usage: cargo run --release -- [output path]
//! Default output: ../../packages/core/test/vectors/raptorq.json (relative to this crate).

use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha20Rng;
use raptorq::{Encoder, ObjectTransmissionInformation};
use serde_json::{Value, json};
use std::path::PathBuf;

struct Case {
    name: &'static str,
    transfer_length: u64,
    symbol_size: u16,
    max_symbols_per_block: u64,
    alignment: u8,
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

fn div_ceil(a: u64, b: u64) -> u64 {
    a.div_ceil(b)
}

fn main() {
    let out: PathBuf = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/test/vectors/raptorq.json")
    });

    let cases = [
        Case { name: "tiny-single-symbol", transfer_length: 5, symbol_size: 16, max_symbols_per_block: 100, alignment: 8 },
        Case { name: "k10-exact", transfer_length: 160, symbol_size: 16, max_symbols_per_block: 100, alignment: 8 },
        Case { name: "k-padded-ragged-tail", transfer_length: 1001, symbol_size: 16, max_symbols_per_block: 200, alignment: 8 },
        Case { name: "t64-k50", transfer_length: 3200, symbol_size: 64, max_symbols_per_block: 64, alignment: 8 },
        Case { name: "t64-ragged-multiblock", transfer_length: 5000, symbol_size: 64, max_symbols_per_block: 30, alignment: 8 },
        Case { name: "t64-z3-uneven", transfer_length: 64 * 101 - 7, symbol_size: 64, max_symbols_per_block: 40, alignment: 8 },
        Case { name: "t840-k101", transfer_length: 840 * 100 + 1, symbol_size: 840, max_symbols_per_block: 120, alignment: 8 },
        Case { name: "t840-multiblock", transfer_length: 840 * 90 - 333, symbol_size: 840, max_symbols_per_block: 25, alignment: 8 },
        Case { name: "t1024-k256", transfer_length: 1024 * 256, symbol_size: 1024, max_symbols_per_block: 300, alignment: 8 },
        Case { name: "t1024-z5", transfer_length: 1024 * 130 + 17, symbol_size: 1024, max_symbols_per_block: 27, alignment: 8 },
        Case { name: "t16-k300-sparse", transfer_length: 16 * 300 - 3, symbol_size: 16, max_symbols_per_block: 1000, alignment: 8 },
        Case { name: "t16-k1100-large", transfer_length: 16 * 1100, symbol_size: 16, max_symbols_per_block: 2000, alignment: 8 },
        Case { name: "t16-z4-small-blocks", transfer_length: 16 * 41 + 9, symbol_size: 16, max_symbols_per_block: 11, alignment: 8 },
        Case { name: "t64-align4", transfer_length: 2049, symbol_size: 64, max_symbols_per_block: 50, alignment: 4 },
    ];

    let mut rng = ChaCha20Rng::seed_from_u64(0x5EA1_ED00_FEC0_0001);
    let mut out_cases: Vec<Value> = Vec::new();

    for case in &cases {
        let mut data = vec![0u8; case.transfer_length as usize];
        rng.fill(&mut data[..]);

        let kt = div_ceil(case.transfer_length, case.symbol_size as u64);
        let z = div_ceil(kt, case.max_symbols_per_block);
        assert!(z >= 1 && z <= 255);
        let config = ObjectTransmissionInformation::new(case.transfer_length, case.symbol_size, z as u8, 1, case.alignment);
        let encoder = Encoder::new(&data, config);

        let mut blocks: Vec<Value> = Vec::new();
        for (sbn, block) in encoder.get_block_encoders().iter().enumerate() {
            let source = block.source_packets();
            let k = source.len() as u32;
            // Sample source ESIs: first, last and a few random ones.
            let mut esis: Vec<u32> = vec![0, k - 1];
            for _ in 0..4 {
                esis.push(rng.random_range(0..k));
            }
            // Repair ESIs: K..K+50 stride, plus a few far ones.
            let repair_all = block.repair_packets(0, 51);
            let mut repair_pick: Vec<u32> = vec![0, 1, 2, 50];
            for _ in 0..4 {
                repair_pick.push(rng.random_range(0..51));
            }
            esis.sort_unstable();
            esis.dedup();
            repair_pick.sort_unstable();
            repair_pick.dedup();

            let mut symbols: Vec<Value> = Vec::new();
            for &e in &esis {
                let pkt = &source[e as usize];
                assert_eq!(pkt.payload_id().encoding_symbol_id(), e);
                symbols.push(json!({ "esi": e, "data": hex(pkt.data()) }));
            }
            for &r in &repair_pick {
                let pkt = &repair_all[r as usize];
                assert_eq!(pkt.payload_id().encoding_symbol_id(), k + r);
                symbols.push(json!({ "esi": k + r, "data": hex(pkt.data()) }));
            }

            // A decode set: shuffled K..K+3 symbols mixing source and repair (exactly what the
            // TS decoder must recover from). Drop ~1/3 of the source symbols, replace with repair.
            let extra = rng.random_range(0..=3u32);
            let mut src_ids: Vec<u32> = (0..k).collect();
            src_ids.shuffle(&mut rng);
            let dropped = if k == 1 { 0 } else { (k / 3).max(1) };
            src_ids.truncate((k - dropped) as usize);
            let need_repair = dropped + extra;
            let mut decode_set: Vec<Value> = Vec::new();
            for &e in &src_ids {
                decode_set.push(json!({ "esi": e, "data": hex(source[e as usize].data()) }));
            }
            let far = block.repair_packets(7, need_repair);
            for pkt in &far {
                decode_set.push(json!({ "esi": pkt.payload_id().encoding_symbol_id(), "data": hex(pkt.data()) }));
            }
            decode_set.shuffle(&mut rng);

            blocks.push(json!({
                "sbn": sbn,
                "k": k,
                "symbols": symbols,
                "decodeSet": decode_set,
            }));
        }

        let ser = config.serialize();
        out_cases.push(json!({
            "name": case.name,
            "oti": {
                "transferLength": case.transfer_length,
                "symbolSize": case.symbol_size,
                "sourceBlocks": z,
                "subBlocks": 1,
                "alignment": case.alignment,
            },
            "maxSourceSymbolsPerBlock": case.max_symbols_per_block,
            "otiBytes": hex(&ser),
            "data": hex(&data),
            "blocks": blocks,
        }));
    }

    let doc = json!({
        "generator": "tools/fec-vectors",
        "raptorqVersion": "2.0.1",
        "cases": out_cases,
    });
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).expect("create output dir");
    }
    std::fs::write(&out, serde_json::to_string(&doc).expect("serialize")).expect("write vectors");
    eprintln!("wrote {} ({} cases)", out.display(), cases.len());
}
