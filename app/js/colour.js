// Colour package — hash nibbles to colour, and the churn stand-in.
// Channels are clamped into FLOOR..CEIL so no figure ever meets a flat ground.
(function () {
  const grinding = window.grinding = window.grinding || {};

  // channels clamp into floor..CEIL; a dark scheme raises the floor so
  // zero bytes stay visible against a black ground
  const FLOOR = 10, CEIL = 245;
  const channel = (nibble, floor = FLOOR) => Math.round(floor + nibble * ((CEIL - floor) / 15));
  const hex2 = v => v.toString(16).padStart(2, "0");
  const rgb = (r, g, b) => "#" + hex2(r) + hex2(g) + hex2(b);

  // named encodings: hash text -> array of colours
  const encodings = {
    // 12-bit colour, three nibbles per cell (21 cells from a 64-nibble hash)
    rgb12: {
      label: "12-bit RGB",
      nibblesPerCell: 3,
      cells: 21,
      colour: (n, f) => rgb(channel(n[0], f), channel(n[1], f), channel(n[2], f))
    },
    // one nibble per cell, greyscale: 64 cells, the whole hash, nothing discarded
    grey4: {
      label: "4-bit grey",
      nibblesPerCell: 1,
      cells: 64,
      colour: (n, f) => { const v = channel(n[0], f); return rgb(v, v, v); }
    },
    // two nibbles per cell mapped along one hue axis: 32 cells
    duo8: {
      label: "8-bit duotone",
      nibblesPerCell: 2,
      cells: 32,
      colour: (n, f) => rgb(channel(n[0], f), channel((n[0] + n[1]) >> 1, f), channel(n[1], f))
    }
  };

  function cellsFromHash(hash, encoding = "rgb12", floor = FLOOR) {
    const e = typeof encoding === "string" ? encodings[encoding] : encoding;
    const out = [];
    for (let k = 0; k + e.nibblesPerCell <= hash.length && out.length < e.cells; k += e.nibblesPerCell) {
      const nibbles = [];
      for (let j = 0; j < e.nibblesPerCell; j++) nibbles.push(parseInt(hash[k + j], 16));
      out.push(e.colour(nibbles, floor));
    }
    return out;
  }

  function xorshift(a) { a = a | 0; a ^= a << 13; a ^= a >>> 17; a ^= a << 5; return a >>> 0; }

  // invented colours for the churn between matches — deterministic in the seed
  function churnCells(seed, count, encoding = "rgb12", floor = FLOOR) {
    const e = typeof encoding === "string" ? encodings[encoding] : encoding;
    const out = [];
    for (let k = 0; k < count; k++) {
      const s = xorshift(Math.imul(seed + 1, 2654435761) + Math.imul(k + 7, 40503));
      const nibbles = [];
      for (let j = 0; j < e.nibblesPerCell; j++) nibbles.push((s >>> (j * 4)) & 15);
      out.push(e.colour(nibbles, floor));
    }
    return out;
  }

  // invented hex digits for the churn between matches — deterministic in the seed
  function churnHex(seed, count) {
    let out = "";
    for (let k = 0; k < count; k++) {
      const s = xorshift(Math.imul(seed + 1, 2654435761) + Math.imul(k + 7, 40503));
      out += (s & 15).toString(16);
    }
    return out;
  }

  grinding.colour = { FLOOR, CEIL, channel, encodings, cellsFromHash, churnCells, churnHex };
})();
