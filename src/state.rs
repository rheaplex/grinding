//! Resume support. Two halves of the same job — knowing where an edge's grind
//! already got to, so a restarted run doesn't repeat work:
//!
//!   * `scan_results` reads the output CSV and reports, per edge, the furthest
//!     nonce it has a row for and whether a full match was ever logged. The nonce
//!     is a coarse floor: the CSV only advances when a better match turns up, so
//!     the last row sits behind the true frontier. The full-match flags are what
//!     let a satisfied edge be skipped outright, even when no checkpoint exists.
//!   * `Checkpoint` writes the actual scan frontier to its own file every N
//!     hashes (or every N seconds, whichever comes first), and marks an edge
//!     `satisfied` once its search stopped early on a match it was happy with.
//!     This is the fine resume point an interrupted run picks up from.
//!
//! An edge is identified across runs by (task label, from-word, to-word, params),
//! where `params` is the comparison settings that decide what a scanned nonce
//! means (source mode, encoding, case, position). Change any of those and the old
//! progress is for a different search, so it is ignored rather than resumed.
//!
//! Budget changes fall out of the split between `frontier` and `satisfied`: an
//! edge that stopped because its budget ran out keeps `frontier = old budget`, so
//! a bigger budget resumes it from there, while an edge that stopped because it
//! found what it wanted stays satisfied under any budget.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::time::{Duration, Instant};

/// Identifies one edge's grind across runs.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct EdgeKey {
    pub task: String,
    pub from: String,
    pub to: String,
    /// The comparison settings, as one slash-joined slug (see `main::Task::params`).
    pub params: String,
}

/// What the results CSV already says about an edge.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Seen {
    /// Largest nonce with a row: the scan got at least this far.
    pub frontier: u64,
    /// A full match at bit position 0 was logged — nothing better exists, so any
    /// search that stops on a full prefix match is done.
    pub full_prefix: bool,
    /// A full match at some position was logged — enough for `match_mode = "full"`.
    pub full_any: bool,
}

/// Streaming RFC 4180 reader: yields one record at a time so a multi-hundred-MB
/// results file is never held in memory. Quote-aware, because from/to words and
/// TNSY-encoded text can carry commas that `csv_escape` wrapped in quotes.
struct CsvRecords<R: Read> {
    inner: BufReader<R>,
    // The current chunk of the buffer, consumed by index so the hot loop is a
    // slice lookup rather than a per-byte `io::Result` (which made a debug build
    // take minutes over a large results file).
    buf: Vec<u8>,
    pos: usize,
    peeked: Option<u8>,
}

impl<R: Read> CsvRecords<R> {
    fn new(r: R) -> Self {
        Self { inner: BufReader::with_capacity(1 << 20, r), buf: Vec::new(), pos: 0, peeked: None }
    }

    fn next_byte(&mut self) -> io::Result<Option<u8>> {
        if let Some(b) = self.peeked.take() {
            return Ok(Some(b));
        }
        if self.pos >= self.buf.len() {
            use std::io::BufRead;
            let chunk = self.inner.fill_buf()?;
            if chunk.is_empty() {
                return Ok(None);
            }
            self.buf.clear();
            self.buf.extend_from_slice(chunk);
            let n = chunk.len();
            self.inner.consume(n);
            self.pos = 0;
        }
        let b = self.buf[self.pos];
        self.pos += 1;
        Ok(Some(b))
    }

    /// Read one CSV record into `rec` (reused across calls so a multi-million-row
    /// file costs no per-row allocation), or `false` at clean end of file. Field
    /// bytes are unquoted into one buffer with an end offset per field, so
    /// multi-byte UTF-8 survives intact and only the columns asked for are decoded.
    fn read_record(&mut self, rec: &mut Record) -> io::Result<bool> {
        rec.bytes.clear();
        rec.ends.clear();
        let mut in_quotes = false;
        let mut started = false;
        loop {
            let b = match self.next_byte()? {
                Some(b) => b,
                None => {
                    if started {
                        rec.ends.push(rec.bytes.len());
                        return Ok(true);
                    }
                    return Ok(false);
                }
            };
            started = true;
            if in_quotes {
                if b == b'"' {
                    // A doubled quote is a literal quote; anything else ends the field.
                    match self.next_byte()? {
                        Some(b'"') => rec.bytes.push(b'"'),
                        Some(other) => {
                            in_quotes = false;
                            self.peeked = Some(other);
                        }
                        None => in_quotes = false,
                    }
                } else {
                    rec.bytes.push(b);
                }
            } else {
                match b {
                    b'"' => in_quotes = true,
                    b',' => rec.ends.push(rec.bytes.len()),
                    b'\r' => {} // swallow; the \n ends the record
                    b'\n' => {
                        rec.ends.push(rec.bytes.len());
                        return Ok(true);
                    }
                    _ => rec.bytes.push(b),
                }
            }
        }
    }
}

