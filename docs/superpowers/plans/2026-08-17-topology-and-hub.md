# Topology and Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `target_mode` with a `topology` field (plus `hub`) that turns a task's word list into `(from, to)` edges, and move case-folding out of the encoding slug into its own `case` field.

**Architecture:** A new `src/topology.rs` owns the six shapes and the one function that matters — `Topology::edges(words, hub) -> Vec<(from, to)>`. `src/main.rs` keeps everything else: the config structs gain `topology`/`hub`/`words`/`case` and lose `target_mode`/`base`/`targets`, and the run loop flattens into one pass over the edge list. Each edge is an independent search — nonce counter from zero, the run's full `budget_bits` budget — so the two old shared-grind collect modes disappear with `target_mode`. The CUDA kernel is untouched.

**Tech Stack:** Rust 2024 edition, `serde` + `toml` for config, `sha2` for host-side verification, `cudarc` for the GPU (dynamically loaded, so `cargo test` and `--list` both work on a machine with no CUDA).

**Spec:** `docs/superpowers/specs/2026-08-17-topology-and-hub-design.md`

## Global Constraints

- Every edge grinds from nonce zero for the full run-level budget of `2^budget_bits` nonces. No sharing a grind across targets, no continuing a counter between edges.
- `PLAIN_MAX = 32` bytes: under `source_mode = "plain"` every *from*-word must fit, not just one base.
- Config slug vocabulary, exactly these spellings: `topology` = `chain|ring|star_to|star_from|graph|spiral`; `case` = `sensitive|insensitive`; `encoding` = `ascii8|ascii7|baudot|tnsy` (no `_ci` variants); `source_mode` = `plain|hashed`; `position` = `prefix|anywhere`; `match_mode` = `full|longest`.
- Defaults: `case` defaults to `sensitive`, `position` to `prefix`, `match_mode` to `longest`. `topology` and `source_mode` are required with no default.
- All config validation happens at load, before any GPU work, and every error message starts `task "<label>": `.
- Partial matches are always recorded: every edge logs a row per newly matched whole character plus a final row for its exact best.
- No aliases or shims for the removed spellings (`target_mode`, `base`, `from`, `targets`, `ascii8_ci`, `ascii7_ci`). All task files are being rewritten.
- Tests live inline in `#[cfg(test)] mod tests` blocks in the file they test, matching the existing layout. Run everything with `cargo test`; there is no separate `tests/` directory.
- This machine has no CUDA (`nvcc` absent), so no task in this plan runs a grind. `cargo test` and `cargo run -- <config> --list` are the verification tools; `--list` returns before `CudaDevice::new` is ever called.

**Task order matters.** Topology comes before case so that each test fixture is
written once against its final vocabulary rather than rewritten by a later task.
The baseline is 17 passing tests; each task states the total it should reach.

---

### Task 1: `src/topology.rs` — the six shapes

**Files:**
- Create: `src/topology.rs`
- Modify: `src/main.rs:9-10` (add `mod topology;`)
- Test: `src/topology.rs` (inline `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: `pub enum Topology { Chain, Ring, StarTo, StarFrom, Graph, Spiral }` deriving `Clone, Copy, Debug, PartialEq`; `pub const ALL: &str`; and on `Topology`: `pub fn slug(self) -> &'static str`, `pub fn from_slug(s: &str) -> Result<Self, String>`, `pub fn requires_hub(self) -> bool`, `pub fn min_words(self) -> usize`, `pub fn edges(self, words: &[String], hub: Option<&str>) -> Vec<(String, String)>`.

- [ ] **Step 1: Write the failing tests**

Create `src/topology.rs` containing only this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Test words as owned strings, since that is what a parsed config holds.
    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// Edges as "from->to" strings, so an assertion reads like the spec's table.
    fn drawn(t: Topology, list: &[&str], hub: Option<&str>) -> Vec<String> {
        t.edges(&words(list), hub).iter().map(|(f, x)| format!("{f}->{x}")).collect()
    }

    #[test]
    fn chain_links_each_word_to_the_next() {
        assert_eq!(drawn(Topology::Chain, &["a", "b", "c"], None), ["a->b", "b->c"]);
    }

    #[test]
    fn ring_closes_the_chain() {
        assert_eq!(drawn(Topology::Ring, &["a", "b", "c"], None), ["a->b", "b->c", "c->a"]);
    }

    #[test]
    fn star_to_points_every_word_at_the_hub() {
        assert_eq!(drawn(Topology::StarTo, &["a", "b", "c"], Some("h")), ["a->h", "b->h", "c->h"]);
    }

    #[test]
    fn star_from_points_the_hub_at_every_word() {
        assert_eq!(drawn(Topology::StarFrom, &["a", "b", "c"], Some("h")), ["h->a", "h->b", "h->c"]);
    }

    /// Every ordered pair, outer index ascending then inner, skipping the diagonal.
    #[test]
    fn graph_draws_every_ordered_pair() {
        assert_eq!(
            drawn(Topology::Graph, &["a", "b", "c"], None),
            ["a->b", "a->c", "b->a", "b->c", "c->a", "c->b"]
        );
    }

    /// Spiral draws the same edges as star_from; the difference is how each one is
    /// ground (every hit, not the first), which lives in the run loop.
    #[test]
    fn spiral_draws_the_same_edges_as_star_from() {
        assert_eq!(
            drawn(Topology::Spiral, &["a", "b"], Some("h")),
            drawn(Topology::StarFrom, &["a", "b"], Some("h"))
        );
    }

    /// Two words is the floor for the hubless shapes; ring and graph coincide there.
    #[test]
    fn two_words_is_the_hubless_floor() {
        assert_eq!(drawn(Topology::Chain, &["a", "b"], None), ["a->b"]);
        assert_eq!(drawn(Topology::Ring, &["a", "b"], None), ["a->b", "b->a"]);
        assert_eq!(drawn(Topology::Graph, &["a", "b"], None), ["a->b", "b->a"]);
    }

    /// A hub shape draws an edge from a single word, because it brings its own end.
    #[test]
    fn one_word_is_enough_for_a_hub_shape() {
        assert_eq!(drawn(Topology::StarTo, &["a"], Some("h")), ["a->h"]);
        assert_eq!(drawn(Topology::StarFrom, &["a"], Some("h")), ["h->a"]);
    }

    /// A repeated word is a legal self-edge, not an error.
    #[test]
    fn a_repeated_word_draws_a_self_edge() {
        assert_eq!(drawn(Topology::Chain, &["a", "a"], None), ["a->a"]);
    }

    #[test]
    fn hub_is_required_by_exactly_the_three_shapes_that_have_one() {
        for t in [Topology::StarTo, Topology::StarFrom, Topology::Spiral] {
            assert!(t.requires_hub(), "{} should need a hub", t.slug());
            assert_eq!(t.min_words(), 1, "{} brings its own end", t.slug());
        }
        for t in [Topology::Chain, Topology::Ring, Topology::Graph] {
            assert!(!t.requires_hub(), "{} should not need a hub", t.slug());
            assert_eq!(t.min_words(), 2, "{} needs a word to point at", t.slug());
        }
    }

    #[test]
    fn slugs_round_trip() {
        for t in [
            Topology::Chain, Topology::Ring, Topology::StarTo,
            Topology::StarFrom, Topology::Graph, Topology::Spiral,
        ] {
            assert_eq!(Topology::from_slug(t.slug()), Ok(t));
        }
    }

    /// An unknown name spells out every alternative, since there is no default.
    #[test]
    fn unknown_slug_lists_all_six() {
        let err = Topology::from_slug("mesh").unwrap_err();
        assert!(err.contains("mesh"), "{err}");
        for want in ["chain", "ring", "star_to", "star_from", "graph", "spiral"] {
            assert!(err.contains(want), "missing {want:?} from: {err}");
        }
    }
}
```

Add the module to `src/main.rs`, next to the existing `mod baudot;` / `mod tnsy;` at
lines 9-10:

```rust
mod baudot;
mod tnsy;
mod topology;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test topology`
Expected: FAIL to compile, `cannot find type Topology in this scope` (the test module
refers to a type that does not exist yet).

- [ ] **Step 3: Write the implementation**

Put this above the test module in `src/topology.rs`:

```rust
//! The six shapes a task's words can be wired into. Each turns a word list — plus
//! a hub, for the shapes that hang off one — into the ordered (from, to) edges the
//! run loop grinds. One edge is one search: counter from zero, the run's whole
//! nonce budget. Nothing here knows about hashing or the GPU.

