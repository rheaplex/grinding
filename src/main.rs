use cudarc::driver::{CudaDevice, CudaFunction, CudaSlice, LaunchAsync, LaunchConfig};
use cudarc::nvrtc::compile_ptx;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

mod baudot;
mod tnsy;
mod topology;

// Compiled at runtime via NVRTC. Path is relative to this source file.
const KERNEL_SRC: &str = include_str!("../cuda/sha256_search.cu");

// --- Launch shape ------------------------------------------------------------
// One launch covers THREADS * BLOCKS * ITERS nonces. Tune for ~tens of ms per
// launch so the live progress readout updates smoothly. (The nonce budget, CSV
// path, and the tasks themselves live in tasks.toml — see Config below.)
const THREADS: u32 = 256;
const BLOCKS: u32 = 2048;
const ITERS: u32 = 64;
// A search ramps its nonce window from small to this before settling into full
// THREADS*BLOCKS*ITERS launches — so early milestones (t, th, the, …) are seen
// instead of being skipped inside one huge first launch.
const RAMP_MAX: u64 = 1 << 20;
const DEFAULT_CONFIG: &str = "tasks.toml";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ===========================================================================
// ENCODING — the only encoding-aware code. Each scheme turns target *text* into
// a stream of (value, bit-width) symbols; `pack_bits` lays them MSB-first into
// the 256-bit target the kernel compares against. The kernel never changes.
// ===========================================================================
#[derive(Clone, Copy, Debug)]
#[allow(dead_code)] // Ascii7/Baudot are selectable alternatives, not all wired into ENCODINGS
enum Encoding {
    /// One byte per char (num_bits = 8·len). Digest's leading bytes read as ASCII.
    /// `ci` folds case for letters via a don't-care on the 0x20 bit.
    Ascii8 { ci: bool },
    /// Low 7 bits per char, packed (num_bits = 7·len). `ci` as above.
    Ascii7 { ci: bool },
    /// ITA2 "Baudot", 5 bits per code incl. shifts. (Already case-folded.)
    Baudot,
    /// TNSY one-shift 4-bit Baudot-style nibble code. (Already case-folded.)
    Tnsy,
}

/// Where in the 256-bit hash a match may start.
#[derive(Clone, Copy, Debug)]
enum PositionMode {
    Prefix,   // only at bit 0 (start of hash)
    Anywhere, // any of the 256 bit offsets
}

impl PositionMode {
    fn num_positions(self) -> u32 {
        match self {
            PositionMode::Prefix => 1,
            PositionMode::Anywhere => 256,
        }
    }
    fn slug(self) -> &'static str {
        match self {
            PositionMode::Prefix => "prefix",
            PositionMode::Anywhere => "anywhere",
        }
    }
    fn from_slug(s: &str) -> Result<Self, String> {
        match s {
            "prefix" => Ok(PositionMode::Prefix),
            "anywhere" => Ok(PositionMode::Anywhere),
            other => Err(format!("unknown position {other:?} (want prefix|anywhere)")),
        }
    }
}

/// When to stop a single (base, target) search.
#[derive(Clone, Copy, Debug)]
enum MatchMode {
    Full,    // stop as soon as the whole target matches (at any allowed position)
    Longest, // grind the budget, keep the longest run (only a full PREFIX match exits early)
}

impl MatchMode {
    fn slug(self) -> &'static str {
        match self {
            MatchMode::Full => "full",
            MatchMode::Longest => "longest",
        }
    }
    fn from_slug(s: &str) -> Result<Self, String> {
        match s {
            "full" => Ok(MatchMode::Full),
            "longest" => Ok(MatchMode::Longest),
            other => Err(format!("unknown match_mode {other:?} (want full|longest)")),
        }
    }
}

/// How a task's multiple targets relate to each other.
#[derive(Clone, Copy, Debug)]
enum TargetMode {
    /// Each target is its own independent search (one row each), per `match_mode`.
    Each,
    /// Collect every target (full match) off one base grind, in list sequence;
    /// stop the chain if a word isn't found within budget.
    CollectInOrder,
    /// Collect every target (full match) off one base grind; each nonce window
    /// hunts all the not-yet-found words and stores whichever turns up first.
    CollectAnyOrder,
}

impl TargetMode {
    fn slug(self) -> &'static str {
        match self {
            TargetMode::Each => "each",
            TargetMode::CollectInOrder => "collect_in_order",
            TargetMode::CollectAnyOrder => "collect_any_order",
        }
    }
    fn from_slug(s: &str) -> Result<Self, String> {
        match s {
            "each" => Ok(TargetMode::Each),
            "collect_in_order" => Ok(TargetMode::CollectInOrder),
            "collect_any_order" => Ok(TargetMode::CollectAnyOrder),
            other => Err(format!(
                "unknown target_mode {other:?} (want each|collect_in_order|collect_any_order)"
            )),
        }
    }
}

/// Longest `base` allowed in `SourceMode::Plain` — the same 32 bytes a `Hashed`
/// digest occupies, so either way the preimage is at most 32 + 8 = 40 bytes.
const PLAIN_MAX: usize = 32;

