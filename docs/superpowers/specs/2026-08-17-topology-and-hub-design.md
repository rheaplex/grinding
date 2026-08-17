# Topology and hub in tasks.toml

Date: 2026-08-17

## Why

A task today is one `base` and a list of `targets`, with `target_mode` deciding how
the targets relate to each other: independent searches (`each`), or one shared
grind collecting the words in sequence (`collect_in_order`) or in discovery order
(`collect_any_order`). That vocabulary can only describe a star: one fixed
source, many destinations.

The work wants other shapes — words that link to each other in a chain or a ring,
every word to every other word, many nonces for one word. Those need a *from* that
varies per search, which `target_mode` cannot express.

So `target_mode` is replaced by `topology`: a name for how a list of words (plus,
where the shape needs one, a `hub`) turns into a list of `(from, to)` edges. Each
edge is one independent search — nonce counter from zero, the run's `budget_bits`
nonce budget, the task's `position` and `match_mode`.

## What changes

Removed:

- `target_mode` and the `TargetMode` enum, along with the two collect-mode
  branches of the run loop.
- `base` / `from` as a task field. The only from-word not drawn from the word list
  is the hub, and it is now named that.
- The `ascii8_ci` / `ascii7_ci` encoding slugs. Case is its own field.

Added:

- `topology` (required, no default) and `hub` (required by three of the six
  topologies, rejected by the other three).
- `case` (`sensitive` | `insensitive`, default `sensitive`).
- `words` — the renamed `targets`. Under `chain`, `ring` and `graph` the list
  supplies sources as well as destinations, so `targets` would be lying. The `to`
  whitespace-split shorthand is unchanged.

Unchanged: `source_mode` (still required, still `plain` | `hashed`), `encoding`,
`position`, `match_mode`, `budget_bits`, `csv`, the CUDA kernel, and the CPU
verification of every recorded result.

All existing task files are being rewritten against the new vocabulary, so no
aliases or deprecation shims are kept for the removed spellings.

## Config schema

```toml
[run]
budget_bits = 40
csv = "results.csv"

[[task]]
label       = "chain"
topology    = "chain"          # chain|ring|star_to|star_from|graph|spiral
words       = ["to", "this", "that"]
source_mode = "plain"          # plain|hashed — required, no default
encoding    = "ascii8"         # ascii8|ascii7|baudot|tnsy
case        = "sensitive"      # sensitive|insensitive — optional, default sensitive
position    = "prefix"         # prefix|anywhere — optional, default prefix
match_mode  = "longest"        # full|longest — optional, default longest

[[task]]
label       = "star"
topology    = "star_from"
hub         = "grinding"
to          = "a b c"          # shorthand for words = ["a", "b", "c"]
source_mode = "plain"
encoding    = "ascii8"
case        = "insensitive"
```

## Topology semantics

One function does the whole of the new logic:

```rust
impl Topology {
    /// The ordered (from, to) edges this shape draws over `words` and `hub`.
    fn edges(self, words: &[String], hub: Option<&str>) -> Vec<(String, String)>
}
```

Everything downstream already knows how to grind a single `(from, to)`, so the run
loop becomes one flat pass over the edge list.

For `words = [a b c]` and `hub = h`:

| topology    | hub      | edges                                          | count    | min words |
| ----------- | -------- | ---------------------------------------------- | -------- | --------- |
| `chain`     | rejected | `a→b`, `b→c`                                   | n−1      | 2         |
| `ring`      | rejected | `a→b`, `b→c`, `c→a`                            | n        | 2         |
| `star_to`   | required | `a→h`, `b→h`, `c→h`                            | n        | 1         |
| `star_from` | required | `h→a`, `h→b`, `h→c`                            | n        | 1         |
| `graph`     | rejected | `a→b`, `a→c`, `b→a`, `b→c`, `c→a`, `c→b`       | n(n−1)   | 2         |
| `spiral`    | required | `h→a`, `h→b`, `h→c` — every hit, not the first | n        | 1         |

Edge order is stable and as tabulated: list order for the chain and the stars,
outer index ascending then inner index ascending (skipping the diagonal) for the
graph. `graph` is quadratic — twelve words is 132 searches of `budget_bits`
nonces each — which is a cost the caller chooses, not something the code caps.

Duplicate words are not rejected; a self-edge from a repeated word is a legal
search and grinds like any other.

### star_from is not the old collect modes

`collect_in_order` and `collect_any_order` shared one grind across every target.
`star_from` runs N independent grinds of `budget_bits` each, because the counter
now always starts at zero. That is more GPU time in exchange for edges that are
each reproducible from their own CSV row alone, which is the point of the
counter-from-zero rule. The old "stop the chain when a word isn't found within
budget" behaviour goes with them: every edge is now attempted regardless of
whether its predecessors landed.

### spiral

`spiral` keeps grinding after a full match instead of stopping at the first one,
logging a row per nonce whose digest yields the target. It therefore ignores
`match_mode` — `full` means stop at the first, `longest` means keep the best one,
and spiral wants all of them.

The kernel returns one packed best per launch, so **spiral resolves at most one
hit per launch window**. It uses fixed windows of `RAMP_MAX` (2^20) nonces across
the whole budget rather than the ramp-to-full-size schedule, keeping the window
small enough that closely spaced hits are still distinguished. For a target short
enough that hits are denser than one per 2^20 nonces, the collected set is a
sample, not an enumeration. Making it exhaustive would mean a kernel that returns
a hit list instead of a single best, which is out of scope here.

## Case

`case = "insensitive"` sets the existing don't-care on the 0x20 bit of alphabetic
characters — the same care-mask the `_ci` slugs used to produce. The kernel, the
packing, and `best_match` are untouched; only where the flag comes from changes:

