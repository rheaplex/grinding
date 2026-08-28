// Token table — the single place the Grinding tokens are defined. Everything
// the other scripts need per token lives here: which work (page + data file)
// it is, its title and note, and the display configuration its preview is
// rendered with (the same vocabulary as the page's Config panel and the
// contract's TokenConfig; omitted fields take the page defaults).
//
// TOKEN_COUNT must match Grinding.sol. Order is the token order.

const TOKEN_COUNT = 12;

const TOKENS = [
  {
    id: 1,
    work: "number",
    page: "number.html",
    name: "Number",
    note: "Twelve words ground in a chain — one through twelve, each from the last.",
    config: {},
  },
  {
    id: 2,
    work: "shape",
    page: "shape.html",
    name: "Shape",
    note: "Nine shapes ground in a ring — dot round to spiral and back to dot.",
    config: {},
  },
  {
    id: 3,
    work: "colour",
    page: "colour.html",
    name: "Colour",
    note: "Eleven colours ground in a ring from red — brown’s yellow rested at yello.",
    config: {},
  },
  {
    id: 4,
    work: "pattern",
    page: "pattern.html",
    name: "Pattern",
    note: "Nine patterns ground from pattern — stripes and floral unfinished.",
    config: {},
  },
  {
    id: 5,
    work: "direction",
    page: "direction.html",
    name: "Direction",
    note: "Up, in, out, down, left, over, under, right — ground from center.",
    config: {},
  },
  {
    id: 6,
    work: "time",
    page: "time.html",
    name: "Time",
    note: "The day as a ring — night, dawn, morn, noon, dusk, eve.",
    config: {},
  },
  {
    id: 7,
    work: "genre",
    page: "genre.html",
    name: "Genre",
    note: "The genres of painting in a chain — myth down to thing.",
    config: {},
  },
  {
    id: 8,
    work: "value",
    page: "value.html",
    name: "Value",
    note: "Use, utility, aura, price, worth — five searches for art.",
    config: {},
  },
  {
    id: 9,
    work: "passions",
    page: "passions.html",
    name: "Passions",
    note: "Joy, love, wonder, hatred, desire, sorrow — ground from passions.",
    config: {},
  },
  {
    id: 10,
    work: "gender",
    page: "gender.html",
    name: "Gender",
    note: "She, her, they, girl, woman, femme, butch, demi, trans, queer — ground from gender.",
    config: {},
  },
  {
    id: 11,
    work: "icjbag",
    page: "icjbag.html",
    name: "But I can't just be a girl!",
    note: "yes, you, can — the answer ground word by word from the exclamation.",
    config: {},
  },
  {
    id: 12,
    work: "attribution",
    page: "attribution.html",
    name: "Attribution",
    note: "rhea and myers ground from artist — every hit collected.",
    config: {},
  },
];

module.exports = { TOKEN_COUNT, TOKENS };
