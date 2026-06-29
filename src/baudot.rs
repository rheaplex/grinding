//! ITA2 (CCITT-2 / "Baudot") 5-bit code with LETTERS/FIGURES shifting.
//!
//! Each character is one 5-bit code; switching between the letter set and the
//! figure set emits a 5-bit shift code (`FIGS` 0x1B, `LTRS` 0x1F). Space (0x04)
//! exists in both sets, so word boundaries never force a shift. Letters are
//! case-insensitive. Returns the logical 5-bit symbol stream; bit-packing is
//! done by the caller.

pub const FIGS: u8 = 0x1B; // shift to figures
pub const LTRS: u8 = 0x1F; // shift to letters
pub const SPACE: u8 = 0x04; // same code in both shifts

// Indexed by 5-bit code (0..=31). '\0' marks a control/shift slot that is not a
// directly encodable character.
const LETTERS: [char; 32] = [
    '\0', 'e', '\0', 'a', ' ', 's', 'i', 'u', '\0', 'd', 'r', 'j', 'n', 'f', 'c', 'k',
    't', 'z', 'l', 'w', 'h', 'y', 'p', 'q', 'o', 'b', 'g', '\0', 'm', 'x', 'v', '\0',
];
const FIGURES: [char; 32] = [
    '\0', '3', '\0', '-', ' ', '\'', '8', '7', '\0', '$', '4', '\x07', ',', '!', ':', '(',
    '5', '"', ')', '2', '#', '6', '0', '1', '9', '?', '&', '\0', '.', '/', ';', '\0',
];

#[derive(Debug, PartialEq, Eq)]
pub enum EncodeError {
    Unsupported(char),
}

fn lookup(table: &[char; 32], ch: char) -> Option<u8> {
    table
        .iter()
        .position(|&c| c == ch && c != '\0')
        .map(|p| p as u8)
}

/// Encode `input` to a stream of 5-bit codes (shift codes included).
pub fn codes(input: &str) -> Result<Vec<u8>, EncodeError> {
    let mut out = Vec::with_capacity(input.len());
    let mut figs = false; // false = LETTERS shift
    for ch in input.chars() {
        if ch == ' ' {
            out.push(SPACE);
            continue;
        }
        let lc = ch.to_ascii_lowercase();
        if let Some(code) = lookup(&LETTERS, lc) {
            if figs {
                out.push(LTRS);
                figs = false;
            }
            out.push(code);
        } else if let Some(code) = lookup(&FIGURES, ch) {
            if !figs {
                out.push(FIGS);
                figs = true;
            }
            out.push(code);
        } else {
            return Err(EncodeError::Unsupported(ch));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_no_shift() {
        // "the" — all letters, no shift codes, 3 codes.
        assert_eq!(codes("the").unwrap(), vec![0x10, 0x14, 0x01]);
    }

    #[test]
    fn space_never_shifts() {
        let c = codes("a b").unwrap();
        assert!(!c.contains(&FIGS) && !c.contains(&LTRS));
        assert_eq!(c.len(), 3);
    }

    #[test]
    fn figures_shift_once() {
        // "a1a" needs FIGS before '1' and LTRS before the trailing 'a'.
        let c = codes("a1a").unwrap();
        assert_eq!(c, vec![0x03, FIGS, 0x17, LTRS, 0x03]);
    }

    #[test]
    fn rejects_unsupported() {
        assert_eq!(codes("a~b"), Err(EncodeError::Unsupported('~')));
    }
}
