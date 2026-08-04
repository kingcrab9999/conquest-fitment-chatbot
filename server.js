/**
 * server.js (fitment-chatbot)
 *
 * Standalone backend for the "fitment finder" chat widget. Separate from
 * your importer's server.js — this one serves customers on the live site,
 * so it needs to be deployed somewhere always-on (Render.com, etc.),
 * unlike the importer which only needs to run on your machine.
 *
 * Endpoints:
 *   GET  /api/years                         -> [2015, 2016, ...]  (free, no AI)
 *   GET  /api/makes?year=2015                -> ["chevrolet", ...] (free, no AI)
 *   GET  /api/models?year=2015&make=chevrolet -> ["silverado", ...] (free, no AI)
 *   GET  /api/qualifiers?year=&make=&model=  -> { side: [...], color: [...], ... } (free, no AI)
 *   POST /api/match                          -> matching products for given criteria (free, no AI)
 *   POST /api/chat                           -> free-text fallback (the ONLY endpoint that calls Claude)
 *
 * Usage:
 *   node buildIndex.js   (run this first, and after every catalog change)
 *   node server.js
 */

require('dotenv').config();
const express = require('express');
const {
  getYears,
  getMakes,
  getModels,
  getMatches,
  getQualifierOptions,
  filterByQualifiers,
  filterByKeyword,
  groupBySimilarity,
} = require('./fitmentQuery');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function trimForDisplay(p) {
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    image: p.image,
    sku: p.sku,
    price: p.price,
    variantId: p.variantId,
    side: p.side,
    position: p.position,
    color: p.color,
    engine: p.engine,
    option_package: p.option_package,
    other_qualifiers: p.other_qualifiers,
  };
}

// ── Free, no-AI endpoints ────────────────────────────────────────