/// How a task's source text becomes the fixed prefix the nonce is hashed into.
/// Required per task: there is no default, because the two produce different
/// hashes and the choice is the point, not an implementation detail.
#[derive(Clone, Copy, Debug, PartialEq)]
enum SourceMode {
    /// Plaintext used neat: preimage = `base ‖ nonce`, so the cleartext is
    /// legible in the preimage and the target text surfaces in the digests that
    /// follow. Capped at `PLAIN_MAX` bytes.
    Plain,
    /// For text too long to sit in a block: preimage = `SHA256(base) ‖ nonce`.
    /// No length limit, but only the digest of the source is in the preimage —
    /// the cleartext itself is no longer there to read.
    Hashed,
}

impl SourceMode {
    fn slug(self) -> &'static str {
        match self {
            SourceMode::Plain => "plain",
            SourceMode::Hashed => "hashed",
        }
    }
    fn from_slug(s: &str) -> Result<Self, String> {
        match s {
            "plain" => Ok(SourceMode::Plain),
            "hashed" => Ok(SourceMode::Hashed),
            other => Err(format!("unknown source_mode {other:?}{}", Self::help())),
        }
    }

    /// The two choices spelled out — appended to every error that has to explain
    /// what `source_mode` wants, since there is no default to fall back on.
    fn help() -> String {
        format!(
            "\n  source_mode = \"plain\"   preimage = base ‖ nonce; cleartext readable in the preimage (base <= {PLAIN_MAX} bytes)\
             \n  source_mode = \"hashed\"  preimage = SHA256(base) ‖ nonce; any base length, no cleartext in the preimage"
        )
    }
}

/// A fan-out search: grind `setup ‖ nonce` looking for `targets`. `setup` is
/// either the plaintext `base` itself (`Plain`) or `SHA256(base)` (`Hashed`),
/// per the task's `source_mode`. Built from a `TaskConfig`.
#[derive(Debug)]
struct Task {
    label: String,
    base: String,
    source_mode: SourceMode,
    setup: Vec<u8>, // the fixed prefix the nonce is hashed into: base bytes, or SHA256(base)
    targets: Vec<String>,
    encoding: Encoding,
    position: PositionMode,
    match_mode: MatchMode, // applies to TargetMode::Each (collect modes are always full)
    target_mode: TargetMode,
}

impl Encoding {
    /// Stable, machine-readable name for the CSV (also the tasks.toml spelling).
    fn slug(self) -> String {
        match self {
            Encoding::Ascii8 { ci } => format!("ascii8{}", if ci { "_ci" } else { "" }),
            Encoding::Ascii7 { ci } => format!("ascii7{}", if ci { "_ci" } else { "" }),
            Encoding::Baudot => "baudot".to_string(),
            Encoding::Tnsy => "tnsy".to_string(),
        }
    }
    fn from_slug(s: &str) -> Result<Self, String> {
        match s {
            "ascii8" => Ok(Encoding::Ascii8 { ci: false }),
            "ascii8_ci" => Ok(Encoding::Ascii8 { ci: true }),
            "ascii7" => Ok(Encoding::Ascii7 { ci: false }),
            "ascii7_ci" => Ok(Encoding::Ascii7 { ci: true }),
            "baudot" => Ok(Encoding::Baudot),
            "tnsy" => Ok(Encoding::Tnsy),
            other => Err(format!(
                "unknown encoding {other:?} (want ascii8|ascii8_ci|ascii7|ascii7_ci|baudot|tnsy)"
            )),
        }
    }
}

/// A symbol to pack: `value` in the low `width` bits, MSB-first; `care` marks
/// which of those bits must match (1) vs. are don't-cares (0).
struct Symbol {
    value: u32,
    width: u8,
    care: u32,
}

/// Lay symbols MSB-first into a 256-bit big-endian field, returning the packed
/// target words, the matching care-mask words, and the total bit span.
fn pack_bits(symbols: &[Symbol]) -> ([u32; 8], [u32; 8], u32) {
    let mut words = [0u32; 8];
    let mut care = [0u32; 8];
    let mut pos: u32 = 0;
    for s in symbols {
        for b in (0..s.width).rev() {
            assert!(pos < 256, "target exceeds 256 bits");
            let (w, off) = ((pos / 32) as usize, 31 - (pos % 32));
            if (s.value >> b) & 1 == 1 {
                words[w] |= 1 << off;
            }
            if (s.care >> b) & 1 == 1 {
                care[w] |= 1 << off;
            }
            pos += 1;
        }
    }
    (words, care, pos)
}

/// Build an ASCII symbol of `width` bits (7 or 8). When `ci`, alphabetic chars
/// mark the 0x20 case bit as a don't-care so either case matches.
fn ascii_symbol(ch: u8, width: u8, ci: bool) -> Symbol {
    let full = (1u32 << width) - 1;
    let care = if ci && ch.is_ascii_alphabetic() { full & !0x20 } else { full };
    Symbol { value: (ch as u32) & full, width, care }
}

fn encode_target(
    enc: Encoding,
    target: &str,
) -> Result<([u32; 8], [u32; 8], u32), Box<dyn std::error::Error>> {
    // Baudot/TNSY symbols are fully significant (no don't-cares).
    let exact = |value: u32, width: u8| Symbol { value, width, care: (1u32 << width) - 1 };
    let symbols: Vec<Symbol> = match enc {
        Encoding::Ascii8 { ci } => target.bytes().map(|b| ascii_symbol(b, 8, ci)).collect(),
        Encoding::Ascii7 { ci } => target.bytes().map(|b| ascii_symbol(b, 7, ci)).collect(),
        Encoding::Baudot => baudot::codes(target)
            .map_err(|e| format!("baudot: {e:?}"))?
            .iter()
            .map(|&c| exact(c as u32, 5))
            .collect(),
        Encoding::Tnsy => tnsy::nibbles(target).iter().map(|&n| exact(n as u32, 4)).collect(),
    };
    Ok(pack_bits(&symbols))
}