- `Encoding::from_slug` takes the case flag as an argument instead of reading it
  off the slug.
- `Encoding::slug()` stops emitting the `_ci` suffix, since `case` is now its own
  CSV column.

Baudot and TNSY are case-folded by construction — they have no case to be
sensitive to. Rather than erroring on the `sensitive` default (which would make
the default unusable with half the encodings), the task loads and warns:

```
warning: task "ring": encoding "baudot" is case-folded by construction;
         case = "sensitive" has no effect (recorded as "insensitive")
```

The warning fires once per task, on stderr, whenever the effective case is
`sensitive` and the encoding is `baudot` or `tnsy` — whether `sensitive` was
written out or defaulted. Writing `case = "insensitive"` silences it and states
what actually happened. The CSV records the *effective* case, so a row never
claims a sensitivity the comparison did not have.

## Validation

All of it happens at load, before any GPU work, and every message names the task:

1. `topology` is required with no default; an unknown or missing value lists all
   six spellings, the way `source_mode` already does.
2. `hub` is required for `star_to`, `star_from` and `spiral`, and an error when
   present for `chain`, `ring` and `graph` — so a config never carries a value
   that silently does nothing.
3. Words come from `words` or `to`, never both, and never empty. `chain`, `ring`
   and `graph` need at least two.
4. `source_mode` stays required with no default.
5. Under `plain`, *every* word used as a from — each list word for
   `chain`/`ring`/`graph`, the hub for the star and spiral shapes — must be at
   most `PLAIN_MAX` (32) bytes. The error names the offending word rather than
   just the task.
6. `case` parses as `sensitive` | `insensitive`, defaulting to `sensitive`.

As now, every task in the file is built even when `--only` selects a subset: a
malformed task is an error in the config whether or not this run touches it.

## Data structures

```rust
struct Task {
    label: String,
    topology: Topology,
    hub: Option<String>,          // kept for --list; None for chain/ring/graph
    words: Vec<String>,           // kept for --list
    edges: Vec<(String, String)>, // derived at build time
    source_mode: SourceMode,
    encoding: Encoding,           // carries the case flag as `ci`
    case: CaseMode,               // effective value, for the CSV
    position: PositionMode,
    match_mode: MatchMode,
}
```

`Task` no longer holds a single `setup`, since the preimage prefix now varies per
edge. It gains `fn setup_for(&self, from: &str) -> Vec<u8>` — the from-word's
bytes under `plain`, `SHA256(from)` under `hashed` — with the `PLAIN_MAX` check
already done at build time so this cannot fail.

## CSV

`target_mode` goes, and `topology` takes its place next to `task` rather than in
its old slot — it describes the shape of the whole task, so it belongs beside the
label. `case` joins the other per-task settings. The `base` column keeps its name
and now carries the edge's from-word, so a chain row self-describes without
reference to the task's word list. No `hub` column: for the star shapes the hub is
already in `base` or `target` on every row.

```
unix_time,task,topology,base,source_mode,encoding,case,target,encoded_text,
position_mode,match_mode,matched_chars,total_chars,matched_bits,target_bits,
match_pos,full,prefix,nonce,nonce_hex,digest
```

`app/data/generate.js` reads columns by name (`task`, `base`, `encoding`,
`target`, `matched_chars`, `nonce`, `digest`), all of which survive, so it keeps
working unchanged.

### Partial matches

Every edge records its climb through `record_milestones`: a row each time a new
whole character is matched, plus a final row for the exact best. A chain edge that
never completes still logs `t → th → the`. This was previously true only of
`target_mode = "each"` — the collect modes logged one row per target — so
removing them means partials are now kept everywhere.

`spiral` records milestone rows up to its first full hit, then one row per
subsequent hit. The existing `full` column distinguishes them.

## Run loop

```
for task in tasks:
    for (from, to) in task.edges:
        template = build_template(task.setup_for(from))
        (target_bits, care_bits, num_bits) = encode_target(task.encoding, to)
        if task.topology == Spiral:
            search_all(...)      # every hit across the budget
        else:
            climb = search_target(..., stop_on_full = match_mode == Full)
            record_milestones(...)
```

`search_target` is unchanged. `search_all` is new and sits beside it: fixed
`RAMP_MAX` windows over the whole budget, recording a row on every window whose
best is a full match while tracking best-so-far for the milestone rows.

`--list` prints the topology, the hub where there is one, and the edge count, so
the cost of a `graph` task is visible before it runs.

## Testing

New unit tests, alongside the existing `win32`, `best_match` and hashed-digest
layering tests:

- `edges()` per topology: exact edge list and order for a three-word list, the
  two-word boundary for `chain`/`ring`/`graph`, and the single-word stars.
- `hub` required for the three shapes that need it, rejected for the three that
  do not, with the task label in both messages.
- Missing and unknown `topology` name all six spellings.
- `case = "insensitive"` produces the same care mask the old `ascii8_ci` slug did,
  and `sensitive` produces a fully-significant mask.
- `baudot` + effective `sensitive` warns and still loads, with `insensitive`
  recorded as the effective case; `baudot` + `insensitive` does not warn.
- `plain` with an overlong *list* word is rejected and the message names that
  word, not just the task.
- The CSV header matches the field order written by `record`.

## Out of scope

- A kernel that returns a hit list rather than a single best, which is what
  exhaustive spiral collection would need.
- Sharing one grind across several targets, as the old collect modes did. The
  counter-from-zero rule rules it out by design.
- Weighted, undirected, or explicitly enumerated edge lists. Six named shapes
  cover the current work; an `edges = [[a, b], ...]` escape hatch can come later
  if a shape turns up that none of them draw.
