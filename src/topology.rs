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
        let hub = || hub.expect("hub-bearing topology asked for edges without a hub").to_string();
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
            Topology::Chain,
            Topology::Ring,
            Topology::StarTo,
            Topology::StarFrom,
            Topology::Graph,
            Topology::Spiral,
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