app.get('/api/years', (req, res) => {
  try {
    res.json({ years: getYears() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/makes', (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    res.json({ makes: getMakes(year) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/models', (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    res.json({ models: getModels(year, req.query.make) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/qualifiers', (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    const matches = getMatches(year, req.query.make, req.query.model);
    res.json({
      matchCount: matches.length,
      qualifiers: getQualifierOptions(matches),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/match', (req, res) => {
  try {
    const { year, make, model, side, color, engine, option_package } = req.body || {};
    let matches = getMatches(year ? Number(year) : null, make, model);
    matches = filterByQualifiers(matches, { side, color, engine, option_package });
    res.json({
      matchCount: matches.length,
      products: matches.slice(0, 20).map(trimForDisplay),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── The one AI endpoint: free-text fallback ──────────────────────
// Only called when the customer types a full sentence instead of using
// the dropdowns. Claude's ONLY job here is to pull structured criteria
// out of the sentence — it never decides fitment itself. All matching
// still runs through the same deterministic getMatches()/filterByQualifiers()
// logic used by the dropdown path, so the AI can't hallucinate a fitment
// answer; it can only mis-parse the sentence (worst case: asks for
// clarification instead of guessing).

const PARSE_SYSTEM_PROMPT = `You extract vehicle fitment search criteria from a customer's message about an auto part.
Given their message and any already-known criteria, output ONLY a JSON object (no markdown, no preamble):

{
  "year": number or null,
  "make": string or null,
  "model": string or null,
  "side": "driver" | "passenger" | null,
  "position": "front" | "rear" | "upper" | "lower" | null,
  "color": string or null,
  "engine": string or null,
  "option_package": string or null,
  "keyword": string or null
}

Rules:
- Carry forward any already-known criteria unless the new message changes it.
- Only fill a field if it's actually stated or clearly implied (e.g. "my truck" doesn't imply a make).
- Normalize make/model to standard vehicle naming (e.g. "silverado" not "chevy truck").
- "keyword" is what PART the customer is asking about (e.g. "armrest", "door handle", "mirror",
  "tail light") — extract this whenever the message names or describes a part, even if it also
  contains vehicle info. Carry it forward from already-known criteria too, unless the new message
  is clearly asking about a different part.
- Respond with the JSON object only.`;

async function parseCriteriaFromMessage(message, knownCriteria) {
  const userContent = `Already known: ${JSON.stringify(knownCriteria || {})}\nCustomer message: ${message}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 300,
      system: PARSE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.content.find((b) => b.type === 'text')?.text || '';
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Chat is not configured (missing ANTHROPIC_API_KEY)' });

    const criteria = await parseCriteriaFromMessage(message, context);

    // If we don't have at least a make or a model, don't attempt matching at
    // all — with no vehicle identified, "matches" would be a huge slice of
    // the whole catalog and the qualifier lists below would be meaningless.
    if (!criteria.make && !criteria.model) {
      return res.json({
        reply: `What vehicle is this for? Give me at least the make and model (year helps too) and I can narrow it down.`,
        criteria,
        matchCount: null,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    let matches = getMatches(criteria.year, criteria.make, criteria.model);
    matches = filterByQualifiers(matches, criteria);
    matches = filterByKeyword(matches, criteria.keyword);

    // Guard rail: if the match set is still huge, the customer's vehicle
    // isn't actually narrowed down yet (e.g. make matched but not model) —
    // ask for more identifying info instead of computing/listing qualifiers
    // across a huge, mostly-unrelated set of products.
    const MAX_REASONABLE_MATCHES = 25;
    if (matches.length > MAX_REASONABLE_MATCHES) {
      return res.json({
        reply: `That matches quite a few parts (${matches.length}) — can you tell me more specifically what part you're looking for, or narrow the model/trim?`,
        criteria,
        matchCount: matches.length,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    const qualifiers = getQualifierOptions(matches);

    // Before asking "which side/color/engine", check whether these matches
    // are actually variants of ONE part, or several different parts that
    // just happen to share the keyword (e.g. "handle" matching a door handle,
    // a tailgate handle, and a hood latch — asking "which side?" across all
    // of those wouldn't make sense).
    const groups = matches.length > 1 ? groupBySimilarity(matches) : [matches];

    if (groups.length > 1) {
      const options = groups.map((g) => g[0]);
      return res.json({
        reply: `I found a few different parts that could match "${criteria.keyword || message}" — which of these did you mean?`,
        criteria,
        matchCount: matches.length,
        products: options.map(trimForDisplay),
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
        needsProductSelection: true,
      });
    }

    // Cap how many distinct values we'll ever quote back in a sentence —
    // if a field somehow still has a long tail of values, list a few and
    // say "or others" rather than producing an unreadable wall of text.
    const MAX_LISTED_VALUES = 5;
    const formatList = (values) =>
      values.length > MAX_LISTED_VALUES
        ? `${values.slice(0, MAX_LISTED_VALUES).join(', ')}, or others`
        : values.join(' or ');

    const stillAmbiguous =
      matches.length > 1 &&
      (qualifiers.side.length > 1 ||
        qualifiers.color.length > 1 ||
        qualifiers.engine.length > 1 ||
        qualifiers.option_package.length > 1);

    let reply;
    if (matches.length === 0) {
      reply = `I couldn't find a match for that — could you double check the year, make, and model? Or one of the details (like engine or side) might not match what's in stock.`;
    } else if (stillAmbiguous) {
      const asks = [];
      if (qualifiers.side.length > 1) asks.push(`which side (${formatList(qualifiers.side)})`);
      if (qualifiers.engine.length > 1) asks.push(`which engine (${formatList(qualifiers.engine)})`);
      if (qualifiers.color.length > 1) asks.push(`which color (${formatList(qualifiers.color)})`);
      if (qualifiers.option_package.length > 1) asks.push(`whether you have ${formatList(qualifiers.option_package)}`);
      reply = `I found a few options for that vehicle — I just need to know ${asks.join(', and ')}.`;
    } else if (matches.length === 1) {
      reply = `Found it — this fits your vehicle.`;
    } else {
      reply = `Found ${matches.length} matching options for your vehicle.`;
    }

    res.json({
      reply,
      criteria,
      matchCount: matches.length,
      products: matches.slice(0, 20).map(trimForDisplay),
      qualifiers,
    });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Fitment chatbot backend running at http://localhost:${PORT}`);
  console.log(ANTHROPIC_API_KEY ? '✅ AI free-text fallback enabled' : '⚠️  No ANTHROPIC_API_KEY — free-text chat disabled, dropdowns still work');
});