/// One parsed CSV record: unquoted field bytes back to back, plus where each
/// field ends. Reused from row to row.
#[derive(Default)]
struct Record {
    bytes: Vec<u8>,
    ends: Vec<usize>,
}

impl Record {
    fn len(&self) -> usize {
        self.ends.len()
    }

    /// Field `i`, decoded lossily; panics past `len()`, so check that first.
    fn field(&self, i: usize) -> std::borrow::Cow<'_, str> {
        let start = if i == 0 { 0 } else { self.ends[i - 1] };
        String::from_utf8_lossy(&self.bytes[start..self.ends[i]])
    }

    fn fields(&self) -> Vec<String> {
        (0..self.len()).map(|i| self.field(i).into_owned()).collect()
    }
}

/// RFC 4180 quoting, matching `main::csv_escape`: quote a field that holds a
/// comma, quote, or newline, doubling any embedded quote.
fn esc(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Column indices of `names` in a header record; `None` if any is missing.
fn cols<const N: usize>(header: &[String], names: [&str; N]) -> Option<[usize; N]> {
    let mut out = [0usize; N];
    for (slot, name) in out.iter_mut().zip(names) {
        *slot = header.iter().position(|h| h == name)?;
    }
    Some(out)
}

/// The params slug for a results row, built the same way `main::Task::params`
/// builds it from a task, so the two compare equal for the same settings.
pub fn params_slug(source_mode: &str, encoding: &str, case: &str, position: &str) -> String {
    format!("{source_mode}/{encoding}/{case}/{position}")
}

/// Walk the results CSV and return what it already knows about each edge. A
/// missing file (nothing ground yet) is an empty map, not an error. An
/// unrecognised header (columns renamed) also yields empty rather than guessing.
pub fn scan_results(path: &str) -> io::Result<BTreeMap<EdgeKey, Seen>> {
    let mut map = BTreeMap::new();
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(map),
        Err(e) => return Err(e),
    };
    let mut recs = CsvRecords::new(file);
    let mut rec = Record::default();
    if !recs.read_record(&mut rec)? {
        return Ok(map);
    }
    let Some([task, base, target, nonce, source_mode, encoding, case, position, full, pos]) = cols(
        &rec.fields(),
        ["task", "base", "target", "nonce", "source_mode", "encoding", "case", "position_mode", "full", "match_pos"],
    ) else {
        return Ok(map);
    };
    let need = [task, base, target, nonce, source_mode, encoding, case, position, full, pos]
        .into_iter()
        .max()
        .unwrap();
    // Rows come in runs of the same edge (a spiral logs thousands of hits in a
    // row), so remember the last key and skip rebuilding it while it repeats.
    let mut last: Option<(EdgeKey, Seen)> = None;
    while recs.read_record(&mut rec)? {
        if rec.len() <= need {
            continue;
        }
        let n: u64 = match rec.field(nonce).parse() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let same = last.as_ref().is_some_and(|(k, _)| {
            k.task == rec.field(task)
                && k.from == rec.field(base)
                && k.to == rec.field(target)
                && k.params == params_slug(&rec.field(source_mode), &rec.field(encoding), &rec.field(case), &rec.field(position))
        });
        if !same {
            if let Some((k, s)) = last.take() {
                map.insert(k, s);
            }
            let key = EdgeKey {
                task: rec.field(task).into_owned(),
                from: rec.field(base).into_owned(),
                to: rec.field(target).into_owned(),
                params: params_slug(&rec.field(source_mode), &rec.field(encoding), &rec.field(case), &rec.field(position)),
            };
            let seen = map.remove(&key).unwrap_or_default();
            last = Some((key, seen));
        }
        let seen = &mut last.as_mut().unwrap().1;
        seen.frontier = seen.frontier.max(n);
        if rec.field(full) == "true" {
            seen.full_any = true;
            if rec.field(pos) == "0" {
                seen.full_prefix = true;
            }
        }
    }
    if let Some((k, s)) = last {
        map.insert(k, s);
    }
    Ok(map)
}

