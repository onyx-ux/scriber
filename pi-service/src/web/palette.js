// The twenty-four colours a voice can be written in.
//
// Ten of them are the dragons — five chromatic, five metallic — and the other
// two are the ones the operator asked for that no dragon covers: an eldritch
// purple and an ocean blue. Each family has two shades, deep and bright, so
// two people can share a family without sharing a colour.
//
// Every colour is TWO values, and that is the whole reason this is a table
// rather than a dozen hex codes typed into a stylesheet. The dashboard has a
// dark theme and a light one, and a colour that reads on parchment is invisible
// on slate. Both values were tuned rather than picked: each clears 4.5:1 as
// text on the LIGHTEST surface its theme ever puts text on — `--raise` on the
// dark theme, `--card` on the light one — so a name stays legible on a selected
// row as well as on the page. See test/palette.test.js, which re-measures all
// forty-eight rather than trusting this comment.
//
// What is stored against a person is the SLUG, never a hex. A stored colour
// outlives a retune, a theme, and the day somebody decides the green dragon was
// too yellow; a stored hex would freeze one theme's answer into the database
// and let a client write any string it liked into the page's style attribute.
//
// The dashboard carries the same forty-eight values in CSS, because it is a
// static file with no build step. That duplication is real, and the test above
// reads both files and fails if they drift.

export const VOICES = [
  // Red — the red dragon.
  { slug: 'red-deep', family: 'red', name: 'Red', shade: 'deep', light: '#940014', dark: '#F55B57' },
  { slug: 'red-bright', family: 'red', name: 'Red', shade: 'bright', light: '#C92F33', dark: '#FF8A82' },
  // Copper — the copper dragon.
  { slug: 'copper-deep', family: 'copper', name: 'Copper', shade: 'deep', light: '#7B3600', dark: '#DA7431' },
  { slug: 'copper-bright', family: 'copper', name: 'Copper', shade: 'bright', light: '#B25200', dark: '#FC9252' },
  // Bronze — the bronze dragon.
  { slug: 'bronze-deep', family: 'bronze', name: 'Bronze', shade: 'deep', light: '#5D4934', dark: '#A28C75' },
  { slug: 'bronze-bright', family: 'bronze', name: 'Bronze', shade: 'bright', light: '#7F6A55', dark: '#C3AD95' },
  // Brass — the brass dragon.
  { slug: 'brass-deep', family: 'brass', name: 'Brass', shade: 'deep', light: '#614A00', dark: '#AD8B2F' },
  { slug: 'brass-bright', family: 'brass', name: 'Brass', shade: 'bright', light: '#896900', dark: '#D0AD54' },
  // Gold — the gold dragon.
  { slug: 'gold-deep', family: 'gold', name: 'Gold', shade: 'deep', light: '#525000', dark: '#979300' },
  { slug: 'gold-bright', family: 'gold', name: 'Gold', shade: 'bright', light: '#737000', dark: '#BCB800' },
  // Green — the green dragon.
  { slug: 'green-deep', family: 'green', name: 'Green', shade: 'deep', light: '#005E28', dark: '#34A357' },
  { slug: 'green-bright', family: 'green', name: 'Green', shade: 'bright', light: '#007F38', dark: '#61CB7C' },
  // Ocean — deep water.
  { slug: 'ocean-deep', family: 'ocean', name: 'Ocean', shade: 'deep', light: '#005957', dark: '#00A09D' },
  { slug: 'ocean-bright', family: 'ocean', name: 'Ocean', shade: 'bright', light: '#007A77', dark: '#48C7C3' },
  // Blue — the blue dragon.
  { slug: 'blue-deep', family: 'blue', name: 'Blue', shade: 'deep', light: '#0145A7', dark: '#4F8EF7' },
  { slug: 'blue-bright', family: 'blue', name: 'Blue', shade: 'bright', light: '#2D6AD0', dark: '#82B2FF' },
  // Eldritch — something older than dragons.
  { slug: 'eldritch-deep', family: 'eldritch', name: 'Eldritch', shade: 'deep', light: '#6F2584', dark: '#BD72D4' },
  { slug: 'eldritch-bright', family: 'eldritch', name: 'Eldritch', shade: 'bright', light: '#974DAD', dark: '#DB8EF2' },
  // Black — the black dragon.
  { slug: 'black-deep', family: 'black', name: 'Black', shade: 'deep', light: '#3E5437', dark: '#7D9675' },
  { slug: 'black-bright', family: 'black', name: 'Black', shade: 'bright', light: '#5D7455', dark: '#A0BA98' },
  // Silver — the silver dragon.
  { slug: 'silver-deep', family: 'silver', name: 'Silver', shade: 'deep', light: '#4B4D53', dark: '#8D8F95' },
  { slug: 'silver-bright', family: 'silver', name: 'Silver', shade: 'bright', light: '#6B6D74', dark: '#AEB1B8' },
  // White — the white dragon.
  { slug: 'white-deep', family: 'white', name: 'White', shade: 'deep', light: '#005474', dark: '#4F98BB' },
  { slug: 'white-bright', family: 'white', name: 'White', shade: 'bright', light: '#2A7597', dark: '#73BBE1' },
];

// The lookup behind both exports below.
const BY_SLUG = new Map(VOICES.map((v) => [v.slug, v]));

export const voiceColour = (slug) => BY_SLUG.get(String(slug ?? '')) ?? null;

// Whether this string is one of the twenty-four.
//
// Empty and null are deliberately NOT colours: clearing your colour is a real
// act with its own meaning, and the caller says so by passing nothing rather
// than by passing a colour named "none".
export const isVoiceColour = (slug) => BY_SLUG.has(String(slug ?? ''));

export const VOICE_SLUGS = VOICES.map((v) => v.slug);
