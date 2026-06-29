//! 4-bit two-state Baudot-style code for `[a-z]` + space + `.` `,`.
//!
//! Single shift codepoint (`0xF`) flips between two 15-slot states; that
//! reclaims `0xE` as a data slot (vs a two-shift scheme), leaving room for two
//! punctuation marks while still holding all 26 letters. Space lives in *both*
//! states so word boundaries never force a shift. There is no end-of-message
//! sentinel — the decoder relies on an external nibble-count length specifier.
//!
//! Encoding normalizes input: ASCII letters are lowercased and any character
//! outside the alphabet is dropped, so it never fails.
//!
//! Copied from the `tnsy` project ("Variant 2: one shift code").

/// Pack 4-bit nibbles into bytes, high nibble first. A trailing odd nibble
/// parks in the high half of the final byte; its low half is unused padding.
/// The returned count is the authoritative external length specifier.
fn pack_nibbles(nibbles: &[u8]) -> (Vec<u8>, usize) {
    let mut bytes = Vec::with_capacity((nibbles.len() + 1) / 2);
    for pair in nibbles.chunks(2) {
        let hi = pair[0] << 4;
        let lo = if pair.len() == 2 { pair[1] } else { 0 };
        bytes.push(hi | lo);
    }
    (bytes, nibbles.len())
}

fn unpack_nibbles(bytes: &[u8], nibble_count: usize) -> Vec<u8> {
    let mut nibbles = Vec::with_capacity(nibble_count);
    for (i, &b) in bytes.iter().enumerate() {
        nibbles.push(b >> 4);
        if i * 2 + 1 < nibble_count {
            nibbles.push(b & 0x0F);
        }
    }
    nibbles.truncate(nibble_count);
    nibbles
}

#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    InvalidCode(u8),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    A,
    B,
}

impl State {
    fn flip(self) -> State {
        match self {
            State::A => State::B,
            State::B => State::A,
        }
    }
}

fn find_in(table: &[char], ch: char) -> Option<u8> {
    table.iter().position(|&c| c == ch).map(|p| p as u8)
}

pub const SHIFT: u8 = 0xF;

// 15 slots each (indices 0..=14), 30 total. Space is duplicated into both
// states (costing 2 slots), the 26 letters fill 26, leaving exactly TWO free
// data slots — here '.' and ',', both placed in state A.
pub const STATE_A: [char; 15] = [
    ' ', 'e', 't', 'a', 'o', 'i', 'n', 's', 'h', 'r', 'd', 'l', 'c', '.', ',',
];
pub const STATE_B: [char; 15] = [
    ' ', 'u', 'm', 'w', 'f', 'g', 'y', 'p', 'b', 'v', 'k', 'j', 'x', 'q', 'z',
];

fn table(state: State) -> &'static [char; 15] {
    match state {
        State::A => &STATE_A,
        State::B => &STATE_B,
    }
}

/// The logical 4-bit nibble stream for `input` (shift codes included), before
/// byte-packing. Each nibble is 4 bits. Input is normalized: ASCII letters are
/// lowercased and characters outside the alphabet (digits, most punctuation, …)
/// are dropped, so encoding always succeeds.
pub fn nibbles(input: &str) -> Vec<u8> {
    let mut state = State::A;
    let mut nibbles = Vec::with_capacity(input.len());
    for ch in input.chars() {
        let ch = ch.to_ascii_lowercase();
        if let Some(code) = find_in(table(state), ch) {
            nibbles.push(code);
        } else if let Some(code) = find_in(table(state.flip()), ch) {
            nibbles.push(SHIFT);
            state = state.flip();
            nibbles.push(code);
        }
        // else: character not in the alphabet — strip it.
    }
    nibbles
}

// Byte-packed form + round-trip decode are kept as a convenience surface even
// though the search path consumes the raw nibble stream above.
#[allow(dead_code)]
pub fn encode(input: &str) -> (Vec<u8>, usize) {
    pack_nibbles(&nibbles(input))
}

#[allow(dead_code)]
pub fn decode(bytes: &[u8], nibble_count: usize) -> Result<String, DecodeError> {
    let nibbles = unpack_nibbles(bytes, nibble_count);
    let mut state = State::A;
    let mut out = String::new();
    for &n in &nibbles {
        match n {
            SHIFT => state = state.flip(),
            code if (code as usize) < 15 => out.push(table(state)[code as usize]),
            other => return Err(DecodeError::InvalidCode(other)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLES: &[&str] = &[
        "non",
        "is art",
        "ten k drop",
        "self identifying",
        "tokens equal text",
        "type oposite images",
        "the ego and its owned",
        "the fractionalized phallus",
        "certificate of inauthenticity",
    ];

    #[test]
    fn one_shift_roundtrip() {
        for s in SAMPLES {
            let (bytes, len) = encode(s);
            assert_eq!(decode(&bytes, len).unwrap(), *s, "one_shift {s:?}");
        }
    }

    #[test]
    fn one_shift_handles_extra_punctuation() {
        // One-shift adds exactly two marks ('.' and ',') over the letters+space set.
        let s = "hello, world. one more test, please.";
        let (bytes, len) = encode(s);
        assert_eq!(decode(&bytes, len).unwrap(), s);
    }

    #[test]
    fn lowercases_and_strips_unsupported() {
        // Uppercase -> lowercase; '!' and '?' are not in the alphabet -> dropped.
        let (bytes, len) = encode("Hi! There?");
        assert_eq!(decode(&bytes, len).unwrap(), "hi there");
        assert_eq!(nibbles("TET"), nibbles("tet"));
    }

    #[test]
    fn odd_nibble_padding_roundtrips() {
        let (bytes, len) = encode("ate"); // 3 nibbles, all state A
        assert_eq!(len, 3);
        assert_eq!(bytes.len(), 2); // 3 nibbles -> 2 bytes, last half padded
        assert_eq!(decode(&bytes, len).unwrap(), "ate");
    }
}