/// The text actually represented by the target bits (after each encoding's
/// normalization): ASCII passes through, Baudot case-folds letters, TNSY
/// lowercases and strips unsupported characters.
fn normalized_text(enc: Encoding, target: &str) -> String {
    match enc {
        Encoding::Ascii8 { .. } | Encoding::Ascii7 { .. } => target.to_string(),
        Encoding::Baudot => target.to_ascii_lowercase(),
        Encoding::Tnsy => {
            let (bytes, len) = tnsy::encode(target);
            tnsy::decode(&bytes, len).unwrap_or_default()
        }
    }
}

/// The 32-byte setup digest, `SHA256(source)`, computed once per task for
/// `SourceMode::Hashed`. Lets the source be any length, at the cost of the
/// cleartext no longer appearing in the preimage.
fn setup_hash(source: &[u8]) -> [u8; 32] {
    Sha256::digest(source).into()
}

/// Build the fixed message block: preimage = setup ‖ <8 LE nonce bytes>, padded
/// to one SHA-256 block. The nonce region is left zero; the kernel ORs it in.
/// Returns (16 big-endian words, nonce byte offset). `setup` is at most 32 bytes
/// either way, so the 40-byte preimage always fits a single block.
fn build_template(setup: &[u8]) -> ([u32; 16], u32) {
    let preimage_len = setup.len() + 8;
    assert!(preimage_len <= 55, "setup + 8-byte nonce must fit one block");

    let mut block = [0u8; 64];
    block[..setup.len()].copy_from_slice(setup);
    // bytes [setup.len() .. setup.len()+8] stay zero — that's where the nonce goes.
    block[preimage_len] = 0x80; // SHA-256 padding marker
    let bit_len = (preimage_len as u64) * 8;
    block[56..64].copy_from_slice(&bit_len.to_be_bytes());

    let mut words = [0u32; 16];
    for (i, w) in words.iter_mut().enumerate() {
        *w = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
    }
    (words, setup.len() as u32)
}

/// Independent CPU recompute of `SHA256(setup ‖ nonce)` via the `sha2` crate,
/// both to display the winning digest and to verify the GPU actually found what
/// it claims.
fn cpu_digest(setup: &[u8], nonce: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(setup);
    hasher.update(nonce.to_le_bytes());
    hasher.finalize().into()
}

/// Given how many leading bits of the hash matched the encoded target, report
/// the longest *whole-character* prefix of `text` that fits in those bits, and
/// the decoded text. Boundaries come from re-encoding growing prefixes: the
/// encoders are left-to-right stateful passes, so `encode(text[..k])` is exactly
/// the first k chars' slice of `encode(text)`.
fn matched_prefix(enc: Encoding, text: &str, matched_bits: u32) -> (usize, String) {
    let boundaries: Vec<usize> = text.char_indices().map(|(i, _)| i).chain([text.len()]).collect();
    let mut chars = 0;
    for k in 1..boundaries.len() {
        let bits = match encode_target(enc, &text[..boundaries[k]]) {
            Ok((_, _, b)) => b,
            Err(_) => break,
        };
        if bits <= matched_bits {
            chars = k;
        } else {
            break;
        }
    }
    (chars, text[..boundaries[chars]].to_string())
}

fn digest_words(digest: &[u8; 32]) -> [u32; 8] {
    let mut w = [0u32; 8];
    for (i, word) in w.iter_mut().enumerate() {
        *word = u32::from_be_bytes(digest[i * 4..i * 4 + 4].try_into().unwrap());
    }
    w
}

/// 32-bit big-endian window of an 8-word (256-bit) field starting at bit `p`.
/// Mirrors the kernel's `win32`; reads past the end yield zeros.
fn win32(a: &[u32; 8], p: u32) -> u32 {
    let (w, b) = ((p >> 5) as usize, p & 31);
    let hi = if w < 8 { a[w] } else { 0 };
    let lo = if w + 1 < 8 { a[w + 1] } else { 0 };
    if b == 0 { hi } else { (hi << b) | (lo >> (32 - b)) }
}

/// Longest run of leading target bits (under `care`) matching `hash`, sliding the
/// target over `num_positions` start offsets. Returns (length, position). Mirrors
/// the kernel exactly so it can independently verify GPU results.
fn best_match(
    hash: &[u32; 8],
    target: &[u32; 8],
    care: &[u32; 8],
    num_bits: u32,
    num_positions: u32,
) -> (u32, u32) {
    let (mut best_len, mut best_pos) = (0u32, 0u32);
    for pos in 0..num_positions {
        let mut len = 0u32;
        while len < num_bits && pos + len < 256 {
            let remaining = num_bits - len;
            let avail = 256 - (pos + len);
            let chunk = remaining.min(32).min(avail);
            let mask = if chunk == 32 { 0xffff_ffff } else { 0xffff_ffffu32 << (32 - chunk) };
            let x = ((win32(hash, pos + len) ^ win32(target, len)) & win32(care, len)) & mask;
            if x == 0 {
                len += chunk;
                if chunk < 32 {
                    break;
                }
            } else {
                len += x.leading_zeros();
                break;
            }
        }
        if len > best_len {
            best_len = len;
            best_pos = pos;
        }
    }
    (best_len, best_pos)
}