/// One edge's checkpointed state.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Progress {
    /// Every nonce below this has been scanned.
    pub frontier: u64,
    /// The search stopped early on a match it was happy with, so no budget will
    /// ever make it worth resuming.
    pub satisfied: bool,
}

/// The scan frontier per edge, persisted so an interrupted run resumes near where
/// it stopped. Written to `path` every `every` hashes or `max_age` of wall-clock,
/// whichever comes first, and once more when an edge completes; the write is a
/// temp-file-then-rename so a kill mid-write can't truncate the previous good
/// state.
pub struct Checkpoint {
    path: String,
    every: u64,
    max_age: Duration,
    edges: BTreeMap<EdgeKey, Progress>,
    since_write: u64,
    last_write: Instant,
}

impl Checkpoint {
    const HEADER: &'static str = "task,from,to,params,frontier,satisfied";

    /// Load an existing checkpoint file (empty if none). `every` is clamped to at
    /// least 1 so a zero from the config still makes progress.
    pub fn load(path: &str, every: u64, max_age: Duration) -> io::Result<Self> {
        let mut edges = BTreeMap::new();
        match File::open(path) {
            Ok(f) => {
                let mut recs = CsvRecords::new(f);
                let mut rec = Record::default();
                if recs.read_record(&mut rec)? {
                    if let Some([t, fr, to, p, n, s]) =
                        cols(&rec.fields(), ["task", "from", "to", "params", "frontier", "satisfied"])
                    {
                        let need = [t, fr, to, p, n, s].into_iter().max().unwrap();
                        while recs.read_record(&mut rec)? {
                            if rec.len() <= need {
                                continue;
                            }
                            if let Ok(frontier) = rec.field(n).parse::<u64>() {
                                let key = EdgeKey {
                                    task: rec.field(t).into_owned(),
                                    from: rec.field(fr).into_owned(),
                                    to: rec.field(to).into_owned(),
                                    params: rec.field(p).into_owned(),
                                };
                                edges.insert(key, Progress { frontier, satisfied: rec.field(s) == "true" });
                            }
                        }
                    }
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        Ok(Self {
            path: path.to_string(),
            every: every.max(1),
            max_age,
            edges,
            since_write: 0,
            last_write: Instant::now(),
        })
    }

    /// The stored progress for an edge; default (nothing scanned) if never seen.
    pub fn progress(&self, key: &EdgeKey) -> Progress {
        self.edges.get(key).copied().unwrap_or_default()
    }

    /// Record a grind's new frontier, flushing once `every` hashes have piled up
    /// since the last write or the last write is older than `max_age`.
    pub fn advance(&mut self, key: &EdgeKey, frontier: u64) -> io::Result<()> {
        let slot = self.edges.entry(key.clone()).or_default();
        self.since_write += frontier.saturating_sub(slot.frontier);
        slot.frontier = slot.frontier.max(frontier);
        if self.since_write >= self.every || self.last_write.elapsed() >= self.max_age {
            self.flush()?;
        }
        Ok(())
    }

    /// Mark an edge finished and persist at once. `satisfied` says why: true when
    /// the search stopped on a match it wanted (skip it under any budget), false
    /// when it merely ran out of budget (its frontier is the resume point should
    /// the budget grow).
    pub fn complete(&mut self, key: &EdgeKey, frontier: u64, satisfied: bool) -> io::Result<()> {
        let slot = self.edges.entry(key.clone()).or_default();
        slot.frontier = slot.frontier.max(frontier);
        slot.satisfied = satisfied;
        self.flush()
    }

    /// Atomically rewrite the whole checkpoint: temp file, then rename over `path`.
    pub fn flush(&mut self) -> io::Result<()> {
        let tmp = format!("{}.tmp", self.path);
        {
            let mut f = File::create(&tmp)?;
            writeln!(f, "{}", Self::HEADER)?;
            for (k, p) in &self.edges {
                writeln!(
                    f,
                    "{},{},{},{},{},{}",
                    esc(&k.task),
                    esc(&k.from),
                    esc(&k.to),
                    esc(&k.params),
                    p.frontier,
                    p.satisfied
                )?;
            }
            f.sync_all()?;
        }
        fs::rename(&tmp, &self.path)?;
        self.since_write = 0;
        self.last_write = Instant::now();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEVER: Duration = Duration::from_secs(u64::MAX / 4);

    /// A unique scratch path under the temp dir, distinct per test name and
    /// process so parallel test runs don't collide.
    fn scratch(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("rehashed_{}_{}", std::process::id(), name))
            .to_string_lossy()
            .into_owned()
    }

    fn key(task: &str, from: &str, to: &str) -> EdgeKey {
        EdgeKey { task: task.into(), from: from.into(), to: to.into(), params: "plain/ascii8/sensitive/prefix".into() }
    }

    fn records(input: &str) -> Vec<Vec<String>> {
        let mut recs = CsvRecords::new(input.as_bytes());
        let mut rec = Record::default();
        let mut out = Vec::new();
        while recs.read_record(&mut rec).unwrap() {
            out.push(rec.fields());
        }
        out
    }

    #[test]
    fn parses_quotes_commas_and_doubled_quotes() {
        // A quoted field with an embedded comma, and one with a doubled quote.
        let got = records("a,\"b,c\",d\n\"say \"\"hi\"\"\",e\n");
        assert_eq!(got, [vec!["a", "b,c", "d"], vec!["say \"hi\"", "e"]]);
    }

    #[test]
    fn tolerates_a_missing_final_newline() {
        assert_eq!(records("x,y,z"), [vec!["x", "y", "z"]]);
    }

    const RESULTS_HEADER: &str =
        "task,base,source_mode,encoding,case,target,position_mode,match_pos,full,nonce\n";

    #[test]
    fn scan_results_takes_the_largest_nonce_per_edge() {
        let path = scratch("scan.csv");
        // Only the resume columns matter; order is found from the header.
        fs::write(
            &path,
            format!(
                "{RESULTS_HEADER}\
                 hue,red,plain,ascii8,sensitive,blue,prefix,0,false,445\n\
                 hue,red,plain,ascii8,sensitive,blue,prefix,0,false,54632\n\
                 hue,red,plain,ascii8,sensitive,blue,prefix,0,false,12\n\
                 hue,pink,plain,ascii8,sensitive,grey,prefix,0,false,900\n"
            ),
        )
        .unwrap();
        let map = scan_results(&path).unwrap();
        assert_eq!(map[&key("hue", "red", "blue")].frontier, 54632);
        assert_eq!(map[&key("hue", "pink", "grey")].frontier, 900);
        assert!(!map[&key("hue", "red", "blue")].full_any);
        fs::remove_file(&path).ok();
    }

    /// A full row at position 0 satisfies everything; one elsewhere only satisfies
    /// a `full` match mode. `scan_results` reports both facts and lets the run
    /// loop decide against the task's settings.
    #[test]
    fn scan_results_notes_full_matches_by_position() {
        let path = scratch("full.csv");
        fs::write(
            &path,
            format!(
                "{RESULTS_HEADER}\
                 t,a,plain,ascii8,sensitive,b,prefix,0,true,10\n\
                 t,a,plain,ascii8,sensitive,c,prefix,17,true,20\n"
            ),
        )
        .unwrap();
        let map = scan_results(&path).unwrap();
        assert_eq!(map[&key("t", "a", "b")], Seen { frontier: 10, full_prefix: true, full_any: true });
        assert_eq!(map[&key("t", "a", "c")], Seen { frontier: 20, full_prefix: false, full_any: true });
        fs::remove_file(&path).ok();
    }

    /// Rows ground under other settings are a different search: they sit under a
    /// different key and are not mistaken for progress on this one.
    #[test]
    fn scan_results_keeps_settings_apart() {
        let path = scratch("params.csv");
        fs::write(
            &path,
            format!(
                "{RESULTS_HEADER}\
                 t,a,plain,ascii8,insensitive,b,prefix,0,true,10\n\
                 t,a,plain,ascii8,sensitive,b,anywhere,0,false,99\n"
            ),
        )
        .unwrap();
        let map = scan_results(&path).unwrap();
        assert!(map.get(&key("t", "a", "b")).is_none());
        let ci = EdgeKey { params: "plain/ascii8/insensitive/prefix".into(), ..key("t", "a", "b") };
        assert!(map[&ci].full_prefix);
        fs::remove_file(&path).ok();
    }

    /// The run-of-rows shortcut must not lose an edge that reappears after a gap
    /// (a task re-run later in the file): both runs fold into one entry.
    #[test]
    fn scan_results_merges_an_edge_that_recurs_after_a_gap() {
        let path = scratch("gap.csv");
        fs::write(
            &path,
            format!(
                "{RESULTS_HEADER}\
                 t,a,plain,ascii8,sensitive,b,prefix,0,false,50\n\
                 t,a,plain,ascii8,sensitive,c,prefix,0,true,5\n\
                 t,a,plain,ascii8,sensitive,b,prefix,0,false,40\n\
                 t,a,plain,ascii8,sensitive,b,prefix,0,true,60\n"
            ),
        )
        .unwrap();
        let map = scan_results(&path).unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map[&key("t", "a", "b")], Seen { frontier: 60, full_prefix: true, full_any: true });
        assert_eq!(map[&key("t", "a", "c")].frontier, 5);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn scan_results_of_a_missing_file_is_empty() {
        assert!(scan_results(&scratch("nope.csv")).unwrap().is_empty());
    }

    #[test]
    fn checkpoint_persists_the_frontier_and_reloads_it() {
        let path = scratch("ckpt.csv");
        let k = key("t", "from", "to");
        {
            // `every` = 1 forces a flush on the first advance.
            let mut cp = Checkpoint::load(&path, 1, NEVER).unwrap();
            assert_eq!(cp.progress(&k), Progress::default());
            cp.advance(&k, 4096).unwrap();
        }
        let reloaded = Checkpoint::load(&path, 1, NEVER).unwrap();
        assert_eq!(reloaded.progress(&k), Progress { frontier: 4096, satisfied: false });
        fs::remove_file(&path).ok();
    }

    #[test]
    fn checkpoint_holds_writes_until_the_threshold() {
        let path = scratch("hold.csv");
        let k = key("t", "a", "b");
        let mut cp = Checkpoint::load(&path, 1000, NEVER).unwrap();
        cp.advance(&k, 400).unwrap(); // under threshold: nothing on disk yet
        assert!(!std::path::Path::new(&path).exists());
        cp.advance(&k, 1200).unwrap(); // crosses 1000: flushes
        assert_eq!(Checkpoint::load(&path, 1, NEVER).unwrap().progress(&k).frontier, 1200);
        fs::remove_file(&path).ok();
    }

    /// A slow grind (say, `anywhere` mode) must not sit for an hour under the hash
    /// threshold: age alone is enough to force a write.
    #[test]
    fn checkpoint_flushes_on_age_too() {
        let path = scratch("age.csv");
        let k = key("t", "a", "b");
        let mut cp = Checkpoint::load(&path, u64::MAX, Duration::ZERO).unwrap();
        cp.advance(&k, 5).unwrap();
        assert_eq!(Checkpoint::load(&path, 1, NEVER).unwrap().progress(&k).frontier, 5);
        fs::remove_file(&path).ok();
    }

    /// Completion keeps the frontier and the reason apart: out-of-budget leaves a
    /// resume point; satisfied is final.
    #[test]
    fn complete_records_frontier_and_satisfaction() {
        let path = scratch("done.csv");
        let spent = key("t", "a", "b");
        let happy = key("t", "a", "c");
        let mut cp = Checkpoint::load(&path, 1 << 30, NEVER).unwrap();
        cp.complete(&spent, 1 << 20, false).unwrap();
        cp.complete(&happy, 777, true).unwrap();
        let back = Checkpoint::load(&path, 1, NEVER).unwrap();
        assert_eq!(back.progress(&spent), Progress { frontier: 1 << 20, satisfied: false });
        assert_eq!(back.progress(&happy), Progress { frontier: 777, satisfied: true });
        fs::remove_file(&path).ok();
    }

    #[test]
    fn keys_with_commas_survive_a_checkpoint_roundtrip() {
        let path = scratch("comma.csv");
        // TNSY targets can carry commas; the CSV must quote and recover them.
        let k = key("t", "a,b", "c");
        let mut cp = Checkpoint::load(&path, 1, NEVER).unwrap();
        cp.advance(&k, 7).unwrap();
        assert_eq!(Checkpoint::load(&path, 1, NEVER).unwrap().progress(&k).frontier, 7);
        fs::remove_file(&path).ok();
    }
}
