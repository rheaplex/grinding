// Render each token's preview. The preview is the whole composition — the
// page's titleblock, the drawing at its final state, and the colophon notes
// — captured from the work's own page in headless Chromium at 2x
// (previews/png/<id>.png, 3840x2160). The token's display config becomes the
// page's query parameters; timings are dropped in favour of duration=0 (the
// final state, instantly) and chrome=off hides the Config button.
//
// The drawing alone is also kept as previews/svg/<id>.svg — the same bytes
// the page's Save SVG produces — for provenance and print.
//
//   node scripts/gen-previews.js
//
// CHROME overrides the browser binary (default: chromium).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { TOKEN_COUNT, TOKENS } = require("./tokens");
const { APP_DIR, finalSvg } = require("./lib");

const CHROME = process.env.CHROME || "chromium";
const ROOT = path.join(__dirname, "..");
const SVG_DIR = path.join(ROOT, "previews", "svg");
const PNG_DIR = path.join(ROOT, "previews", "png");

fs.mkdirSync(SVG_DIR, { recursive: true });
fs.mkdirSync(PNG_DIR, { recursive: true });

// config fields -> the page's query parameter names; timings are omitted
// (a still has no timing) and replaced by duration=0
const PARAM = { layout: "layout", encoding: "encoding", display: "display", sizing: "size", scheme: "scheme" };

for (const token of TOKENS) {
  const query = new URLSearchParams();
  for (const [field, param] of Object.entries(PARAM)) {
    if (token.config[field]) query.set(param, token.config[field]);
  }
  query.set("duration", "0");
  query.set("chrome", "off");

  const pngPath = path.join(PNG_DIR, `${token.id}.png`);
  execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--hide-scrollbars",
    "--window-size=1920,1080", "--force-device-scale-factor=2",
    "--screenshot=" + pngPath,
    "file://" + path.join(APP_DIR, token.page) + "?" + query,
  ], { stdio: "ignore" });

  fs.writeFileSync(path.join(SVG_DIR, `${token.id}.svg`), finalSvg(token.work, token.config));
  console.log(`${token.id} ${token.name}: ${path.relative(ROOT, pngPath)}`);
}

if (TOKENS.length < TOKEN_COUNT) {
  console.warn(
    `warning: ${TOKENS.length} of ${TOKEN_COUNT} token slots filled; ` +
    `add the rest to scripts/tokens.js as their pages land`
  );
}