/// Append-only CSV log, flushed after every row so results survive an
/// interrupted grind and downstream tools can read it incrementally.
struct CsvLog {
    file: std::fs::File,
}

impl CsvLog {
    const HEADER: &'static str = "unix_time,task,base,source_mode,encoding,target,encoded_text,\
position_mode,match_mode,target_mode,matched_chars,total_chars,matched_bits,target_bits,\
match_pos,full,prefix,nonce,nonce_hex,digest";

    fn open(path: &str) -> std::io::Result<Self> {
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        if file.metadata()?.len() == 0 {
            writeln!(file, "{}", Self::HEADER)?;
            file.flush()?;
        }
        Ok(Self { file })
    }

    fn row(&mut self, fields: &[String]) -> std::io::Result<()> {
        let line: Vec<String> = fields.iter().map(|f| csv_escape(f)).collect();
        writeln!(self.file, "{}", line.join(","))?;
        self.file.flush()
    }
}

/// RFC 4180 quoting: wrap in double quotes and double any embedded quote when a
/// field contains a comma, quote, or newline (TNSY emits '.'/',' ; names hold spaces).
fn csv_escape(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Holds the GPU handles and launch shape so a single (base, target) nonce
/// window can be fired from anywhere.
struct Engine {
    dev: std::sync::Arc<CudaDevice>,
    func: CudaFunction,
    cfg: LaunchConfig,
    total_threads: u64,
    span: u64,
    budget: u64, // nonces to grind per target before giving up
}

impl Engine {
    /// One launch over [base_nonce, base_nonce + span); returns this window's
    /// best (length, position, absolute nonce) for the target.
    fn launch_window(
        &self,
        d_template: &CudaSlice<u32>,
        nonce_off: u32,
        d_target: &CudaSlice<u32>,
        d_care: &CudaSlice<u32>,
        num_bits: u32,
        num_positions: u32,
        base_nonce: u64,
    ) -> Result<(u32, u32, u64), Box<dyn std::error::Error>> {
        let mut d_best = self.dev.htod_copy(vec![0u64])?;
        unsafe {
            self.func.clone().launch(
                self.cfg,
                (
                    d_template,
                    nonce_off,
                    d_target,
                    d_care,
                    num_bits,
                    num_positions,
                    base_nonce,
                    ITERS,
                    self.total_threads,
                    &mut d_best,
                ),
            )?;
        }
        let packed = self.dev.dtoh_sync_copy(&d_best)?[0];
        let len = (packed >> 55) as u32;
        let pos = 255 - ((packed >> 47) & 0xff) as u32;
        let nonce = base_nonce + (packed & 0x7fff_ffff_ffff);
        Ok((len, pos, nonce))
    }

    /// Like `launch_window` but covers an arbitrary `nonces` count (iters=1, grid
    /// sized to fit) — used for the fine-grained ramp. Returns (best, covered).
    fn launch_sized(
        &self,
        d_template: &CudaSlice<u32>,
        nonce_off: u32,
        d_target: &CudaSlice<u32>,
        d_care: &CudaSlice<u32>,
        num_bits: u32,
        num_positions: u32,
        base_nonce: u64,
        nonces: u64,
    ) -> Result<((u32, u32, u64), u64), Box<dyn std::error::Error>> {
        let threads = nonces.clamp(1, THREADS as u64) as u32;
        let blocks = nonces.div_ceil(threads as u64) as u32;
        let total = blocks as u64 * threads as u64;
        let cfg = LaunchConfig { grid_dim: (blocks, 1, 1), block_dim: (threads, 1, 1), shared_mem_bytes: 0 };
        let mut d_best = self.dev.htod_copy(vec![0u64])?;
        unsafe {
            self.func.clone().launch(
                cfg,
                (d_template, nonce_off, d_target, d_care, num_bits, num_positions, base_nonce, 1u32, total, &mut d_best),
            )?;
        }
        let packed = self.dev.dtoh_sync_copy(&d_best)?[0];
        let len = (packed >> 55) as u32;
        let pos = 255 - ((packed >> 47) & 0xff) as u32;
        let nonce = base_nonce + (packed & 0x7fff_ffff_ffff);
        Ok(((len, pos, nonce), total))
    }
}

/// Keep the better of two results: longer wins, ties prefer the smaller position.
fn better(a: (u32, u32, u64), b: (u32, u32, u64)) -> (u32, u32, u64) {
    if b.0 > a.0 || (b.0 == a.0 && b.0 > 0 && b.1 < a.1) { b } else { a }
}

/// Grind one target across the budget, returning the *climb*: every improvement
/// in (len, pos, nonce), in order, the last entry being the final best. Exits
/// early on a full prefix match always, or any full match if `stop_on_full`.
fn search_target(
    eng: &Engine,
    d_template: &CudaSlice<u32>,
    nonce_off: u32,
    target_bits: &[u32; 8],
    care_bits: &[u32; 8],
    num_bits: u32,
    num_positions: u32,
    stop_on_full: bool,
) -> Result<Vec<(u32, u32, u64)>, Box<dyn std::error::Error>> {
    let d_target = eng.dev.htod_copy(target_bits.to_vec())?;
    let d_care = eng.dev.htod_copy(care_bits.to_vec())?;
    let mut base_nonce = 0u64;
    let mut best = (0u32, 0u32, 0u64);
    let mut climb: Vec<(u32, u32, u64)> = Vec::new();
    let mut window = 16u64; // ramp start; doubles until full-size steady launches
    while base_nonce < eng.budget {
        let (res, covered) = if window < RAMP_MAX {
            let w = window.min(eng.budget - base_nonce);
            let r = eng.launch_sized(d_template, nonce_off, &d_target, &d_care, num_bits, num_positions, base_nonce, w)?;
            window *= 2;
            r
        } else {
            let r = eng.launch_window(d_template, nonce_off, &d_target, &d_care, num_bits, num_positions, base_nonce)?;
            (r, eng.span)
        };
        let merged = better(best, res);
        if merged != best {
            best = merged;
            climb.push(best);
        }
        let full = best.0 == num_bits;
        if (full && best.1 == 0) || (full && stop_on_full) {
            break;
        }
        base_nonce += covered;
    }
    if climb.is_empty() {
        climb.push(best);
    }
    Ok(climb)
}

/// Record a search's climb: one milestone row each time a new whole character is
/// matched, plus a final row for the exact best. So a long grind logs
/// `t -> th -> the -> "the " -> "the f"` instead of just the final partial.
fn record_milestones(
    csv: &mut CsvLog,
    task: &Task,
    target: &str,
    target_bits: &[u32; 8],
    care_bits: &[u32; 8],
    num_bits: u32,
    num_positions: u32,
    climb: &[(u32, u32, u64)],
) -> Result<(), Box<dyn std::error::Error>> {
    let final_best = *climb.last().unwrap();
    let mut last_chars = 0usize;
    for &step in climb {
        let chars = matched_prefix(task.encoding, target, step.0).0;
        if chars > last_chars || step == final_best {
            last_chars = last_chars.max(chars);
            record(csv, task, target, target_bits, care_bits, num_bits, num_positions, step)?;
        }
    }
    Ok(())
}

/// Decode, CPU-verify, print, and append a CSV row for one resolved search.
fn record(
    csv: &mut CsvLog,
    task: &Task,
    target: &str,
    target_bits: &[u32; 8],
    care_bits: &[u32; 8],
    num_bits: u32,
    num_positions: u32,
    best: (u32, u32, u64),
) -> Result<(), Box<dyn std::error::Error>> {
    let (best_len, best_pos, best_nonce) = best;
    let digest = cpu_digest(&task.setup, best_nonce);
    let (vlen, vpos) = best_match(&digest_words(&digest), target_bits, care_bits, num_bits, num_positions);
    let verified = vlen == best_len && (best_len == 0 || vpos == best_pos);

    let (chars, prefix) = matched_prefix(task.encoding, target, best_len);
    let total_chars = target.chars().count();
    let full = chars == total_chars;

    println!(
        "[{:<16}] {:?} -> {:<18?} {}/{} {:>2}/{} ch {:>3}/{} bit @pos {:>3} nonce=0x{:x}{}{}",
        task.target_mode.slug(),
        task.base,
        target,
        task.position.slug(),
        task.match_mode.slug(),
        chars,
        total_chars,
        best_len,
        num_bits,
        best_pos,
        best_nonce,
        if full { "  FULL" } else { "" },
        if verified { "" } else { "  [VERIFY MISMATCH]" },
    );

    csv.row(&[
        unix_now().to_string(),
        task.label.to_string(),
        task.base.to_string(),
        task.source_mode.slug().to_string(),
        task.encoding.slug(),
        target.to_string(),
        normalized_text(task.encoding, target),
        task.position.slug().to_string(),
        task.match_mode.slug().to_string(),
        task.target_mode.slug().to_string(),
        chars.to_string(),
        total_chars.to_string(),
        best_len.to_string(),
        num_bits.to_string(),
        best_pos.to_string(),
        full.to_string(),
        prefix,
        best_nonce.to_string(),
        format!("0x{:x}", best_nonce),
        hex(&digest),
    ])?;
    Ok(())
}

// =====================================================================
// Config: tasks.toml -> Vec<Task>. Optional per-task fields default to
// prefix / longest / each. Run-level knobs live under [run].
// =====================================================================
#[derive(Deserialize)]
struct Config {
    run: RunConfig,
    #[serde(default)]
    task: Vec<TaskConfig>,
}

#[derive(Deserialize)]
struct RunConfig {
    /// Nonce budget per target = 2^budget_bits.
    budget_bits: u32,
    csv: String,
}

#[derive(Deserialize)]
struct TaskConfig {
    label: String,
    /// The initial plaintext, hashed as `base ‖ nonce`. `from` is an alias, so a
    /// task can read naturally as `from = "…"` / `to = "…"`.
    #[serde(alias = "from")]
    base: String,
    /// Explicit target list. Omit when using `to`.
    #[serde(default)]
    targets: Vec<String>,
    /// Shorthand: one string split on whitespace into successive targets, e.g.
    /// `to = "to this"` -> ["to", "this"]. Mutually exclusive with `targets`;
    /// implies target_mode = collect_in_order unless one is set explicitly.
    to: Option<String>,
    /// Required, no default: "plain" (cleartext in the preimage, base <= 32
    /// bytes) or "hashed" (SHA256(base) in the preimage, any length). Optional
    /// here only so a missing value gets a useful error instead of serde's.
    source_mode: Option<String>,
    encoding: String,
    position: Option<String>,
    match_mode: Option<String>,
    target_mode: Option<String>,
}

/// Parse an optional slug field, falling back to `default` when absent.
fn parse_or<T>(o: Option<String>, default: T, f: fn(&str) -> Result<T, String>) -> Result<T, String> {
    match o {
        Some(s) => f(&s),
        None => Ok(default),
    }
}

impl TaskConfig {
    fn build(self) -> Result<Task, String> {
        let label = self.label.clone();
        let ctx = move |e: String| format!("task {label:?}: {e}");

        // Targets come from an explicit `targets` list or the `to` shorthand
        // (split on whitespace), but never both. `to` reads as "search for these
        // words in turn", so it defaults to collect_in_order.
        let (targets, default_target_mode) = match (self.targets.is_empty(), self.to) {
            (false, None) => (self.targets, TargetMode::Each),
            (true, Some(to)) => (
                to.split_whitespace().map(str::to_string).collect(),
                TargetMode::CollectInOrder,
            ),
            (false, Some(_)) => return Err(ctx("set `targets` or `to`, not both".into())),
            (true, None) => return Err(ctx("no targets (set `targets` or `to`)".into())),
        };
        if targets.is_empty() {
            return Err(ctx("`to` had no whitespace-separated words".into()));
        }

        // `plain` keeps the cleartext readable in the preimage, so it only works
        // while base fits beside the nonce in one block; `hashed` lifts that at
        // the cost of the cleartext. Refuse to silently pick one.
        let source_mode = match &self.source_mode {
            Some(s) => SourceMode::from_slug(s).map_err(&ctx)?,
            None => {
                return Err(ctx(format!(
                    "source_mode is required and has no default — set it explicitly:{}",
                    SourceMode::help()
                )));
            }
        };
        let setup = match source_mode {
            SourceMode::Plain if self.base.len() > PLAIN_MAX => {
                return Err(ctx(format!(
                    "source_mode = \"plain\" needs base <= {PLAIN_MAX} bytes, got {}; \
                     use source_mode = \"hashed\" for longer text",
                    self.base.len()
                )));
            }
            SourceMode::Plain => self.base.as_bytes().to_vec(),
            SourceMode::Hashed => setup_hash(self.base.as_bytes()).to_vec(),
        };

        Ok(Task {
            encoding: Encoding::from_slug(&self.encoding).map_err(&ctx)?,
            position: parse_or(self.position, PositionMode::Prefix, PositionMode::from_slug).map_err(&ctx)?,
            match_mode: parse_or(self.match_mode, MatchMode::Longest, MatchMode::from_slug).map_err(&ctx)?,
            target_mode: parse_or(self.target_mode, default_target_mode, TargetMode::from_slug).map_err(&ctx)?,
            label: self.label,
            source_mode,
            setup,
            base: self.base,
            targets,
        })
    }
}

/// Command-line overrides. The single positional arg is the config path.
struct Cli {
    config: String,
    budget_bits: Option<u32>,
    csv: Option<String>,
    only: Vec<String>,
    list: bool,
}

fn parse_cli() -> Result<Cli, String> {
    let mut cli = Cli { config: DEFAULT_CONFIG.into(), budget_bits: None, csv: None, only: vec![], list: false };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut next = || args.next().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--budget-bits" => cli.budget_bits = Some(next()?.parse().map_err(|_| "bad --budget-bits")?),
            "--csv" => cli.csv = Some(next()?),
            "--only" => cli.only.push(next()?),
            "--list" => cli.list = true,
            "-h" | "--help" => {
                println!(
                    "usage: rehashed [CONFIG=tasks.toml] [--budget-bits N] [--csv PATH] \
                     [--only LABEL]... [--list]"
                );
                std::process::exit(0);
            }
            s if s.starts_with('-') => return Err(format!("unknown flag {s}")),
            s => cli.config = s.to_string(),
        }
    }
    Ok(cli)
}

