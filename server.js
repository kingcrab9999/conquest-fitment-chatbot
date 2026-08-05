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
  loadIndex,
  upsertProduct,
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
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'parts1.myshopify.com';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const SHOPIFY_API_VERSION = '2025-01';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Turns a messy full title into a short, clean label for a "which type of
// part is this" question — strips year ranges, the known make/model, and
// known qualifier values, leaving just the distinguishing part name.
// e.g. "2017-2022 Ford F-250 F-350 6.2 Transmission Oil Cooler Hose Radiator
// to Cooler" -> "Transmission Oil Cooler Hose Radiator to Cooler"
function buildShortLabel(product, criteria) {
  let t = product.title;
  t = t.replace(/\b(19|20)\d{2}\s*-\s*(19|20)?\d{2}\b/g, ' ');
  t = t.replace(/\b(19|20)\d{2}\b/g, ' ');
  const stripValues = [criteria.make, criteria.model, product.side, product.color, product.engine, product.option_package];
  for (const v of stripValues) {
    if (!v) continue;
    t = t.replace(new RegExp('\\b' + escapeRegex(String(v)) + '\\b', 'gi'), ' ');
  }
  // Multi-model listings ("F-250 F-350 F-450...") only get their ONE known
  // model stripped above — strip any other leftover model-code-shaped
  // tokens too, generically, rather than just the specific one we knew about.
  t = t.replace(/\bF-?\d{3}\b/gi, ' ');
  const noise = ['oem', 'genuine', 'new', 'used', 'driver', 'passenger', 'side', 'left', 'right', 'or', 'and'];
  for (const w of noise) {
    t = t.replace(new RegExp('\\b' + w + '\\b', 'gi'), ' ');
  }
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
  return t || product.title;
}

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

// ── On-demand single-product reindexing ──────────────────────────
// Called by the importer right after a new product is created, so it shows
// up in customer searches within seconds instead of waiting for the next
// full deploy (which is when buildIndex.js normally rebuilds the whole
// index from scratch).

let shopifyToken = null;
let shopifyTokenExpiry = 0;
async function getShopifyToken() {
  if (shopifyToken && Date.now() < shopifyTokenExpiry) return shopifyToken;
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error('Shopify auth failed: ' + (await res.text()));
  const data = await res.json();
  shopifyToken = data.access_token;
  shopifyTokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return shopifyToken;
}

async function fetchSingleProduct(productId) {
  const token = await getShopifyToken();
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: `query($id: ID!) {
        product(id: $id) {
          id
          handle
          title
          featuredImage { url }
          fitmentData: metafield(namespace: "fitment", key: "data") { value }
          variants(first: 5) { edges { node { id sku price } } }
        }
      }`,
      variables: { id: productId },
    }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(json.errors));
  return json.data.product;
}

// Same record shape as buildIndex.js's buildRecord() — kept in sync manually
// since this runs in a different process (the live server) than the batch
// index builder.
function buildIndexRecord(product) {
  if (!product.fitmentData || !product.fitmentData.value) return null;
  let fitment;
  try {
    fitment = JSON.parse(product.fitmentData.value);
  } catch (e) {
    return null;
  }
  const variant = product.variants.edges[0]?.node;
  if (!variant) return null;
  const variantIdMatch = variant.id.match(/(\d+)$/);
  const variantId = variantIdMatch ? variantIdMatch[1] : null;

  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    image: product.featuredImage?.url || null,
    sku: variant.sku,
    price: variant.price,
    variantId,
    year_start: fitment.year_start ?? null,
    year_end: fitment.year_end ?? (fitment.year_start ?? null),
    makes: (fitment.makes || []).map((m) => m.toLowerCase()),
    models: (fitment.models || []).map((m) => m.toLowerCase()),
    side: fitment.side || null,
    position: fitment.position || null,
    color: fitment.color || null,
    engine: fitment.engine || null,
    option_package: fitment.option_package || null,
    other_qualifiers: fitment.other_qualifiers || null,
  };
}

