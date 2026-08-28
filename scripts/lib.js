// Shared plumbing for the asset scripts: load the app's artwork packages
// outside a browser, and know the page's colour schemes.
//
// The app modules only ever touch `window.grinding` at load time (`document`
// appears solely in mount()/download(), which the scripts never call), so
// evaluating them with a bare object as `window` is enough to run the same
// code path as the page's Save SVG button.

const fs = require("fs");
const path = require("path");

const APP_DIR = path.join(__dirname, "..", "app");

// The scheme variable sets from app/css/styles.css, resolved the way
// app.js currentTheme() reads them off the body class.
const SCHEMES = {
  paper: { ground: "#ffffff", ink: "#16161a", grid: "#d5d2cb", ruleSoft: "#e4e2dc", magic: "#d0281e", magicWeight: "400" },
  night: { ground: "#000000", ink: "#ffffff", grid: "#3c3c42", ruleSoft: "#232326", magic: "#ff3b30", magicWeight: "400" },
  video: { ground: "#000000", ink: "#33ff33", grid: "#1c661c", ruleSoft: "#123f12", magic: "#7fff7f", magicWeight: "700" },
  inverse: { ground: "#33ff33", ink: "#000000", grid: "#1fb31f", ruleSoft: "#29cc29", magic: "#000000", magicWeight: "700" },
};

// app.js raises the colour floor on black grounds so zero bytes stay visible
const DARK_SCHEMES = ["night", "video"];
const DARK_CHANNEL_FLOOR = 48;

// Load the artwork packages plus one work's series data into a fresh
// `window`, returning the populated `window.grinding`.
function loadWork(work) {
  const files = [
    "js/colour.js", "js/layout.js", "js/animation.js", "js/render.js",
    "js/artwork.js", `data/${work}.js`,
  ];
  const window = {};
  for (const f of files) {
    const source = fs.readFileSync(path.join(APP_DIR, f), "utf8");
    new Function("window", source)(window);
  }
  return window.grinding;
}

// The final-state SVG for one work under one display configuration — the
// exact bytes the page's Save SVG produces for ?save=final with the same
// settings. `config` uses the page/contract vocabulary; unset fields take
// the artwork defaults.
function finalSvg(work, config = {}, exportScale = 2) {
  const g = loadWork(work);
  const scheme = config.scheme || "paper";
  const options = {};
  if (config.layout) options.layout = config.layout;
  if (config.encoding) options.encoding = config.encoding;
  if (config.display) options.display = config.display;
  if (config.sizing) options.sizing = config.sizing;
  if (DARK_SCHEMES.includes(scheme)) options.channelFloor = DARK_CHANNEL_FLOOR;
  const piece = g.artwork.build(options);
  const theme = { ...SCHEMES[scheme], exportScale };
  return g.artwork.svgAtFrame(piece, piece.finalFrame, theme);
}

module.exports = { APP_DIR, SCHEMES, loadWork, finalSvg };
