const fs = require('fs');
const path = require('path');

const INDEX_FILE = path.join(__dirname, 'fitmentIndex.json');

let cachedIndex = null;
let cachedMtime = 0;

function loadIndex() {
  const stat = fs.statSync(INDEX_FILE);
  if (cachedIndex && stat.mtimeMs === cachedMtime) return cachedIndex;
  cachedIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  cachedMtime = stat.mtimeMs;
  return cachedIndex;
}

// Strips everything but letters/numbers and lowercases, so "F-150", "f150",
// and "F 150" all compare equal. Free-text queries won't always match the
// catalog's exact formatting, so every make/model comparison goes through
// this rather than relying on exact string equality.
function normalizeKey(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function coversYear(product, year) {
  if (year == null) return true;
  if (product.year_start == null) return true; // no year data — don't exclude, let make/model narrow it
  const end = product.year_end ?? product.year_start;
  return year >= product.year_start && year <= end;
}

function getYears() {
  const index = loadIndex();
  const years = new Set();
  for (const p of index.products) {
    if (p.year_start == null) continue;
    const end = p.year_end ?? p.year_start;
    for (let y = p.year_start; y <= end; y++) years.add(y);
  }
  return Array.from(years).sort((a, b) => b - a); // newest first
}

function getMakes(year) {
  const index = loadIndex();
  const makes = new Set();
  for (const p of index.products) {
    if (!coversYear(p, year)) continue;
    for (const m of p.makes) makes.add(m);
  }
  return Array.from(makes).sort();
}

function getModels(year, make) {
  const index = loadIndex();
  const models = new Set();
  const makeKey = normalizeKey(make);
  for (const p of index.products) {
    if (!coversYear(p, year)) continue;
    if (makeKey && !p.makes.some((m) => normalizeKey(m) === makeKey)) continue;
    for (const m of p.models) models.add(m);
  }
  return Array.from(models).sort();
}

function getMatches(year, make, model) {
  const index = loadIndex();
  const makeKey = normalizeKey(make);
  const modelKey = normalizeKey(model);
  return index.products.filter((p) => {
    if (!coversYear(p, year)) return false;
    if (makeKey && !p.makes.some((m) => normalizeKey(m) === makeKey)) return false;
    if (modelKey && !p.models.some((m) => normalizeKey(m) === modelKey)) return false;
    return true;
  });
}

// Given a set of matching products, figure out which follow-up questions
// are actually needed — i.e. which qualifier fields have more than one
// distinct value among the matches. If everything shares the same value
// (or nobody has one at all), there's nothing to ask about that field.
function getQualifierOptions(matches) {
  const distinct = (field) => {
    const values = new Set(matches.map((p) => p[field]).filter(Boolean));
    return Array.from(values);
  };
  return {
    side: distinct('side'),
    color: distinct('color'),
    engine: distinct('engine'),
    option_package: distinct('option_package'),
  };
}

function filterByQualifiers(matches, answers = {}) {
  return matches.filter((p) => {
    if (answers.side && p.side && p.side !== answers.side) return false;
    if (answers.color && p.color && p.color !== answers.color) return false;
    if (answers.engine && p.engine && p.engine !== answers.engine) return false;
    if (answers.option_package && p.option_package && p.option_package !== answers.option_package) return false;
    return true;
  });
}

// Narrows an already-vehicle-filtered match set by a part-type keyword the
// customer mentioned (e.g. "armrest", "door handle"). Simple case-insensitive
// substring match against the title — good enough since titles are
// consistently descriptive in this catalog, and this only runs on a set
// already narrowed by year/make/model, not the whole 13k-product catalog.
function filterByKeyword(matches, keyword) {
  if (!keyword) return matches;
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  return matches.filter((p) => {
    const title = p.title.toLowerCase();
    return words.every((w) => title.includes(w));
  });
}

// ── Distinguishing "variants of one part" from "different parts" ──────
// A keyword like "handle" can match a door handle, a tailgate handle, and a
// hood latch handle — those are different products, not color/side variants
// of the same thing. Asking "which side?" across all of them makes no
// sense. This clusters matches by title similarity (after stripping out the
// known qualifier values and generic noise words) so the caller can tell
// which situation it's dealing with before deciding what to ask.

const GROUPING_NOISE_WORDS = [
  'oem', 'genuine', 'new', 'used', 'painted', 'unpainted', 'metallic', 'billet',
  'silver', 'black', 'white', 'chrome', 'gray', 'grey', 'red', 'blue',
  'driver', 'passenger', 'side', 'left', 'right', 'w', 'wo', 'with', 'without',
  'for', 'the', 'and', 'or', 'a', 'an',
];

function normalizeForGrouping(title, knownQualifierValues) {
  let t = title.toLowerCase();
  t = t.replace(/\b(19|20)\d{2}\s*-\s*(19|20)?\d{2}\b/g, ' ');
  t = t.replace(/\b(19|20)\d{2}\b/g, ' ');
  for (const v of knownQualifierValues) {
    if (!v) continue;
    t = t.split(String(v).toLowerCase()).join(' ');
  }
  for (const w of GROUPING_NOISE_WORDS) {
    t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), ' ');
  }
  t = t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

function tokenSet(text) {
  return new Set(text.split(' ').filter(Boolean));
}

function jaccardSimilarity(a, b) {
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Greedy clustering: each product joins the first existing group whose
// representative signature is similar enough (Jaccard >= threshold), else
// starts a new group. Good enough for catalog title text — doesn't need to
// be perfect, just needs to catch "these are obviously different parts."
function groupBySimilarity(matches, threshold = 0.45) {
  const groups = [];
  for (const m of matches) {
    const qualifierValues = [m.side, m.color, m.engine, m.option_package];
    const signature = tokenSet(normalizeForGrouping(m.title, qualifierValues));
    let placed = false;
    for (const g of groups) {
      if (jaccardSimilarity(signature, g.signature) >= threshold) {
        g.items.push(m);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ signature, items: [m] });
  }
  return groups.map((g) => g.items);
}

module.exports = {
  loadIndex,
  getYears,
  getMakes,
  getModels,
  getMatches,
  getQualifierOptions,
  filterByQualifiers,
  filterByKeyword,
  groupBySimilarity,
};