/// Load tasks.toml, apply CLI overrides, return (tasks, budget, csv_path).
fn load_tasks(cli: &Cli) -> Result<(Vec<Task>, u64, String), Box<dyn std::error::Error>> {
    let text = std::fs::read_to_string(&cli.config)
        .map_err(|e| format!("reading {}: {e}", cli.config))?;
    let cfg: Config = toml::from_str(&text).map_err(|e| format!("parsing {}: {e}", cli.config))?;

    let budget_bits = cli.budget_bits.unwrap_or(cfg.run.budget_bits);
    if budget_bits > 64 {
        return Err(format!("budget_bits {budget_bits} too large (max 64; the nonce space is 64-bit)").into());
    }
    // checked_shl avoids the silent `1 << 64 == 1` wrap; bits==64 means the whole space.
    let budget = 1u64.checked_shl(budget_bits).unwrap_or(u64::MAX);
    let csv = cli.csv.clone().unwrap_or(cfg.run.csv);

    // Build every task, then filter: a malformed task is an error in the config
    // whether or not this run happens to select it.
    let mut tasks = Vec::new();
    for tc in cfg.task {
        let keep = cli.only.is_empty() || cli.only.iter().any(|l| l == &tc.label);
        let task = tc.build()?;
        if keep {
            tasks.push(task);
        }
    }
    Ok((tasks, budget, csv))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win32_unaligned() {
        let a = [0xABCD1234, 0xF000_0000, 0, 0, 0, 0, 0, 0];
        assert_eq!(win32(&a, 0), 0xABCD1234);
        assert_eq!(win32(&a, 4), 0xBCD1234F); // crosses into a[1]'s top nibble
        assert_eq!(win32(&a, 32), 0xF000_0000);
        assert_eq!(win32(&a, 224), 0); // last word is zero
        assert_eq!(win32(&a, 252), 0); // reads past the end -> zeros
    }

    #[test]
    fn best_match_finds_nonzero_position() {
        // Target byte 0xAA sits at bit offset 8 of the hash, not at the start.
        let care = [0xffff_ffff; 8];
        let target = [0xAA00_0000, 0, 0, 0, 0, 0, 0, 0];
        let hash = [0x00AA_0000, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(best_match(&hash, &target, &care, 8, 1), (0, 0)); // prefix: no match
        assert_eq!(best_match(&hash, &target, &care, 8, 256), (8, 8)); // anywhere: full at pos 8
    }

    #[test]
    fn best_match_prefix_run() {
        let care = [0xffff_ffff; 8];
        let target = [0xFFFF_0000, 0, 0, 0, 0, 0, 0, 0]; // 16 bits of ones
        let hash = [0xFFF0_0000, 0, 0, 0, 0, 0, 0, 0]; // first 12 bits match, then diverge
        assert_eq!(best_match(&hash, &target, &care, 16, 1), (12, 0));
    }

    /// The GPU hashes `setup ‖ nonce`; in `hashed` mode `setup` must be
    /// `SHA256(source)` and the digest must layer as
    /// `SHA256(SHA256(source) ‖ nonce_le)`. Guards the pre-hash and nonce order.
    #[test]
    fn hashed_digest_layers_correctly() {
        let source = b"a source string far longer than the 32-byte plain limit allows";
        let setup = setup_hash(source);
        assert_eq!(setup.to_vec(), Sha256::digest(source).to_vec());

        let nonce = 0x0123_4567_89ab_cdefu64;
        let mut expect = Sha256::new();
        expect.update(setup);
        expect.update(nonce.to_le_bytes());
        let expect: [u8; 32] = expect.finalize().into();
        assert_eq!(cpu_digest(&setup, nonce), expect);
    }

    /// Build the first task of a config, surfacing parse and validation errors
    /// the same way `load_tasks` does.
    fn build_one(task_toml: &str) -> Result<Task, String> {
        let src = format!("[run]\nbudget_bits = 8\ncsv = \"x.csv\"\n\n[[task]]\n{task_toml}");
        let cfg: Config = toml::from_str(&src).map_err(|e| e.to_string())?;
        cfg.task.into_iter().next().unwrap().build()
    }

    const REST: &str = "to = \"a b\"\nencoding = \"ascii8\"\n";

    #[test]
    fn plain_mode_keeps_cleartext_as_the_preimage_prefix() {
        let t = build_one(&format!(
            "label = \"p\"\nfrom = \"short enough\"\nsource_mode = \"plain\"\n{REST}"
        ))
        .unwrap();
        assert_eq!(t.source_mode, SourceMode::Plain);
        assert_eq!(t.setup, b"short enough".to_vec()); // literal cleartext, not a digest
    }

    #[test]
    fn hashed_mode_substitutes_the_digest() {
        let long = "x".repeat(200);
        let t = build_one(&format!(
            "label = \"h\"\nfrom = \"{long}\"\nsource_mode = \"hashed\"\n{REST}"
        ))
        .unwrap();
        assert_eq!(t.source_mode, SourceMode::Hashed);
        assert_eq!(t.setup, Sha256::digest(long.as_bytes()).to_vec());
    }

    #[test]
    fn plain_mode_rejects_overlong_base() {
        let long = "y".repeat(PLAIN_MAX + 1);
        let err = build_one(&format!(
            "label = \"p\"\nfrom = \"{long}\"\nsource_mode = \"plain\"\n{REST}"
        ))
        .unwrap_err();
        assert!(err.contains("plain") && err.contains("hashed"), "{err}");
    }

    #[test]
    fn plain_mode_accepts_base_exactly_at_the_limit() {
        let at = "z".repeat(PLAIN_MAX);
        let t = build_one(&format!(
            "label = \"p\"\nfrom = \"{at}\"\nsource_mode = \"plain\"\n{REST}"
        ))
        .unwrap();
        assert_eq!(t.setup.len(), PLAIN_MAX);
    }

    #[test]
    fn source_mode_must_be_set_and_valid() {
        // Omitted entirely: named as required, and both choices are spelled out
        // so the fix is in the message rather than the docs.
        let missing = build_one(&format!("label = \"m\"\nfrom = \"hi\"\n{REST}")).unwrap_err();
        for want in ["source_mode", "required", "no default", "plain", "hashed", "32"] {
            assert!(missing.contains(want), "missing {want:?} from: {missing}");
        }

        // A wrong value gets the same guidance, not just a rejection.
        let bogus = build_one(&format!(
            "label = \"m\"\nfrom = \"hi\"\nsource_mode = \"neat\"\n{REST}"
        ))
        .unwrap_err();
        for want in ["neat", "plain", "hashed"] {
            assert!(bogus.contains(want), "missing {want:?} from: {bogus}");
        }
    }
}

fn main() {
    // Print errors via Display, not Debug — config errors are multi-line prose
    // and Debug would escape them into a single \n-riddled line.
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cli = parse_cli()?;
    let (tasks, budget, csv_path) = load_tasks(&cli)?;

    if cli.list {
        for t in &tasks {
            println!(
                "{:<14} {:?} -> {:?}  [{}, {}, {}, {}, {}]",
                t.label,
                t.base,
                t.targets,
                t.source_mode.slug(),
                t.encoding.slug(),
                t.position.slug(),
                t.match_mode.slug(),
                t.target_mode.slug(),
            );
        }
        println!("({} tasks, budget 2^{} nonces, csv {})", tasks.len(), budget.trailing_zeros(), csv_path);
        return Ok(());
    }

    let dev = CudaDevice::new(0)?;
    let ptx = compile_ptx(KERNEL_SRC)?;
    dev.load_ptx(ptx, "search", &["sha256_search"])?;
    let func = dev.get_func("search", "sha256_search").unwrap();

    let mut csv = CsvLog::open(&csv_path)?;
    let total_threads = (THREADS as u64) * (BLOCKS as u64);
    let eng = Engine {
        dev,
        func,
        cfg: LaunchConfig {
            grid_dim: (BLOCKS, 1, 1),
            block_dim: (THREADS, 1, 1),
            shared_mem_bytes: 0,
        },
        total_threads,
        span: total_threads * (ITERS as u64),
        budget,
    };

    for task in tasks {
        let (template, nonce_off) = build_template(&task.setup);
        let d_template = eng.dev.htod_copy(template.to_vec())?;
        let num_positions = task.position.num_positions();
        let enc = |t: &str| encode_target(task.encoding, t);

        match task.target_mode {
            // Each target independent (one row each), per match_mode.
            TargetMode::Each => {
                let stop_on_full = matches!(task.match_mode, MatchMode::Full);
                for target in &task.targets {
                    let target = target.as_str();
                    let (tb, cb, nb) = enc(target)?;
                    let climb = search_target(&eng, &d_template, nonce_off, &tb, &cb, nb, num_positions, stop_on_full)?;
                    record_milestones(&mut csv, &task, target, &tb, &cb, nb, num_positions, &climb)?;
                }
            }

            // Collect each word (full match) in list sequence; stop if one is missing.
            TargetMode::CollectInOrder => {
                for target in &task.targets {
                    let target = target.as_str();
                    let (tb, cb, nb) = enc(target)?;
                    let climb = search_target(&eng, &d_template, nonce_off, &tb, &cb, nb, num_positions, true)?;
                    let best = *climb.last().unwrap();
                    record(&mut csv, &task, target, &tb, &cb, nb, num_positions, best)?;
                    if best.0 != nb {
                        println!("    (stopping: {:?} not found within budget)", target);
                        break;
                    }
                }
            }

            // One shared grind; each window hunts every not-yet-found word and
            // stores whichever turn up (discovery order).
            TargetMode::CollectAnyOrder => {
                struct Pending<'a> {
                    target: &'a str,
                    tb: [u32; 8],
                    cb: [u32; 8],
                    nb: u32,
                    d_target: CudaSlice<u32>,
                    d_care: CudaSlice<u32>,
                    best: (u32, u32, u64),
                }
                let mut pending: Vec<Pending> = Vec::new();
                for target in &task.targets {
                    let target = target.as_str();
                    let (tb, cb, nb) = enc(target)?;
                    pending.push(Pending {
                        target,
                        tb,
                        cb,
                        nb,
                        d_target: eng.dev.htod_copy(tb.to_vec())?,
                        d_care: eng.dev.htod_copy(cb.to_vec())?,
                        best: (0, 0, 0),
                    });
                }

                let mut base_nonce = 0u64;
                while !pending.is_empty() && base_nonce < eng.budget {
                    for p in pending.iter_mut() {
                        let w = eng.launch_window(&d_template, nonce_off, &p.d_target, &p.d_care, p.nb, num_positions, base_nonce)?;
                        p.best = better(p.best, w);
                    }
                    // Record words fully found this window, ordered by the nonce
                    // they landed at (whichever turned up first), then drop them.
                    let mut found: Vec<usize> =
                        (0..pending.len()).filter(|&i| pending[i].best.0 == pending[i].nb).collect();
                    found.sort_by_key(|&i| pending[i].best.2);
                    for &i in &found {
                        let p = &pending[i];
                        record(&mut csv, &task, p.target, &p.tb, &p.cb, p.nb, num_positions, p.best)?;
                    }
                    pending.retain(|p| p.best.0 != p.nb);
                    base_nonce += eng.span;
                }
                // Any words never found: record their best partial.
                for p in &pending {
                    record(&mut csv, &task, p.target, &p.tb, &p.cb, p.nb, num_positions, p.best)?;
                }
            }
        }
    }

    Ok(())
}
