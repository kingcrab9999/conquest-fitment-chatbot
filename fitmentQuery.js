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

// Adds or replaces a single product's record in the live index, without
// needing to re-fetch and rebuild the whole 13,000+ product catalog. Used
// so a new import shows up in customer searches within seconds, rather than
// waiting for the next full deploy/rebuild.
function upsertProduct(record) {
  const index = loadIndex();
  const existingIdx = index.products.findIndex((p) => p.id === record.id);
  if (existingIdx >= 0) {
    index.products[existingIdx] = record;
  } else {
    index.products.push(record);
  }
  index.productCount = index.products.length;
  index.builtAt = new Date().toISOString();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  cachedIndex = index; // update in-memory cache immediately, don't wait for next stat check
  cachedMtime = fs.statSync(INDEX_FILE).mtimeMs;
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

function getAllKnownMakes() {
  const index = loadIndex();
  const set = new Set();
  for (const p of index.products) for (const m of p.makes) set.add(m);
  return Array.from(set);
}

function getAllKnownModels() {
  const index = loadIndex();
  const set = new Set();
  for (const p of index.products) for (const m of p.models) set.add(m);
  return Array.from(set);
}

// Corrects a typo'd make/model to the closest real one in the catalog —
// e.g. "explore" -> "Explorer". Only used when there's no exact match at
// all; a genuinely different (but valid) vehicle name should never get
// silently rewritten into a similar-looking one.
function fuzzyCorrectVehicleName(input, knownList, maxDist = 2) {
  if (!input) return input;
  const key = normalizeKey(input);
  if (knownList.some((k) => normalizeKey(k) === key)) return input; // exact match already
  let best = null;
  let bestDist = Infinity;
  for (const k of knownList) {
    const d = levenshtein(key, normalizeKey(k));
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best && bestDist <= maxDist ? best : input;
}

// Whether this make exists anywhere in the catalog at all (after attempting
// typo correction) — used to give an honest "we don't carry that vehicle
// type" answer instead of a generic no-match.
function isKnownMake(make) {
  if (!make) return true;
  const corrected = fuzzyCorrectVehicleName(make, getAllKnownMakes());
  return getAllKnownMakes().some((m) => normalizeKey(m) === normalizeKey(corrected));
}

// Checks whether a token is actually a real vehicle make/model ("Mazda3"
// matching stored "Mazda 3" once spaces are normalized away) or a real word
// from the catalog's vocabulary (transmission codes like "6R140", engine
// designations, etc.) — used to stop these from being misread as an
// unrecognized OEM part number just because they happen to share the same
// alphanumeric shape.
function isKnownVehicleTerm(token) {
  const key = normalizeKey(token);
  if (!key) return false;
  const isMakeOrModel = getAllKnownMakes().some((m) => normalizeKey(m) === key) || getAllKnownModels().some((m) => normalizeKey(m) === key);
  if (isMakeOrModel) return true;
  const index = loadIndex();
  const vocab = index.vocabulary || [];
  return vocab.includes(token.toLowerCase());
}

// Some models are stored with a trim/weight-class suffix baked in
// ("ProMaster 1500", "Transit 250") because that's how the listings
// describe them — but customers naturally just say "ProMaster" or
// "Transit" with no number. Exact/fuzzy matching alone can't bridge that
// gap (the strings are too different), so this checks whether the stored
// model starts with the customer's model at a word boundary (space or
// dash), which correctly matches "ProMaster" against all three of
// "ProMaster 1500/2500/3500" at once rather than requiring one exact pick.
function modelMatches(customerModel, storedModel) {
  if (normalizeKey(customerModel) === normalizeKey(storedModel)) return true;
  const c = customerModel.toLowerCase().trim();
  const s = storedModel.toLowerCase().trim();
  // Either direction — a generic customer input matching a more-specific
  // stored model ("ProMaster" -> "ProMaster 1500"), or a customer being
  // more specific than what's stored ("Transit 250" -> stored "Transit").
  // Both patterns show up in this catalog depending on how each listing
  // happened to be tagged.
  return s.startsWith(c + ' ') || s.startsWith(c + '-') || c.startsWith(s + ' ') || c.startsWith(s + '-');
}

// Ram trucks split off from Dodge as their own brand in 2010, but this
// catalog's fitment data was extracted inconsistently over time — some
// listings are tagged make="Dodge" + model="Ram 1500", others make="Ram" +
// model="1500", for what's conceptually the exact same vehicle. These
// helpers treat both conventions as equivalent everywhere matching happens,
// so it doesn't matter which way a given listing (or a customer) phrases it.
function isDodgeOrRamMake(make) {
  const k = normalizeKey(make);
  return k === 'dodge' || k === 'ram';
}
function stripLeadingRam(model) {
  return (model || '').replace(/^ram\s+/i, '').trim();
}

function getMatches(year, make, model) {
  const index = loadIndex();
  const correctedMake = make ? fuzzyCorrectVehicleName(make, getAllKnownMakes()) : make;
  const makeKey = normalizeKey(correctedMake);
  const ramBrandMatch = isDodgeOrRamMake(correctedMake);

  function makeOk(p) {
    if (!makeKey) return true;
    if (ramBrandMatch) return p.makes.some((m) => isDodgeOrRamMake(m));
    return p.makes.some((m) => normalizeKey(m) === makeKey);
  }

  function modelOk(p, useModel) {
    if (!useModel) return true;
    if (p.models.some((m) => modelMatches(useModel, m))) return true;
    // For Ram/Dodge specifically, also compare with a leading "Ram " on
    // either side stripped, since that's exactly where the two tagging
    // conventions diverge ("Ram 1500" vs "1500").
    if (ramBrandMatch) {
      const strippedInput = stripLeadingRam(useModel);
      if (p.models.some((m) => modelMatches(strippedInput, stripLeadingRam(m)))) return true;
    }
    return false;
  }

  // Try the model as given first (handles both exact matches and the
  // trim-suffix case above). Only fall back to typo-correction if that
  // finds nothing at all — otherwise a genuine typo-correction could
  // arbitrarily collapse "ProMaster" onto just one of its three trims
  // instead of matching all of them via the prefix check.
  let workingModel = model;
  if (model) {
    const candidates = index.products.filter((p) => coversYear(p, year) && makeOk(p));
    const hasDirectMatch = candidates.some((p) => modelOk(p, model));
    if (!hasDirectMatch) {
      workingModel = fuzzyCorrectVehicleName(model, getAllKnownModels());
    }
  }

  return index.products.filter((p) => {
    if (!coversYear(p, year)) return false;
    if (!makeOk(p)) return false;
    if (!modelOk(p, workingModel)) return false;
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
    position: distinct('position'),
    color: distinct('color'),
    engine: distinct('engine'),
    option_package: distinct('option_package'),
  };
}

function filterByQualifiers(matches, answers = {}) {
  return matches.filter((p) => {
    if (answers.side && p.side && p.side !== answers.side) return false;
    if (answers.position && p.position && p.position !== answers.position) return false;
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
// Standard edit-distance calculation — used to catch typos the AI parser
// might not have corrected (e.g. "huse" vs "hose", one substitution away).
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function filterByKeyword(matches, keyword) {
  if (!keyword) return matches;
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);

  const exact = matches.filter((p) => {
    const title = p.title.toLowerCase();
    return words.every((w) => title.includes(w));
  });
  if (exact.length > 0) return exact;

  // Nothing matched exactly — the AI's typo correction may have missed this
  // one. Retry with fuzzy word-level matching (small edit distance) before
  // giving up, so a typo alone doesn't produce a false "not found."
  return matches.filter((p) => {
    const titleWords = p.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return words.every((w) => {
      // Distance 1 only, regardless of word length — the old length-based
      // bump to 2 was too loose and matched unrelated words like "brake"
      // vs "bracket" (genuinely 2 edits apart, but not a typo of each
      // other). Distance 1 still catches real single-letter typos like
      // "huse" -> "hose".
      const maxDist = 1;
      return titleWords.some((tw) => levenshtein(w, tw) <= maxDist);
    });
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
      // Complete-linkage: must be similar enough to EVERY existing member of
      // the group, not just the first one added. Single-linkage let a
      // generic item (e.g. plain "Door Handle") "bridge" two genuinely
      // different parts (a trim cover and a full handle assembly) into the
      // same group just because it happened to overlap with both.
      const allSimilar = g.signatures.every((sig) => jaccardSimilarity(signature, sig) >= threshold);
      if (allSimilar) {
        g.items.push(m);
        g.signatures.push(signature);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ signatures: [signature], items: [m] });
  }
  return groups.map((g) => g.items);
}

// Checks whether ANY word in the given keyword appears anywhere in the
// catalog-wide vocabulary — used to tell "we just don't carry this part at
// all" apart from "we carry it, but not for this specific vehicle."
function isKnownPartType(keyword) {
  if (!keyword) return true; // no keyword given — not a "we don't carry it" situation
  const index = loadIndex();
  const vocab = new Set(index.vocabulary || []);
  const words = keyword.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return true;
  return words.some((w) => vocab.has(w));
}

// Strips everything but letters/numbers and uppercases, so "HC3Z-7890-A",
// "hc3z7890a", and "HC3Z 7890 A" all compare equal — customers won't always
// type a part number with the exact dashes/spacing it's stored with.
function normalizeSku(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Direct part-number/SKU lookup — checked before any AI parsing, since a
// SKU already uniquely identifies the exact part and needs no vehicle info
// at all. Requires at least 5 alphanumeric characters to avoid false
// positives on short, ordinary search words.
function findBySku(query) {
  const target = normalizeSku(query);
  if (target.length < 5) return null;
  const index = loadIndex();
  return index.products.find((p) => normalizeSku(p.sku) === target) || null;
}

// Same idea as findBySku, but scans a longer message for a SKU-shaped token
// embedded within it (e.g. "...Trim Panel OEM 6BM40TX7AC") rather than
// requiring the entire message to be just the SKU. Tries each "word" in the
// message as a candidate, longest first, so a real part number embedded in
// a full description still gets caught directly.
function findEmbeddedSku(message) {
  const tokens = message.split(/\s+/).filter((t) => t.replace(/[^A-Za-z0-9]/g, '').length >= 5);
  const sorted = [...tokens].sort((a, b) => b.length - a.length);
  for (const token of sorted) {
    const match = findBySku(token);
    if (match) return match;
  }
  return null;
}

// When a search term isn't in the vocabulary at all, suggest the closest
// real words from the catalog instead of just saying "not found" — reuses
// the same edit-distance function as the keyword fuzzy-match fallback.
function suggestVocabularyTerms(keyword, maxSuggestions = 3) {
  if (!keyword) return [];
  const index = loadIndex();
  const vocab = index.vocabulary || [];
  const words = keyword.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
  const scored = [];
  for (const w of words) {
    for (const v of vocab) {
      const dist = levenshtein(w, v);
      if (dist > 0 && dist <= 3) scored.push({ term: v, dist });
    }
  }
  scored.sort((a, b) => a.dist - b.dist);
  const seen = new Set();
  const results = [];
  for (const s of scored) {
    if (seen.has(s.term)) continue;
    seen.add(s.term);
    results.push(s.term);
    if (results.length >= maxSuggestions) break;
  }
  return results;
}

module.exports = {
  loadIndex,
  upsertProduct,
  isKnownPartType,
  isKnownMake,
  isKnownVehicleTerm,
  findBySku,
  findEmbeddedSku,
  suggestVocabularyTerms,
  getYears,
  getMakes,
  getModels,
  getMatches,
  getQualifierOptions,
  filterByQualifiers,
  filterByKeyword,
  groupBySimilarity,
};