app.post('/api/admin/reindex-product', async (req, res) => {
  try {
    if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { productId } = req.body || {};
    if (!productId) return res.status(400).json({ error: 'productId is required' });

    const product = await fetchSingleProduct(productId);
    if (!product) return res.status(404).json({ error: 'Product not found in Shopify' });

    const record = buildIndexRecord(product);
    if (!record) {
      return res.json({ success: true, indexed: false, reason: 'No fitment data on this product — nothing to index.' });
    }
    upsertProduct(record);
    res.json({ success: true, indexed: true, productId, title: product.title });
  } catch (e) {
    console.error('Reindex error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
    const { year, make, model, side, position, color, engine, option_package, keyword } = req.body || {};
    let matches = getMatches(year ? Number(year) : null, make, model);
    matches = filterByQualifiers(matches, { side, position, color, engine, option_package });
    if (keyword) matches = filterByKeyword(matches, keyword);
    res.json({
      matchCount: matches.length,
      products: matches.slice(0, 20).map(trimForDisplay),
      qualifiers: getQualifierOptions(matches),
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
  "keyword": string or null,
  "keyword_corrected_from": string or null
}

Rules:
- Carry forward any already-known criteria unless the new message changes it.
- Only fill a field if it's actually stated or clearly implied (e.g. "my truck" doesn't imply a make).
- Normalize make/model to standard vehicle naming (e.g. "silverado" not "chevy truck").
- "keyword" is what PART the customer is asking about (e.g. "armrest", "door handle", "mirror",
  "tail light") — extract this whenever the message names or describes a part, even if it also
  contains vehicle info. Carry it forward from already-known criteria too, unless the new message
  is clearly asking about a different part.
- If the part name looks like a likely TYPO of a real, common automotive part term, correct it and
  put the corrected version in "keyword" — e.g. "bumper gap" is almost certainly "bumper cap",
  "brake pads" mistyped as "break pads" should become "brake pads". When you make this kind of
  correction, put the customer's ORIGINAL wording in "keyword_corrected_from"; otherwise leave
  "keyword_corrected_from" as null. Only correct genuine likely typos — never "correct" a word that
  could plausibly be a real, different part on its own.
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

    // Year is required before anything else — without it, "matches" spans
    // every model year at once, which for a lot of parts (like this one)
    // means genuinely different physical parts getting lumped together.
    if (!criteria.year) {
      return res.json({
        reply: `What year is your vehicle? I need that first to make sure I find the exact right part — styles and part numbers often change between model years.`,
        criteria,
        matchCount: null,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    // If we don't have at least a make or a model, don't attempt matching at
    // all — with no vehicle identified, "matches" would be a huge slice of
    // the whole catalog and the qualifier lists below would be meaningless.
    if (!criteria.make && !criteria.model) {
      return res.json({
        reply: `What make and model is your ${criteria.year}? That's the last piece I need.`,
        criteria,
        matchCount: null,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    let matches = getMatches(criteria.year, criteria.make, criteria.model);
    matches = filterByQualifiers(matches, criteria);
    matches = filterByKeyword(matches, criteria.keyword);

    // Surface any typo correction the AI made to the keyword, so the
    // customer sees it was auto-corrected rather than silently guessed —
    // or silently failing if the typo had been left uncorrected.
    const didYouMeanNote =
      criteria.keyword_corrected_from && criteria.keyword && criteria.keyword_corrected_from.toLowerCase() !== criteria.keyword.toLowerCase()
        ? `Did you mean "${criteria.keyword}"? `
        : '';

    // Guard rail: if the match set is still huge, the customer's vehicle
    // isn't actually narrowed down yet (e.g. make matched but not model) —
    // ask for more identifying info instead of computing/listing qualifiers
    // across a huge, mostly-unrelated set of products.
    const MAX_REASONABLE_MATCHES = 25;
    if (matches.length > MAX_REASONABLE_MATCHES) {
      return res.json({
        reply: didYouMeanNote + `That matches quite a few parts (${matches.length}) — can you tell me more specifically what part you're looking for, or narrow the model/trim?`,
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
        reply: didYouMeanNote + `A few different parts could match "${criteria.keyword || message}" — which one do you need?`,
        criteria,
        matchCount: matches.length,
        products: options.map((p) => ({ ...trimForDisplay(p), shortLabel: buildShortLabel(p, criteria) })),
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
    reply = didYouMeanNote + reply;

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