/// How a task's words relate to each other.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Topology {
    /// Each word to the next: `a→b`, `b→c`. No hub.
    Chain,
    /// The chain, closed back on itself: `a→b`, `b→c`, `c→a`. No hub.
    Ring,
    /// Every word to the hub: `a→h`, `b→h`, `c→h`.
    StarTo,
    /// The hub to every word: `h→a`, `h→b`, `h→c`.
    StarFrom,
    /// Every word to every other word, both directions. No hub. Quadratic: n words
    /// draw n(n-1) searches.
    Graph,
    /// The hub to every word, but collecting *every* nonce that spells the word
    /// rather than stopping at the first. Same edges as `StarFrom`; the run loop
    /// grinds them differently.
    Spiral,
}

/// The alternatives, spelled out for the errors that have to list them — there is
/// no default topology, so a bad or missing value has to say what is on offer.
pub const ALL: &str = "chain|ring|star_to|star_from|graph|spiral";

impl Topology {
    /// Stable, machine-readable name for the CSV (also the tasks.toml spelling).
    pub fn slug(self) -> &'static str {
        match self {
            Topology::Chain => "chain",
            Topology::Ring => "ring",
            Topology::StarTo => "star_to",
            Topology::StarFrom => "star_from",
            Topology::Graph => "graph",
            Topology::Spiral => "spiral",
        }
    }

    pub fn from_slug(s: &str) -> Result<Self, String> {
        match s {
            "chain" => Ok(Topology::Chain),
            "ring" => Ok(Topology::Ring),
            "star_to" => Ok(Topology::StarTo),
            "star_from" => Ok(Topology::StarFrom),
            "graph" => Ok(Topology::Graph),
            "spiral" => Ok(Topology::Spiral),
            other => Err(format!("unknown topology {other:?} (want {ALL})")),
        }
    }

    /// True for the shapes with one fixed end outside the word list.
    pub fn requires_hub(self) -> bool {
        matches!(self, Topology::StarTo | Topology::StarFrom | Topology::Spiral)
    }

    /// Fewest words the shape can draw an edge from: the hubless shapes need a
    /// second word to point at, the hub shapes bring their own other end. A
    /// one-word ring would be a self-edge, which is why its floor is two.
    pub fn min_words(self) -> usize {
        if self.requires_hub() { 1 } else { 2 }
    }

    /// The ordered (from, to) edges this shape draws. `hub` must be `Some` exactly
    /// when `requires_hub` — the caller validates that first, so a missing hub here
    /// is a bug rather than a config error.
    pub fn edges(self, words: &[String], hub: Option<&str>) -> Vec<(String, String)> {
        let hub = || {
            hub.expect("hub-bearing topology asked for edges without a hub").to_string()
        };
        match self {
            Topology::Chain => words.windows(2).map(|w| (w[0].clone(), w[1].clone())).collect(),
            Topology::Ring => (0..words.len())
                .map(|i| (words[i].clone(), words[(i + 1) % words.len()].clone()))
                .collect(),
            Topology::StarTo => words.iter().map(|w| (w.clone(), hub())).collect(),
            Topology::StarFrom | Topology::Spiral => {
                words.iter().map(|w| (hub(), w.clone())).collect()
            }
            Topology::Graph => {
                let mut edges = Vec::new();
                for (i, from) in words.iter().enumerate() {
                    for (j, to) in words.iter().enumerate() {
                        if i != j {
                            edges.push((from.clone(), to.clone()));
                        }
                    }
                }
                edges
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test topology`
Expected: PASS, 12 tests in `topology::tests`.

Run: `cargo test`
Expected: PASS, 29 tests (17 baseline + 12 new).

- [ ] **Step 5: Commit**

```bash
git add src/topology.rs src/main.rs
git commit -m "Add the six topologies and their edge derivation."
```

---

### Task 2: `search_all` — spiral's collector

**Files:**
- Modify: `src/main.rs:19-26` (add `SPIRAL_WINDOW`), `src/main.rs:578` (add `fixed_windows` and `search_all` after `search_target`)
- Test: `src/main.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `Engine`, `Engine::launch_sized`, `better`, `THREADS` — all already in `src/main.rs`.
- Produces: `const SPIRAL_WINDOW: u64`; `fn fixed_windows(budget: u64, window: u64) -> impl Iterator<Item = (u64, u64)>` yielding `(start, len)`; `fn search_all(eng: &Engine, d_template: &CudaSlice<u32>, nonce_off: u32, target_bits: &[u32; 8], care_bits: &[u32; 8], num_bits: u32, num_positions: u32, on_hit: impl FnMut((u32, u32, u64)) -> Result<(), Box<dyn std::error::Error>>) -> Result<Vec<(u32, u32, u64)>, Box<dyn std::error::Error>>`, returning the climb of best-so-far improvements.

`search_all` needs a GPU to run, so it lands here as dead code with the part worth
testing — its window schedule — factored out as a pure function. Task 3 wires it into
the run loop and removes the `#[allow(dead_code)]`.

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `src/main.rs`:

```rust
    /// Spiral walks fixed windows so hits stay distinguishable: one launch reports
    /// one best, so the window size is the collection's resolution.
    #[test]
    fn fixed_windows_tile_the_budget_exactly() {
        let w: Vec<_> = fixed_windows(1000, 400).collect();
        assert_eq!(w, [(0, 400), (400, 400), (800, 200)]); // last one clamped
        assert_eq!(w.iter().map(|&(_, len)| len).sum::<u64>(), 1000);
    }

    #[test]
    fn fixed_windows_divide_evenly_without_a_stub() {
        assert_eq!(fixed_windows(800, 400).collect::<Vec<_>>(), [(0, 400), (400, 400)]);
    }

    #[test]
    fn fixed_windows_of_an_empty_budget_yield_nothing() {
        assert_eq!(fixed_windows(0, 400).count(), 0);
    }

    /// budget_bits = 64 means a budget of u64::MAX — 2^44 windows — so the schedule
    /// has to be lazy rather than a Vec.
    #[test]
    fn fixed_windows_is_lazy_enough_for_the_whole_nonce_space() {
        let first: Vec<_> = fixed_windows(u64::MAX, SPIRAL_WINDOW).take(3).collect();
        assert_eq!(
            first,
            [
                (0, SPIRAL_WINDOW),
                (SPIRAL_WINDOW, SPIRAL_WINDOW),
                (2 * SPIRAL_WINDOW, SPIRAL_WINDOW)
            ]
        );
    }

    /// The window has to divide the launch geometry, or `launch_sized` would round
    /// up, overlap the next window, and report the same nonce twice.
    #[test]
    fn spiral_window_divides_the_launch_geometry() {
        assert_eq!(SPIRAL_WINDOW % THREADS as u64, 0);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test fixed_windows`
Expected: FAIL to compile, `cannot find function fixed_windows in this scope`.

- [ ] **Step 3: Write the implementation**

Add the constant after `RAMP_MAX` (`src/main.rs:25`):

```rust
/// Spiral's launch window. One launch reports a single best, so this is also the
/// resolution of a spiral's collection: hits closer together than this are sampled
/// rather than enumerated. A multiple of THREADS, so `launch_sized` covers exactly
/// the window asked for and consecutive windows never overlap.
const SPIRAL_WINDOW: u64 = 1 << 20;
```

Add both functions after `search_target` (`src/main.rs:578`):

```rust
/// The nonce windows a spiral grinds: `(start, len)` pairs tiling `[0, budget)` in
/// `window`-sized steps with the last one clamped. Lazy, because a 64-bit budget is
/// 2^44 windows.
fn fixed_windows(budget: u64, window: u64) -> impl Iterator<Item = (u64, u64)> {
    let mut start = 0u64;
    std::iter::from_fn(move || {
        if start >= budget {
            return None;
        }
        let len = window.min(budget - start);
        let w = (start, len);
        start += len;
        Some(w)
    })
}

/// Spiral's grind: walk the whole budget in fixed windows, handing every window
/// whose best is a full match to `on_hit`, and returning the climb of best-so-far
/// improvements for the partial-match rows. Unlike `search_target` this never exits
/// early — collecting the repeats is the whole point.
///
/// One launch reports one best, so at most one hit per window is seen; for a target
/// short enough that hits are denser than one per `SPIRAL_WINDOW` nonces the result
/// is a sample rather than an enumeration.
#[allow(dead_code)] // wired into the run loop in the next commit
fn search_all(
    eng: &Engine,
    d_template: &CudaSlice<u32>,
    nonce_off: u32,
    target_bits: &[u32; 8],
    care_bits: &[u32; 8],
    num_bits: u32,
    num_positions: u32,
    mut on_hit: impl FnMut((u32, u32, u64)) -> Result<(), Box<dyn std::error::Error>>,
) -> Result<Vec<(u32, u32, u64)>, Box<dyn std::error::Error>> {
    let d_target = eng.dev.htod_copy(target_bits.to_vec())?;
    let d_care = eng.dev.htod_copy(care_bits.to_vec())?;
    let mut best = (0u32, 0u32, 0u64);
    let mut climb: Vec<(u32, u32, u64)> = Vec::new();
    let mut last_hit: Option<u64> = None;
    for (start, len) in fixed_windows(eng.budget, SPIRAL_WINDOW) {
        let (res, _) = eng.launch_sized(
            d_template, nonce_off, &d_target, &d_care, num_bits, num_positions, start, len,
        )?;
        // A full match: report it, unless the final short window's rounding-up
        // handed us the same nonce a second time.
        if res.0 == num_bits && last_hit != Some(res.2) {
            last_hit = Some(res.2);
            on_hit(res)?;
        }
        let merged = better(best, res);
        if merged != best {
            best = merged;
            climb.push(best);
        }
    }
    if climb.is_empty() {
        climb.push(best);
    }
    Ok(climb)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test fixed_windows`
Expected: PASS, 4 tests.

Run: `cargo test`
Expected: PASS, 34 tests (29 + 5 new).

Run: `cargo build 2>&1 | grep -c warning` — expected `0` (the `#[allow(dead_code)]`
covers `search_all`, and `fixed_windows` is used by it).

- [ ] **Step 5: Commit**

```bash
git add src/main.rs
git commit -m "Add search_all: spiral's every-hit collector and its window schedule."
```

---

### Task 3: topology and hub replace target_mode

**Files:**
- Modify: `src/main.rs:103-134` (delete `TargetMode`), `src/main.rs:180-194` (`Task`), `src/main.rs:414-416` (CSV header), `src/main.rs:580-665` (`record_milestones`, `record`), `src/main.rs:667-707` (`Config` banner, `TaskConfig`), `src/main.rs:717-774` (`TaskConfig::build`), `src/main.rs:965-985` (`--list`), `src/main.rs:1007-1091` (run loop), `src/main.rs:15-18` (launch-shape comment)
- Test: `src/main.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `Topology`, `topology::ALL` (Task 1); `search_all` (Task 2).
- Produces: `Task { label, topology, hub, words, edges, source_mode, encoding, position, match_mode }` — no `base`, no `setup`, no `target_mode`; `Task::setup_for(&self, from: &str) -> Vec<u8>`; `fn row_fields(task: &Task, from: &str, setup: &[u8], target: &str, num_bits: u32, best: (u32, u32, u64)) -> Vec<String>`; `record` and `record_milestones` both gaining `from: &str, setup: &[u8]` immediately after `task`.

- [ ] **Step 1: Write the failing tests**

In the `mod tests` block, everything from `const REST` to the end of
`source_mode_must_be_set_and_valid` speaks the old vocabulary. Replace that whole
run of code — the const and five tests — with this, which keeps the same coverage and
adds the new rules:

```rust
    /// The tail most fixtures share: a two-word star, satisfying both the hub
    /// shapes and the hubless two-word floor without saying anything about case.
    const REST: &str = "topology = \"star_from\"\nhub = \"hub\"\nto = \"a b\"\nencoding = \"ascii8\"\n";

    #[test]
    fn plain_mode_keeps_cleartext_as_the_preimage_prefix() {
        let t = build_one(&format!("label = \"p\"\nsource_mode = \"plain\"\n{REST}")).unwrap();
        assert_eq!(t.source_mode, SourceMode::Plain);
        // literal cleartext, not a digest, and one prefix per from-word
        assert_eq!(t.setup_for("hub"), b"hub".to_vec());
    }

    #[test]
    fn hashed_mode_substitutes_the_digest() {
        let long = "x".repeat(200);
        let t = build_one(&format!(
            "label = \"h\"\nsource_mode = \"hashed\"\ntopology = \"star_from\"\n\
             hub = \"{long}\"\nto = \"a b\"\nencoding = \"ascii8\"\n"
        ))
        .unwrap();
        assert_eq!(t.source_mode, SourceMode::Hashed);
        assert_eq!(t.setup_for(&long), Sha256::digest(long.as_bytes()).to_vec());
    }

    #[test]
    fn plain_mode_rejects_an_overlong_hub() {
        let long = "y".repeat(PLAIN_MAX + 1);
        let err = build_one(&format!(
            "label = \"p\"\nsource_mode = \"plain\"\ntopology = \"star_from\"\n\
             hub = \"{long}\"\nto = \"a b\"\nencoding = \"ascii8\"\n"
        ))
        .unwrap_err();
        assert!(err.contains("plain") && err.contains("hashed"), "{err}");
    }

    /// Under chain/ring/graph the list words are from-words too, so the plain limit
    /// applies to each of them — and the error names the one at fault.
    #[test]
    fn plain_mode_rejects_an_overlong_list_word() {
        let long = "z".repeat(PLAIN_MAX + 1);
        let err = build_one(&format!(
            "label = \"c\"\nsource_mode = \"plain\"\ntopology = \"chain\"\n\
             words = [\"ok\", \"{long}\", \"fine\"]\nencoding = \"ascii8\"\n"
        ))
        .unwrap_err();
        assert!(err.contains(&long), "should name the offending word: {err}");
        assert!(err.contains("hashed"), "should offer the way out: {err}");
    }

    /// The last word of a chain is only ever a target, so its length is nobody's
    /// problem — only from-words become preimage prefixes.
    #[test]
    fn plain_mode_allows_an_overlong_final_chain_word() {
        let long = "z".repeat(PLAIN_MAX + 1);
        let t = build_one(&format!(
            "label = \"c\"\nsource_mode = \"plain\"\ntopology = \"chain\"\n\
             words = [\"ok\", \"{long}\"]\nencoding = \"ascii8\"\n"
        ))
        .unwrap();
        assert_eq!(t.edges, [("ok".to_string(), long)]);
    }

    #[test]
    fn plain_mode_accepts_a_hub_exactly_at_the_limit() {
        let at = "z".repeat(PLAIN_MAX);
        let t = build_one(&format!(
            "label = \"p\"\nsource_mode = \"plain\"\ntopology = \"star_from\"\n\
             hub = \"{at}\"\nto = \"a b\"\nencoding = \"ascii8\"\n"
        ))
        .unwrap();
        assert_eq!(t.setup_for(&at).len(), PLAIN_MAX);
    }

    #[test]
    fn source_mode_must_be_set_and_valid() {
        // Omitted entirely: named as required, and both choices are spelled out
        // so the fix is in the message rather than the docs.
        let missing = build_one(&format!("label = \"m\"\n{REST}")).unwrap_err();
        for want in ["source_mode", "required", "no default", "plain", "hashed", "32"] {
            assert!(missing.contains(want), "missing {want:?} from: {missing}");
        }

        // A wrong value gets the same guidance, not just a rejection.
        let bogus =
            build_one(&format!("label = \"m\"\nsource_mode = \"neat\"\n{REST}")).unwrap_err();
        for want in ["neat", "plain", "hashed"] {
            assert!(bogus.contains(want), "missing {want:?} from: {bogus}");
        }
    }

    /// Topology has no default for the same reason source_mode has none: the shape
    /// is the point of the task, not an implementation detail.
    #[test]
    fn topology_must_be_set_and_valid() {
        let missing = build_one(
            "label = \"t\"\nsource_mode = \"plain\"\nto = \"a b\"\nencoding = \"ascii8\"\n",
        )
        .unwrap_err();
        for want in ["topology", "required", "no default", "chain", "spiral"] {
            assert!(missing.contains(want), "missing {want:?} from: {missing}");
        }

        let bogus = build_one(
            "label = \"t\"\nsource_mode = \"plain\"\ntopology = \"mesh\"\n\
             to = \"a b\"\nencoding = \"ascii8\"\n",
        )
        .unwrap_err();
        for want in ["mesh", "chain", "ring", "star_to", "star_from", "graph", "spiral"] {
            assert!(bogus.contains(want), "missing {want:?} from: {bogus}");
        }
    }

    #[test]
    fn hub_shapes_demand_a_hub() {
        let err = build_one(
            "label = \"s\"\nsource_mode = \"plain\"\ntopology = \"star_to\"\n\
             to = \"a b\"\nencoding = \"ascii8\"\n",
        )
        .unwrap_err();
        assert!(err.contains("\"s\"") && err.contains("hub"), "{err}");
    }

    /// A hub on a hubless shape would sit there doing nothing, so it is an error
    /// rather than a silent no-op.
    #[test]
    fn hubless_shapes_reject_a_hub() {
        let err = build_one(
            "label = \"c\"\nsource_mode = \"plain\"\ntopology = \"chain\"\n\
             hub = \"h\"\nto = \"a b\"\nencoding = \"ascii8\"\n",
        )
        .unwrap_err();
        assert!(err.contains("hub") && err.contains("chain"), "{err}");
    }

    #[test]
    fn hubless_shapes_need_two_words() {
        let err = build_one(
            "label = \"c\"\nsource_mode = \"plain\"\ntopology = \"ring\"\n\
             to = \"lonely\"\nencoding = \"ascii8\"\n",
        )
        .unwrap_err();
        assert!(err.contains("ring") && err.contains('2'), "{err}");
    }

    #[test]
    fn words_and_to_are_mutually_exclusive() {
        let both = build_one(
            "label = \"w\"\nsource_mode = \"plain\"\ntopology = \"chain\"\n\
             words = [\"a\", \"b\"]\nto = \"a b\"\nencoding = \"ascii8\"\n",
        )
        .unwrap_err();
        assert!(both.contains("words") && both.contains("to"), "{both}");

        let neither = build_one(
            "label = \"w\"\nsource_mode = \"plain\"\ntopology = \"chain\"\nencoding = \"ascii8\"\n",
        )
        .unwrap_err();
        assert!(neither.contains("words") && neither.contains("to"), "{neither}");
    }

    /// `to` is the shorthand: one string split on whitespace.
    #[test]
    fn to_shorthand_splits_into_words() {
        let t = build_one(&format!("label = \"w\"\nsource_mode = \"plain\"\n{REST}")).unwrap();
        assert_eq!(t.words, ["a", "b"]);
        assert_eq!(
            t.edges,
            [("hub".to_string(), "a".to_string()), ("hub".to_string(), "b".to_string())]
        );
    }

    /// The edge list is what the run loop iterates, so the config's job is to hand
    /// it over already drawn.
    #[test]
    fn build_derives_the_edge_list_from_the_topology() {
        let t = build_one(
            "label = \"g\"\nsource_mode = \"plain\"\ntopology = \"graph\"\n\
             to = \"a b\"\nencoding = \"ascii8\"\n",
        )
        .unwrap();
        assert_eq!(t.topology, Topology::Graph);
        assert_eq!(t.hub, None);
        assert_eq!(
            t.edges,
            [("a".to_string(), "b".to_string()), ("b".to_string(), "a".to_string())]
        );
    }

    /// A row's fields have to line up with the header, and the new column has to
    /// hold the topology. `base` is the edge's from-word, not a task-wide value.
    #[test]
    fn csv_row_matches_the_header() {
        let t = build_one(&format!("label = \"r\"\nsource_mode = \"plain\"\n{REST}")).unwrap();
        let (_, _, nb) = encode_target(t.encoding, "a").unwrap();
        let setup = t.setup_for("hub");
        let fields = row_fields(&t, "hub", &setup, "a", nb, (nb, 0, 7));

        let head: Vec<&str> = CsvLog::HEADER.split(',').collect();
        assert_eq!(fields.len(), head.len(), "{head:?} vs {fields:?}");
        let at = |name: &str| fields[head.iter().position(|h| *h == name).expect(name)].clone();
        assert_eq!(at("task"), "r");
        assert_eq!(at("topology"), "star_from");
        assert_eq!(at("base"), "hub"); // the edge's from-word
        assert_eq!(at("target"), "a");
        assert_eq!(at("full"), "true");
        assert!(!head.contains(&"target_mode"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test`
Expected: FAIL to compile — `no field topology on type Task`, `no method named
setup_for`, `cannot find function row_fields`, and serde rejecting the fixtures'
`topology` key as unknown.

- [ ] **Step 3: Write the implementation**

**3a. Delete `TargetMode`.** Remove the enum and its `impl` block at
`src/main.rs:103-134` entirely, including the `/// How a task's multiple targets
relate to each other.` doc comment above it.

**3b. Add the import** beside the module declarations at the top of `src/main.rs`:

```rust
use topology::Topology;
```

**3c. Rewrite `Task`** (`src/main.rs:180-194`), giving it its first `impl` block:

```rust
/// A task's searches: `topology` draws `edges` over `words` (and `hub`, where the
/// shape has one), and each edge is one independent grind of `from ‖ nonce` looking
/// for `to`. Built from a `TaskConfig`.
#[derive(Debug)]
struct Task {
    label: String,
    topology: Topology,
    hub: Option<String>,          // None for the hubless shapes; kept for --list
    words: Vec<String>,           // kept for --list; `edges` is what runs
    edges: Vec<(String, String)>, // (from, to), in the topology's order
    source_mode: SourceMode,
    encoding: Encoding,
    position: PositionMode,
    match_mode: MatchMode, // ignored by Spiral, which wants every hit
}

impl Task {
    /// The fixed preimage prefix for one edge: the from-word's bytes under `plain`,
    /// `SHA256(from)` under `hashed`. `build` has already checked the plain length
    /// limit for every from-word, so this cannot overflow the block.
    fn setup_for(&self, from: &str) -> Vec<u8> {
        match self.source_mode {
            SourceMode::Plain => from.as_bytes().to_vec(),
            SourceMode::Hashed => setup_hash(from.as_bytes()).to_vec(),
        }
    }
}
```

**3d. CSV header** (`src/main.rs:414-416`) — `target_mode` goes, and `topology` joins
`task` at the front, since it describes the whole task rather than the row:

```rust
    const HEADER: &'static str = "unix_time,task,topology,base,source_mode,encoding,target,\
encoded_text,position_mode,match_mode,matched_chars,total_chars,matched_bits,target_bits,\
match_pos,full,prefix,nonce,nonce_hex,digest";
```

**3e. `record_milestones`, `row_fields`, `record`.** Both recorders take the edge's
from-word and its preimage prefix, and the row building moves into `row_fields` so it
can be tested without opening a file. Replace `src/main.rs:580-665` with:

```rust
/// Record a search's climb: one milestone row each time a new whole character is
/// matched, plus a final row for the exact best. So a long grind logs
/// `t -> th -> the -> "the " -> "the f"` instead of just the final partial.
fn record_milestones(
    csv: &mut CsvLog,
    task: &Task,
    from: &str,
    setup: &[u8],
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
            record(
                csv, task, from, setup, target, target_bits, care_bits, num_bits, num_positions,
                step,
            )?;
        }
    }
    Ok(())
}

/// One resolved search as CSV fields, in `CsvLog::HEADER` order. Pure, so the row
/// layout can be tested without a file: `record` does the verifying and printing.
fn row_fields(
    task: &Task,
    from: &str,
    setup: &[u8],
    target: &str,
    num_bits: u32,
    best: (u32, u32, u64),
) -> Vec<String> {
    let (best_len, best_pos, best_nonce) = best;
    let digest = cpu_digest(setup, best_nonce);
    let (chars, prefix) = matched_prefix(task.encoding, target, best_len);
    let total_chars = target.chars().count();
    vec![
        unix_now().to_string(),
        task.label.to_string(),
        task.topology.slug().to_string(),
        from.to_string(),
        task.source_mode.slug().to_string(),
        task.encoding.slug(),
        target.to_string(),
        normalized_text(task.encoding, target),
        task.position.slug().to_string(),
        task.match_mode.slug().to_string(),
        chars.to_string(),
        total_chars.to_string(),
        best_len.to_string(),
        num_bits.to_string(),
        best_pos.to_string(),
        (chars == total_chars).to_string(),
        prefix,
        best_nonce.to_string(),
        format!("0x{:x}", best_nonce),
        hex(&digest),
    ]
}

/// Decode, CPU-verify, print, and append a CSV row for one resolved search.
fn record(
    csv: &mut CsvLog,
    task: &Task,
    from: &str,
    setup: &[u8],
    target: &str,
    target_bits: &[u32; 8],
    care_bits: &[u32; 8],
    num_bits: u32,
    num_positions: u32,
    best: (u32, u32, u64),
) -> Result<(), Box<dyn std::error::Error>> {
    let (best_len, best_pos, best_nonce) = best;
    let digest = cpu_digest(setup, best_nonce);
    let (vlen, vpos) =
        best_match(&digest_words(&digest), target_bits, care_bits, num_bits, num_positions);
    let verified = vlen == best_len && (best_len == 0 || vpos == best_pos);

    let (chars, _) = matched_prefix(task.encoding, target, best_len);
    let total_chars = target.chars().count();
    let full = chars == total_chars;

    println!(
        "[{:<9}] {:?} -> {:<18?} {}/{} {:>2}/{} ch {:>3}/{} bit @pos {:>3} nonce=0x{:x}{}{}",
        task.topology.slug(),
        from,
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

    csv.row(&row_fields(task, from, setup, target, num_bits, best))
}
```

Note `task.encoding.slug()` still returns `String` at this point (Task 4 changes it
to `&'static str` and adds the `.to_string()`), so it goes into the vec as-is.

**3f. Config banner and `TaskConfig`.** Replace `src/main.rs:667-707` with:

```rust
// =====================================================================
// Config: tasks.toml -> Vec<Task>. `topology` and `source_mode` are required and
// have no default; the rest default to prefix / longest. Run-level knobs live
// under [run].
// =====================================================================
#[derive(Deserialize)]
struct Config {
    run: RunConfig,
    #[serde(default)]
    task: Vec<TaskConfig>,
}

#[derive(Deserialize)]
struct RunConfig {
    /// Nonce budget per edge = 2^budget_bits. Every edge gets the whole of it,
    /// counting from zero.
    budget_bits: u32,
    csv: String,
}

#[derive(Deserialize)]
struct TaskConfig {
    label: String,
    /// How the words below turn into searches: `chain|ring|star_to|star_from|
    /// graph|spiral`. Required, no default — the shape is the point of the task.
    /// Optional here only so a missing value gets a useful error instead of
    /// serde's.
    topology: Option<String>,
    /// The one word the shape hangs off: the destination for `star_to`, the
    /// starting point for `star_from` and `spiral`. Required by those three,
    /// rejected by `chain`, `ring` and `graph`, which draw every edge from the
    /// word list.
    hub: Option<String>,
    /// The words the topology draws its edges over — sources as well as
    /// destinations under `chain`, `ring` and `graph`. Omit when using `to`.
    #[serde(default)]
    words: Vec<String>,
    /// Shorthand: one string split on whitespace into `words`, e.g.
    /// `to = "to this"` -> ["to", "this"]. Mutually exclusive with `words`.
    to: Option<String>,
    /// Required, no default: "plain" (cleartext in the preimage, every from-word
    /// <= 32 bytes) or "hashed" (SHA256(from) in the preimage, any length).
    /// Optional here only so a missing value gets a useful error instead of
    /// serde's.
    source_mode: Option<String>,
    encoding: String,
    position: Option<String>,
    match_mode: Option<String>,
}
```

**3g. `TaskConfig::build`.** Replace the whole `impl` block (`src/main.rs:717-774`):

```rust
impl TaskConfig {
    fn build(self) -> Result<Task, String> {
        let label = self.label.clone();
        let ctx = move |e: String| format!("task {label:?}: {e}");

        // The shape comes first: it decides whether a hub is wanted and how many
        // words are enough.
        let topology = match &self.topology {
            Some(s) => Topology::from_slug(s).map_err(&ctx)?,
            None => {
                return Err(ctx(format!(
                    "topology is required and has no default — set one of {}",
                    topology::ALL
                )));
            }
        };

        // Words come from an explicit list or the `to` shorthand (split on
        // whitespace), but never both.
        let words: Vec<String> = match (self.words.is_empty(), self.to) {
            (false, None) => self.words,
            (true, Some(to)) => to.split_whitespace().map(str::to_string).collect(),
            (false, Some(_)) => return Err(ctx("set `words` or `to`, not both".into())),
            (true, None) => return Err(ctx("no words (set `words` or `to`)".into())),
        };
        if words.len() < topology.min_words() {
            return Err(ctx(format!(
                "topology {:?} needs at least {} words, got {}",
                topology.slug(),
                topology.min_words(),
                words.len()
            )));
        }

        // A hub is either the shape's fixed end or meaningless — never carried
        // along doing nothing.
        let hub = match (topology.requires_hub(), self.hub) {
            (true, Some(h)) => Some(h),
            (true, None) => {
                return Err(ctx(format!("topology {:?} needs a `hub`", topology.slug())));
            }
            (false, Some(_)) => {
                return Err(ctx(format!(
                    "topology {:?} draws every edge from `words`; remove `hub`",
                    topology.slug()
                )));
            }
            (false, None) => None,
        };

        let edges = topology.edges(&words, hub.as_deref());

        // `plain` keeps the cleartext readable in the preimage, so it only works
        // while a from-word fits beside the nonce in one block; `hashed` lifts that
        // at the cost of the cleartext. Refuse to silently pick one.
        let source_mode = match &self.source_mode {
            Some(s) => SourceMode::from_slug(s).map_err(&ctx)?,
            None => {
                return Err(ctx(format!(
                    "source_mode is required and has no default — set it explicitly:{}",
                    SourceMode::help()
                )));
            }
        };
        if source_mode == SourceMode::Plain {
            // Every from-word becomes a preimage prefix, so every one has to fit.
            for (from, _) in &edges {
                if from.len() > PLAIN_MAX {
                    return Err(ctx(format!(
                        "source_mode = \"plain\" needs every from-word <= {PLAIN_MAX} bytes, \
                         but {from:?} is {}; use source_mode = \"hashed\" for longer text",
                        from.len()
                    )));
                }
            }
        }

        Ok(Task {
            encoding: Encoding::from_slug(&self.encoding).map_err(&ctx)?,
            position: parse_or(self.position, PositionMode::Prefix, PositionMode::from_slug)
                .map_err(&ctx)?,
            match_mode: parse_or(self.match_mode, MatchMode::Longest, MatchMode::from_slug)
                .map_err(&ctx)?,
            label: self.label,
            topology,
            hub,
            words,
            edges,
            source_mode,
        })
    }
}
```

**3h. `--list`** (`src/main.rs:969-984`):

```rust
    if cli.list {
        for t in &tasks {
            println!(
                "{:<14} {:<10} hub {:<14} {:?}  {} edges  [{}, {}, {}, {}]",
                t.label,
                t.topology.slug(),
                t.hub.as_deref().unwrap_or("—"),
                t.words,
                t.edges.len(),
                t.source_mode.slug(),
                t.encoding.slug(),
                t.position.slug(),
                t.match_mode.slug(),
            );
        }
        let searches: usize = tasks.iter().map(|t| t.edges.len()).sum();
        println!(
            "({} tasks, {} searches, budget 2^{} nonces each, csv {})",
            tasks.len(),
            searches,
            budget.trailing_zeros(),
            csv_path
        );
        return Ok(());
    }
```

**3i. The run loop.** Replace the whole `for task in tasks { ... }` block
(`src/main.rs:1007-1091`) with one flat pass over the edges:

```rust
    for task in tasks {
        let num_positions = task.position.num_positions();
        for (from, to) in &task.edges {
            // Each edge is its own search: its own preimage prefix, its own
            // template, and a nonce counter starting at zero.
            let setup = task.setup_for(from);
            let (template, nonce_off) = build_template(&setup);
            let d_template = eng.dev.htod_copy(template.to_vec())?;
            let (tb, cb, nb) = encode_target(task.encoding, to)?;

            if task.topology == Topology::Spiral {
                // Every nonce that spells the word, not just the first — so hits
                // are written as they turn up, and match_mode has nothing to say.
                let climb = search_all(
                    &eng,
                    &d_template,
                    nonce_off,
                    &tb,
                    &cb,
                    nb,
                    num_positions,
                    |hit| {
                        record(
                            &mut csv, &task, from, &setup, to, &tb, &cb, nb, num_positions, hit,
                        )
                    },
                )?;
                // The hit rows already carry every full match, so the climb only
                // contributes the partials it passed through on the way.
                let partials: Vec<(u32, u32, u64)> =
                    climb.iter().copied().filter(|s| s.0 < nb).collect();
                if !partials.is_empty() {
                    record_milestones(
                        &mut csv, &task, from, &setup, to, &tb, &cb, nb, num_positions, &partials,
                    )?;
                }
            } else {
                let stop_on_full = matches!(task.match_mode, MatchMode::Full);
                let climb = search_target(
                    &eng, &d_template, nonce_off, &tb, &cb, nb, num_positions, stop_on_full,
                )?;
                record_milestones(
                    &mut csv, &task, from, &setup, to, &tb, &cb, nb, num_positions, &climb,
                )?;
            }
        }
    }
```

Remove the `#[allow(dead_code)]` from `search_all` now that it is called.

**3j. The launch-shape comment** (`src/main.rs:15-18`) implies one budget per target.
Update the parenthetical:

```rust
// One launch covers THREADS * BLOCKS * ITERS nonces. Tune for ~tens of ms per
// launch so the live progress readout updates smoothly. (The nonce budget — spent
// in full on every edge, counting from zero — the CSV path, and the tasks
// themselves live in tasks.toml. See Config below.)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test`
Expected: PASS, 44 tests (34 + 10 new config tests; the five rewritten ones keep
their slots).

Run: `cargo build 2>&1 | grep -c warning` — expected `0`. If `words` or `hub` are
reported as never read, the `--list` change in 3h was not applied.

- [ ] **Step 5: Commit**

```bash
git add src/main.rs
git commit -m "Replace target_mode with topology and hub; grind one search per edge."
```

---

### Task 4: `case` becomes its own field

**Files:**
- Modify: `src/main.rs:37-49` (`Encoding` doc comments), `src/main.rs:101` (add `CaseMode` after `MatchMode`), `src/main.rs:196-219` (`impl Encoding`), `Task` and `impl Task` (Task 3's versions), CSV header and `row_fields` (Task 3's versions), `TaskConfig` and `TaskConfig::build` (Task 3's versions), `load_tasks`'s build loop, `--list`
- Test: `src/main.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `Task`, `row_fields`, `CsvLog::HEADER`, `TaskConfig::build` as Task 3 left them.
- Produces: `enum CaseMode { Sensitive, Insensitive }` deriving `Clone, Copy, Debug, PartialEq`, with `fn slug(self) -> &'static str`, `fn from_slug(s: &str) -> Result<Self, String>`, `fn insensitive(self) -> bool`; `Encoding::slug(self) -> &'static str` (no longer `String`, no `_ci` suffix); `Encoding::from_slug(s: &str, ci: bool) -> Result<Self, String>`; `Encoding::folds_case(self) -> bool`; `Task.case: CaseMode`; `Task::effective_case(&self) -> CaseMode`; `fn warnings(task: &Task) -> Vec<String>`.

- [ ] **Step 1: Write the failing tests**

Add to the `mod tests` block in `src/main.rs`, and add one line to the existing
`csv_row_matches_the_header` test — `assert_eq!(at("case"), "sensitive");` directly
after its `at("target")` assertion:

```rust
    /// `case` is a field now, not a slug suffix: an insensitive ASCII task must
    /// produce exactly the care mask the old `ascii8_ci` spelling produced.
    #[test]
    fn insensitive_case_frees_the_case_bit() {
        let sensitive = Encoding::from_slug("ascii8", false).unwrap();
        let insensitive = Encoding::from_slug("ascii8", true).unwrap();
        let (_, care_s, _) = encode_target(sensitive, "aB").unwrap();
        let (_, care_i, _) = encode_target(insensitive, "aB").unwrap();
        // Two 8-bit chars at the top of the field: every bit significant when
        // sensitive, 0x20 freed in each when not.
        assert_eq!(care_s[0] >> 16, 0xffff);
        assert_eq!(care_i[0] >> 16, 0xdfdf);
    }

    /// The suffix is gone from the name, because the name no longer carries case.
    #[test]
    fn encoding_slugs_have_no_case_suffix() {
        assert_eq!(Encoding::from_slug("ascii8", true).unwrap().slug(), "ascii8");
        assert_eq!(Encoding::from_slug("ascii7", true).unwrap().slug(), "ascii7");
        assert!(Encoding::from_slug("ascii8_ci", false).is_err());
    }

    #[test]
    fn case_defaults_to_sensitive() {
        let t = build_one(&format!("label = \"c\"\nsource_mode = \"plain\"\n{REST}")).unwrap();
        assert_eq!(t.case, CaseMode::Sensitive);
        assert_eq!(t.effective_case(), CaseMode::Sensitive);
        assert!(warnings(&t).is_empty());
    }

    #[test]
    fn unknown_case_names_both_choices() {
        let err = build_one(&format!(
            "label = \"c\"\nsource_mode = \"plain\"\ncase = \"loose\"\n{REST}"
        ))
        .unwrap_err();
        for want in ["loose", "sensitive", "insensitive"] {
            assert!(err.contains(want), "missing {want:?} from: {err}");
        }
    }

    /// Baudot has no case to keep. The task still loads, but it warns, and the
    /// effective case — the one the CSV records — is insensitive either way.
    #[test]
    fn baudot_warns_about_sensitivity_but_still_loads() {
        let t = build_one(
            "label = \"b\"\nsource_mode = \"plain\"\ntopology = \"ring\"\n\
             to = \"one two\"\nencoding = \"baudot\"\n",
        )
        .unwrap();
        assert_eq!(t.case, CaseMode::Sensitive); // what was asked for
        assert_eq!(t.effective_case(), CaseMode::Insensitive); // what happened
        let warned = warnings(&t);
        assert_eq!(warned.len(), 1, "{warned:?}");
        for want in ["\"b\"", "baudot", "case", "no effect"] {
            assert!(warned[0].contains(want), "missing {want:?} from: {}", warned[0]);
        }
    }

    /// Saying `insensitive` out loud describes what actually happens, so no warning.
    #[test]
    fn tnsy_does_not_warn_when_told_insensitive() {
        let t = build_one(
            "label = \"t\"\nsource_mode = \"plain\"\ntopology = \"ring\"\n\
             to = \"one two\"\nencoding = \"tnsy\"\ncase = \"insensitive\"\n",
        )
        .unwrap();
        assert!(warnings(&t).is_empty());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test`
Expected: FAIL to compile — `cannot find type CaseMode in this scope`, `cannot find
function warnings`, `no method named effective_case`, and `Encoding::from_slug` taking
1 argument but 2 supplied.

- [ ] **Step 3: Write the implementation**

**4a. `CaseMode`,** added after `MatchMode`'s `impl` block (`src/main.rs:101`):

```rust
/// Whether the comparison tells upper case from lower. Only the ASCII encodings can
/// honour it — Baudot and TNSY fold case as part of encoding — so this is the
/// *requested* setting; `Task::effective_case` reports what actually happened.
#[derive(Clone, Copy, Debug, PartialEq)]
enum CaseMode {
    Sensitive,
    Insensitive,
}

impl CaseMode {
    fn slug(self) -> &'static str {
        match self {
            CaseMode::Sensitive => "sensitive",
            CaseMode::Insensitive => "insensitive",
        }
    }
    fn from_slug(s: &str) -> Result<Self, String> {
        match s {
            "sensitive" => Ok(CaseMode::Sensitive),
            "insensitive" => Ok(CaseMode::Insensitive),
            other => Err(format!("unknown case {other:?} (want sensitive|insensitive)")),
        }
    }
    /// The don't-care flag the ASCII encoders want.
    fn insensitive(self) -> bool {
        self == CaseMode::Insensitive
    }
}
```

**4b. `Encoding` doc comments** (`src/main.rs:37-49`) so `ci` no longer reads as a
slug variant:

```rust
#[derive(Clone, Copy, Debug)]
#[allow(dead_code)] // Ascii7/Baudot are selectable alternatives, not all wired into ENCODINGS
enum Encoding {
    /// One byte per char (num_bits = 8·len). Digest's leading bytes read as ASCII.
    /// `ci` — from the task's `case = "insensitive"` — folds case for letters via a
    /// don't-care on the 0x20 bit.
    Ascii8 { ci: bool },
    /// Low 7 bits per char, packed (num_bits = 7·len). `ci` as above.
    Ascii7 { ci: bool },
    /// ITA2 "Baudot", 5 bits per code incl. shifts. Case-folded by construction, so
    /// `case` has no effect.
    Baudot,
    /// TNSY one-shift 4-bit Baudot-style nibble code. Case-folded by construction.
    Tnsy,
}
```

**4c. `impl Encoding`** — replace the whole block at `src/main.rs:196-219`:

```rust
impl Encoding {
    /// Stable, machine-readable name for the CSV (also the tasks.toml spelling).
    /// Case is its own field, so it is not part of the name.
    fn slug(self) -> &'static str {
        match self {
            Encoding::Ascii8 { .. } => "ascii8",
            Encoding::Ascii7 { .. } => "ascii7",
            Encoding::Baudot => "baudot",
            Encoding::Tnsy => "tnsy",
        }
    }
    /// `ci` comes from the task's `case` field. Baudot and TNSY drop it on the
    /// floor: they have already folded case by the time they emit symbols.
    fn from_slug(s: &str, ci: bool) -> Result<Self, String> {
        match s {
            "ascii8" => Ok(Encoding::Ascii8 { ci }),
            "ascii7" => Ok(Encoding::Ascii7 { ci }),
            "baudot" => Ok(Encoding::Baudot),
            "tnsy" => Ok(Encoding::Tnsy),
            other => Err(format!("unknown encoding {other:?} (want ascii8|ascii7|baudot|tnsy)")),
        }
    }
    /// True where the encoding folds case itself, so `case` cannot mean anything.
    fn folds_case(self) -> bool {
        matches!(self, Encoding::Baudot | Encoding::Tnsy)
    }
}
```

**4d. `Task`** — add the field after `encoding`, and the method to `impl Task`
alongside `setup_for`:

```rust
    case: CaseMode, // as asked for; see effective_case
```

```rust
    /// What the comparison actually did about case: Baudot and TNSY fold whatever
    /// the task asked for, so this is what the CSV records.
    fn effective_case(&self) -> CaseMode {
        if self.encoding.folds_case() { CaseMode::Insensitive } else { self.case }
    }
```

**4e. `warnings`,** a free function directly after `impl Task`:

```rust
/// Non-fatal notes about a built task, printed once at load. Just the one so far:
/// asking for case sensitivity from an encoding that has already folded it away.
fn warnings(task: &Task) -> Vec<String> {
    let mut out = Vec::new();
    if task.encoding.folds_case() && task.case == CaseMode::Sensitive {
        out.push(format!(
            "task {:?}: encoding {:?} is case-folded by construction; \
             case = \"sensitive\" has no effect (recorded as \"insensitive\")",
            task.label,
            task.encoding.slug(),
        ));
    }
    out
}
```

**4f. CSV header** — add `case` after `encoding`:

```rust
    const HEADER: &'static str = "unix_time,task,topology,base,source_mode,encoding,case,target,\
encoded_text,position_mode,match_mode,matched_chars,total_chars,matched_bits,target_bits,\
match_pos,full,prefix,nonce,nonce_hex,digest";
```

**4g. `row_fields`** — `slug()` now returns `&'static str`, and the effective case
follows it. Replace the single line `task.encoding.slug(),` with:

```rust
        task.encoding.slug().to_string(),
        task.effective_case().slug().to_string(),
```

**4h. `TaskConfig`** — add the field after `encoding`:

```rust
    /// "sensitive" (the default) or "insensitive". Insensitive frees the 0x20 bit
    /// of each letter, so either case matches. Baudot and TNSY have already folded
    /// case and warn if asked for sensitivity.
    case: Option<String>,
```

**4i. `TaskConfig::build`** — parse the case before constructing the `Task`, and feed
it to the encoding. Replace the `Ok(Task { ... })` tail with:

```rust
        let case = parse_or(self.case, CaseMode::Sensitive, CaseMode::from_slug).map_err(&ctx)?;

        Ok(Task {
            encoding: Encoding::from_slug(&self.encoding, case.insensitive()).map_err(&ctx)?,
            position: parse_or(self.position, PositionMode::Prefix, PositionMode::from_slug)
                .map_err(&ctx)?,
            match_mode: parse_or(self.match_mode, MatchMode::Longest, MatchMode::from_slug)
                .map_err(&ctx)?,
            label: self.label,
            topology,
            hub,
            words,
            edges,
            source_mode,
            case,
        })
```

**4j. Print the warnings at load.** In `load_tasks`, replace the build loop:

```rust
    // Build every task, then filter: a malformed task is an error in the config
    // whether or not this run happens to select it. Warnings, being about what a run
    // will actually do, are only worth printing for the tasks it keeps.
    let mut tasks = Vec::new();
    for tc in cfg.task {
        let keep = cli.only.is_empty() || cli.only.iter().any(|l| l == &tc.label);
        let task = tc.build()?;
        if keep {
            for w in warnings(&task) {
                eprintln!("warning: {w}");
            }
            tasks.push(task);
        }
    }
```

**4k. `--list`** — show the effective case, so the listing and the warning agree.
Add `t.effective_case().slug(),` after `t.encoding.slug(),` and widen the bracketed
group in the format string from four `{}` to five:

```rust
                "{:<14} {:<10} hub {:<14} {:?}  {} edges  [{}, {}, {}, {}, {}]",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test`
Expected: PASS, 50 tests (44 + 6 new).

Run: `cargo build 2>&1 | grep -c warning` — expected `0`.

- [ ] **Step 5: Commit**

```bash
git add src/main.rs
git commit -m "Move case sensitivity out of the encoding slug into its own field."
```

---

### Task 5: an example config, end to end

**Files:**
- Create: `tasks.example.toml`
- Test: `cargo run -- tasks.example.toml --list` (no GPU needed — `--list` returns before the device is opened)

**Interfaces:**
- Consumes: the whole of Tasks 1-4, through the config parser and `--list`.
- Produces: `tasks.example.toml`, the worked example of the new vocabulary. Nothing in `src/` depends on it.

- [ ] **Step 1: Write the example config**

Create `tasks.example.toml`:

```toml
# Every topology, once, as a worked example of the vocabulary. Copy to tasks.toml
# and edit. `topology` and `source_mode` are required; `case`, `position` and
# `match_mode` default to sensitive / prefix / longest.

[run]
budget_bits = 32       # nonces per edge = 2^32, counting from zero every time
csv = "results.csv"

# Each word to the next: to->this, this->that.
[[task]]
label       = "chain"
topology    = "chain"
words       = ["to", "this", "that"]
source_mode = "plain"
encoding    = "ascii8"

# The chain closed back on itself: one->two, two->three, three->one.
[[task]]
label       = "ring"
topology    = "ring"
to          = "one two three"
source_mode = "plain"
encoding    = "ascii8"
case        = "insensitive"

# Every word to the hub: a->grinding, b->grinding, c->grinding.
[[task]]
label       = "star-to"
topology    = "star_to"
hub         = "grinding"
to          = "a b c"
source_mode = "plain"
encoding    = "ascii8"

# The hub to every word: grinding->a, grinding->b, grinding->c.
[[task]]
label       = "star-from"
topology    = "star_from"
hub         = "grinding"
to          = "a b c"
source_mode = "plain"
encoding    = "ascii8"
position    = "anywhere"

# Every ordered pair: 6 searches from 3 words. Quadratic — mind the budget.
[[task]]
label       = "graph"
topology    = "graph"
to          = "red green blue"
source_mode = "plain"
encoding    = "ascii8"

# As many nonces as spell the word, not just the first.
[[task]]
label       = "spiral"
topology    = "spiral"
hub         = "grinding"
to          = "and"
source_mode = "plain"
encoding    = "ascii8"

# A text too long to sit in the preimage: hashed puts SHA256(hub) there instead.
[[task]]
label       = "hashed-star"
topology    = "star_from"
hub         = "a source string far longer than the 32-byte plain limit allows"
to          = "x y"
source_mode = "hashed"
encoding    = "ascii8"

# Baudot folds case itself, so this warns that case = "sensitive" (the default)
# has no effect. Saying case = "insensitive" silences it.
[[task]]
label       = "baudot-ring"
topology    = "ring"
to          = "one two"
source_mode = "plain"
encoding    = "baudot"
```

- [ ] **Step 2: Run `--list` and check the whole config parses**

Run: `cargo run --quiet -- tasks.example.toml --list`

Expected: the baudot warning on stderr, then one line per task and a total. Check
specifically that:
- `warning: task "baudot-ring": encoding "baudot" is case-folded by construction; case = "sensitive" has no effect (recorded as "insensitive")` appears **once**
- edge counts read `chain` 2, `ring` 3, `star-to` 3, `star-from` 3, `graph` 6,
  `spiral` 1, `hashed-star` 2, `baudot-ring` 2
- the `ring` line reports `insensitive`, the `chain` line `sensitive`, and the
  `baudot-ring` line `insensitive` — its effective case, not what it asked for
- the totals line reads
  `(8 tasks, 22 searches, budget 2^32 nonces each, csv results.csv)`

- [ ] **Step 3: Check the failure paths report properly**

Run each of these and confirm the error names both the task and the fix:

```bash
printf '[run]\nbudget_bits = 8\ncsv = "x.csv"\n\n[[task]]\nlabel = "bad"\ntopology = "chain"\nhub = "h"\nto = "a b"\nsource_mode = "plain"\nencoding = "ascii8"\n' > /tmp/bad-hub.toml
cargo run --quiet -- /tmp/bad-hub.toml --list
```
Expected: exit 1, ``error: task "bad": topology "chain" draws every edge from `words`; remove `hub` ``

```bash
printf '[run]\nbudget_bits = 8\ncsv = "x.csv"\n\n[[task]]\nlabel = "bad"\ntopology = "mesh"\nto = "a b"\nsource_mode = "plain"\nencoding = "ascii8"\n' > /tmp/bad-topo.toml
cargo run --quiet -- /tmp/bad-topo.toml --list
```
Expected: exit 1, `error: task "bad": unknown topology "mesh" (want chain|ring|star_to|star_from|graph|spiral)`

```bash
printf '[run]\nbudget_bits = 8\ncsv = "x.csv"\n\n[[task]]\nlabel = "bad"\ntopology = "chain"\nto = "a b"\nsource_mode = "plain"\nencoding = "ascii8_ci"\n' > /tmp/bad-enc.toml
cargo run --quiet -- /tmp/bad-enc.toml --list
```
Expected: exit 1, `error: task "bad": unknown encoding "ascii8_ci" (want ascii8|ascii7|baudot|tnsy)`

- [ ] **Step 4: Confirm the suite is still green**

Run: `cargo test`
Expected: PASS, 50 tests.

- [ ] **Step 5: Commit**

```bash
git add tasks.example.toml
git commit -m "Add an example config covering all six topologies."
```

---

## Deferred: the first real grind

Nothing in this plan runs a search — `nvcc` is absent on this machine, so
`CudaDevice::new` cannot succeed. On the CUDA box, the checks worth making before
trusting a long run:

- `cargo run -- tasks.example.toml --only chain` with `budget_bits = 24`: rows with
  `topology = "chain"`, `base` reading `to` then `this`, and no `[VERIFY MISMATCH]`
  anywhere.
- `--only spiral` with `budget_bits = 26`: several rows with `full = true` at
  strictly increasing nonces, no nonce repeated.
- `--only star-from`: three edges each starting from nonce 0 — the three rows' nonces
  independent rather than climbing across the task.
- `node app/data/generate.js` against the resulting `results.csv`, to confirm the
  renamed columns still feed the display code (it reads `task`, `base`, `encoding`,
  `target`, `matched_chars`, `nonce`, `digest` — all of which survive).
