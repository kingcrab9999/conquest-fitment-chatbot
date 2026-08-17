/**
 * server.js (fitment-chatbot)
 * BUILD MARKER: v2026-08-11-order-status-retry (if you see this comment in
 * the file on your Mac, the update landed correctly — check before pushing)
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
const fs = require('fs');
const path = require('path');
const {
  loadIndex,
  upsertProduct,
  isKnownPartType,
  isKnownMake,
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
} = require('./fitmentQuery');

const SEARCH_LOG_FILE = path.join(__dirname, 'search-log.jsonl');

// Appends one search event to the log — best-effort, never blocks or fails
// the actual search if logging has a problem.
function logSearch(entry) {
  try {
    fs.appendFileSync(SEARCH_LOG_FILE, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('Search log write failed:', e.message);
  }
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'parts1.myshopify.com';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const SHOPIFY_API_VERSION = '2025-01';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json({ limit: '10mb' }));
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
  // Multi-model listings ("F-250 F-350 F-450 Maverick...") only get their ONE
  // known model stripped above — strip every OTHER model this product is
  // tagged with too, using its own models list, so any brand/name works
  // generically rather than just F-code patterns.
  if (Array.isArray(product.models)) {
    for (const m of product.models) {
      if (!m) continue;
      t = t.replace(new RegExp('\\b' + escapeRegex(String(m)) + '\\b', 'gi'), ' ');
    }
  }
  t = t.replace(/\bF-?\d{3}\b/gi, ' '); // catch any leftover model-code-shaped tokens
  const noise = ['oem', 'genuine', 'new', 'used', 'driver', 'passenger', 'side', 'left', 'right', 'or', 'and'];
  for (const w of noise) {
    t = t.replace(new RegExp('\\b' + w + '\\b', 'gi'), ' ');
  }
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
  return t || product.title;
}

// Builds a clean display title scoped to what the customer actually
// searched for — e.g. "2021 Ford F-150 — Sliding Rear Window Switch" instead
// of the raw "2021-2025 Ford F-150 F-250 F-350 Maverick Sliding Rear Window
// Switch...". The part may genuinely fit all those vehicles (that's accurate
// and stays true on the product page), but a customer searching specifically
// for their F-150 shouldn't see other vehicles cluttering the result list.
function buildDisplayTitle(product, criteria) {
  const vehicleParts = [criteria?.year, criteria?.make, criteria?.model].filter(Boolean);
  if (vehicleParts.length === 0) return product.title;
  const cleanPart = buildShortLabel(product, criteria);
  return `${vehicleParts.join(' ')} — ${cleanPart}`;
}

// Common maintenance/commodity items available at any chain auto parts store
// (AutoZone, O'Reilly, etc.) — Conquest specializes in OEM specialty parts
// and doesn't carry these, so a zero-match search for one of these gets a
// different, more helpful explanation than a genuine catalog gap does.
const COMMON_MAINTENANCE_PARTS = [
  'air filter', 'cabin air filter', 'cabin filter', 'engine air filter',
  'fuel filter', 'oil filter',
  'motor oil', 'engine oil', 'oil', 'synthetic oil',
  'spark plug', 'spark plugs',
  'brake pad', 'brake pads', 'brake rotor', 'brake rotors', 'rotors',
  'alternator', 'starter', 'battery', 'car battery',
  'wiper blade', 'wiper blades', 'windshield wipers',
  'serpentine belt', 'timing belt', 'drive belt', 'fan belt',
  'coolant', 'antifreeze', 'transmission fluid', 'brake fluid', 'power steering fluid',
  'tire', 'tires',
  'headlight bulb', 'tail light bulb', 'light bulb', 'bulbs',
  'floor mats', 'air freshener',
];

// Uses exact phrase matching (not substring) — a longer, specific keyword
// like "seat belt buckle" should NOT match "belt" just because it contains
// that word; only a keyword that essentially IS one of these common items
// should trigger the chain-store explanation.
function isCommonMaintenancePart(keyword) {
  if (!keyword) return false;
  const k = keyword.toLowerCase().trim().replace(/\s+/g, ' ');
  return COMMON_MAINTENANCE_PARTS.includes(k);
}

function trimForDisplay(p, criteria) {
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    displayTitle: criteria ? buildDisplayTitle(p, criteria) : p.title,
    image: p.image,
    sku: p.sku,
    price: p.price,
    variantId: p.variantId,
    inStock: p.inventory == null ? null : p.inventory > 0,
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

// Looks up an order by number, but only ever returns it if the given email
// also matches the order's actual email — this is the same verification
// your own /pages/order-status page uses, and prevents someone from seeing
// another customer's order just by guessing a sequential order number.
async function lookupOrderStatus(orderNumber, email) {
  const token = await getShopifyToken();
  const cleanNumber = orderNumber.replace(/^#/, '').trim();
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({
      query: `query($q: String!) {
        orders(first: 3, query: $q) {
          edges {
            node {
              name
              email
              displayFulfillmentStatus
              displayFinancialStatus
              createdAt
              fulfillments(first: 5) {
                trackingInfo { number url company }
              }
            }
          }
        }
      }`,
      variables: { q: `name:${cleanNumber}` },
    }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('Shopify order lookup error: ' + JSON.stringify(json.errors));
  const orders = (json.data?.orders?.edges || []).map((e) => e.node);
  return orders.find((o) => o.email && o.email.toLowerCase() === email.toLowerCase().trim()) || null;
}

function formatOrderStatusReply(order) {
  const trackingLinks = [];
  for (const f of order.fulfillments || []) {
    for (const t of f.trackingInfo || []) {
      if (t.url) trackingLinks.push(`<a href="${t.url}">${(t.company || 'Track')} ${t.number || ''}</a>`.trim());
      else if (t.number) trackingLinks.push(`${t.company || ''} ${t.number}`.trim());
    }
  }
  const trackingText = trackingLinks.length ? ` Tracking: ${trackingLinks.join(', ')}.` : '';
  const statusMap = { FULFILLED: 'shipped', UNFULFILLED: 'not yet shipped', PARTIAL: 'partially shipped', RESTOCKED: 'restocked', IN_PROGRESS: 'being prepared for shipment' };
  const statusText = statusMap[order.displayFulfillmentStatus] || (order.displayFulfillmentStatus || '').toLowerCase() || 'being processed';
  return `Order ${order.name} is currently ${statusText}.${trackingText}`;
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
          variants(first: 5) { edges { node { id sku price inventoryQuantity } } }
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
    inventory: typeof variant.inventoryQuantity === 'number' ? variant.inventoryQuantity : null,
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

app.get('/api/admin/debug-index', (req, res) => {
  if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const index = loadIndex();
    const testSku = req.query.sku || '68020021AA';
    const found = findBySku(testSku);
    res.json({
      productCount: index.productCount,
      builtAt: index.builtAt,
      vocabularyCount: (index.vocabulary || []).length,
      testSku,
      testSkuFound: !!found,
      testSkuProductTitle: found ? found.title : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/search-log', (req, res) => {
  if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    if (!fs.existsSync(SEARCH_LOG_FILE)) return res.json({ entries: [] });
    const lines = fs.readFileSync(SEARCH_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const limit = Math.min(Number(req.query.limit) || 200, 2000);
    const entries = lines.slice(-limit).map((line) => JSON.parse(line)).reverse();
    res.json({ entries, total: lines.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    const { year, make, model, side, position, color, engine, option_package, keyword, sessionId } = req.body || {};
    let matches = getMatches(year ? Number(year) : null, make, model);
    matches = filterByQualifiers(matches, { side, position, color, engine, option_package });
    if (keyword) matches = filterByKeyword(matches, keyword);
    const displayCriteria = { year: year ? Number(year) : null, make, model };
    const matchReply =
      matches.length === 0
        ? 'No matches for this narrowing selection.'
        : matches.length === 1
        ? `Found it — this fits your vehicle. (${matches[0].title})`
        : `${matches.length} matching options shown.`;
    logSearch({ sessionId,
      message: null,
      criteria: { year, make, model, side, position, color, engine, option_package, keyword },
      outcome: matches.length === 0 ? 'no_match' : matches.length === 1 ? 'single_match' : 'multiple_matches',
      matchCount: matches.length,
      reply: matchReply,
      results: matches.slice(0, 20).map((p) => ({ title: p.title, sku: p.sku })),
      source: 'match_endpoint',
    });
    res.json({
      matchCount: matches.length,
      products: matches.slice(0, 20).map((p) => trimForDisplay(p, displayCriteria)),
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

// VINs are always exactly 17 characters, and never contain I, O, or Q
// (excluded by the standard to avoid confusion with 1/0). Looks for one
// anywhere in the message rather than requiring the whole message to be
// exactly a VIN — customers often prefix it ("VIN: ...") or add extra text.
// Recognizes text that's SHAPED like a part number (a single alphanumeric
// token, optionally with dashes, with at least one digit) even when it's
// not one we actually carry — this is what lets us say "we don't carry
// Fixed-answer FAQ patterns — these get the exact same wording every time,
// checked before intent classification so they can never get misread as a
// continuation of a part search using stale leftover context (which is
// what caused "does it include hardware" to trigger a confusing "no match"
// response using an old vehicle from earlier in the conversation).
const FAQ_PATTERNS = [
  {
    match: /\b(include|comes? with|included) hardware\b|\bhardware included\b/i,
    reply: `Our parts don't include mounting hardware (bolts, clips, fasteners, etc.) — you'll need to source that locally.`,
  },
  {
    match: /\bhow (do|can) (i |you )?install\b|\binstallation instructions?\b|\bhow to install\b|\binstall(ation)? guide\b/i,
    reply: `Our parts don't come with instructions — they're designed to be installed by a dealership technician or an ASE-certified shop. We'd recommend contacting a local dealership or ASE-certified shop for installation help.`,
  },
  {
    match: /\bhow many (are|is|do i get) included\b|\bquantity included\b|\bsold (as a pair|in pairs)\b|\bcomes? (as|in) a pair\b/i,
    reply: `Unless the listing specifically says otherwise, this is sold individually — quantity of one. Parts are very rarely sold in pairs or multiples.`,
  },
  {
    match: /\bexpedited shipping\b|\bexpress shipping\b|\bovernight shipping\b|\brush (my )?(order|shipping)\b|\bfaster shipping\b|\bhow (fast|soon|quickly) (can i get|will i (get|receive)|will it (arrive|ship))\b/i,
    reply: `We only offer standard ground shipping — we don't offer expedited or express shipping, in order to keep prices low. For an actual delivery estimate, check the shipping info at checkout.`,
  },
  {
    match: /\bin stock\b|\bstock status\b|\bstock availability\b|\bis (it|this|that) available\b|\bdo you have (it|this|these) available\b/i,
    reply: `This part is sourced directly from the manufacturer. While it's currently showing as in stock, OEM inventory data can lag behind by a few hours — so there's a small chance it could go on backorder after your order is placed. For the most accurate, up-to-date availability, feel free to <a href="/pages/contact-us">contact us</a> before ordering — we can confirm it's not backordered and give you an accurate shipping estimate.`,
  },
];

function matchFaq(text) {
  for (const faq of FAQ_PATTERNS) {
    if (faq.match.test(text)) return faq.reply;
  }
  return null;
}

// Common phrasings for "let me see your whole catalog at once" — the kind
// of request that's rarely a genuine customer need and much more often a
// scraper or competitor trying to pull product data in bulk.
const BULK_BROWSE_PATTERNS = [
  /\bshow me everything\b/i,
  /\ball (of )?your products\b/i,
  /\ball(?: your| the)? products\b/i,
  /\bentire (catalog|inventory|stock)\b/i,
  /\b(full|whole) (catalog|inventory)\b/i,
  /\bbest[\s-]?sell(er|ers|ing)\b/i,
  /\bmost popular\b/i,
  /\btop sell(er|ers|ing)\b/i,
  /\blist (all|everything)\b/i,
  /\beverything you (have|carry|sell|stock)\b/i,
  /\bwhat (all )?do you (have|carry|sell|stock)\b/i,
  /\byour (whole|entire) selection\b/i,
];

function looksLikeBulkBrowseRequest(text) {
  return BULK_BROWSE_PATTERNS.some((re) => re.test(text));
}

// that part number" directly instead of treating it as a vehicle/keyword
// search and asking for a year.
function tokenLooksLikePartNumber(token) {
  const stripped = token.replace(/-/g, '');
  if (!/^[A-Za-z0-9]+$/.test(stripped)) return false;
  if (stripped.length < 5 || stripped.length > 17) return false;
  if (!/\d/.test(stripped)) return false; // part numbers always contain digits
  // Only exclude a year-like prefix if letters follow it — that's the real
  // "mashed year+model" pattern (e.g. "2023f150"). A purely numeric code
  // starting with 19/20 is very plausibly a real GM-style part number and
  // shouldn't be excluded just because of how it starts.
  if (/^(19|20)\d{2}/.test(stripped) && /[A-Za-z]/.test(stripped.slice(4))) return false;
  return true;
}

// Scans every word in the message for one shaped like a part number, not
// just the case where the whole message is a bare part number — catches
// "84127262 lower panel cover" the same way we already catch a real SKU
// embedded in a longer description.
function findPartNumberShapedToken(message) {
  const tokens = message.split(/\s+/).filter(Boolean);
  const sorted = [...tokens].sort((a, b) => b.length - a.length);
  for (const token of sorted) {
    if (tokenLooksLikePartNumber(token)) return token;
  }
  return null;
}

function extractVin(text) {
  const cleaned = text.replace(/\bvin\b[:#]?\s*/i, '');
  const match = cleaned.match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
  return match ? match[0] : null;
}

// NHTSA's public VIN decoder — free, no API key required. Returns the
// factory-exact year/make/model/engine, which resolves a lot of ambiguity
// in one shot compared to asking the customer to pick each field manually.
async function decodeVin(vin) {
  const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`);
  if (!res.ok) throw new Error(`VIN decode failed: ${res.status}`);
  const data = await res.json();
  const r = data.Results?.[0];
  if (!r || !r.Make) return null;

  const engineParts = [r.DisplacementL && `${parseFloat(r.DisplacementL).toFixed(1)}L`, r.EngineCylinders && `${r.EngineCylinders}-cyl`, r.FuelTypePrimary]
    .filter(Boolean);

  return {
    year: r.ModelYear ? Number(r.ModelYear) : null,
    make: r.Make,
    model: r.Model,
    engine: engineParts.length ? engineParts.join(' ') : null,
  };
}

const PARSE_SYSTEM_PROMPT = `You extract vehicle fitment search criteria from a customer's message about an auto part, for Conquest Auto Parts, an OEM specialty auto parts retailer (not a chain store — they carry specialized OEM/dealer parts, not common maintenance items).

KNOWN FACTS you can use in conversational replies (never state facts beyond these — for anything else, point to Contact Us):
- Family-owned, founded 2006, based in the Houston/League City, TX area. 20+ years in business, 500,000+ orders shipped, 4.9-star Google rating.
- Specializes exclusively in Genuine OEM parts — no aftermarket, no knockoffs, no counterfeits.
- Returns: 30 days from receipt for a full refund of the part's price (original shipping not refunded). No need to contact them first. Requires the original manufacturer packaging with the part number label still intact/attached — installed, painted, damaged, or repackaged parts, or parts missing that label, cannot be returned. Ship returns via UPS or FedEx (not USPS) with tracking to: Conquest Auto Parts, 1320 HWY 3 South, Suite C4, League City, TX 77573. Refunds process ~1 business day after inspection; funds typically appear in 3-5 business days after that (bank may take up to 7 more days).
- Order status/tracking: can be checked right here in chat (see order_status intent below), or at /pages/order-status, using the order number and the email used at checkout.
- Contact: /pages/contact-us, or text/call 281-742-9651.
- Hardware: parts do NOT include mounting hardware (bolts, clips, fasteners) — customers need to source that locally.
- Installation: parts do not come with instructions and are intended for professional installation by a dealership technician or ASE-certified shop — recommend contacting a local dealership or ASE-certified shop for installation help.
- Quantity: unless a listing explicitly says otherwise, every part is sold individually (quantity of one) — parts are very rarely sold in pairs or multiples.
- Shipping: standard ground shipping only — no expedited/express/overnight shipping is offered, in order to keep prices low. For an actual delivery estimate, direct them to checkout or the shipping info on the product page — never state a specific delivery date you don't actually know.

Given their message and any already-known criteria, output ONLY a JSON object (no markdown, no preamble):

{
  "intent": "part_search" | "conversation" | "order_status" | "bulk_request",
  "conversational_reply": string or null,
  "order_number": string or null,
  "order_email": string or null,
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
- "intent": "bulk_request" for anything asking to browse/see the whole catalog, all products, best
  sellers, most popular items, or similar broad requests with no specific vehicle or part in mind —
  this tool is for finding a specific part, not bulk browsing. "order_status" for anything about
  checking an order's status, tracking a shipment, or "where is my order" — extract "order_number"
  (digits, with or without a # — normalize to just the digits) and "order_email" if given in the
  message. "conversation" for greetings, thanks, small talk,
  or general questions using the KNOWN FACTS above (or politely deflecting to Contact Us if it's not
  covered by those facts). "part_search" for anything about finding, describing, or asking whether a
  part fits — including a bare vehicle description or part name with no other context, since that's
  almost always the start of a part search.
- When intent is "conversation": write a brief, warm, natural reply (1-3 sentences) in
  "conversational_reply", using the KNOWN FACTS above where relevant. Never invent specific facts,
  prices, or policies beyond what's listed there — for anything else, suggest Contact Us. Leave all
  other fields null.
- When intent is "order_status": leave "conversational_reply" null. Carry forward order_number/
  order_email from already-known criteria if the customer already gave them in an earlier message.
- When intent is "part_search": leave "conversational_reply", "order_number", and "order_email" null,
  and extract the other fields normally.
- Carry forward any already-known criteria unless the new message changes it.
- Only fill a field if it's actually stated or clearly implied (e.g. "my truck" doesn't imply a make).
- Normalize make/model to standard vehicle naming (e.g. "silverado" not "chevy truck").
- "keyword" is what PART the customer is asking about (e.g. "armrest", "door handle", "mirror",
  "tail light") — extract this whenever the message names or describes a part, even if it also
  contains vehicle info. Carry it forward from already-known criteria too, unless the new message
  is clearly asking about a different part.
- Normalize common slang/casual terms to the standard part name customers' listings would actually
  use — e.g. "blinker" -> "turn signal", "check engine light sensor" -> "oxygen sensor", "AC
  compressor" stays as-is (already standard), "gas cap" -> "fuel cap" only if that's clearly meant.
  Use your general automotive knowledge for this; don't force a mapping if the casual term is
  already a real, searchable part name on its own.
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

// ── Photo search ─────────────────────────────────────────────────
// Takes a photo of a physical part, reads any visible part number, and/or
// describes the part in plain text — that text then gets run through the
// exact same search pipeline as if the customer had typed it, so all the
// existing matching/narrowing logic applies without duplicating any of it.

const VISION_SYSTEM_PROMPT = `You are looking at a photo of an automotive part for an OEM auto parts search. Identify:
1. Any visible manufacturer part number printed, stamped, or labeled directly on the part (not a
   barcode you can't actually read — just legible alphanumeric text that looks like a part number).
   If nothing is clearly legible, use null.
2. A short, plain-English description of the part suitable for a text search — the part TYPE (e.g.
   "door handle", "tail light", "mirror", "window switch") plus distinguishing features like color,
   material, connector shape, or side if visible.

Output ONLY a JSON object:
{
  "part_number": string or null,
  "description": string
}

Respond with the JSON object only.`;

async function analyzeProductImage(base64Image, mimeType) {
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
      system: VISION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
            { type: 'text', text: 'Identify this automotive part.' },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Vision API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.content.find((b) => b.type === 'text')?.text || '';
  const cleaned = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    part_number: parsed.part_number || null,
    description: parsed.description || '',
    searchText: parsed.part_number || parsed.description || '',
  };
}

app.post('/api/vision-search', async (req, res) => {
  try {
    const { image, mimeType, sessionId } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image is required' });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Photo search is not configured (missing ANTHROPIC_API_KEY)' });
    const result = await analyzeProductImage(image, mimeType || 'image/jpeg');
    logSearch({ sessionId, message: `[photo] ${result.searchText}`, criteria: {}, outcome: 'photo_analyzed', matchCount: null, reply: `Analyzed photo: ${result.part_number ? `part number "${result.part_number}"` : `"${result.description}"`}` });
    res.json(result);
  } catch (e) {
    console.error('Vision search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, context, sessionId } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Chat is not configured (missing ANTHROPIC_API_KEY)' });

    // Fixed-answer policy questions (hardware, installation, quantity,
    // shipping speed) — checked first and answered with exact, consistent
    // wording, before anything tries to treat this as a new part search.
    const faqReply = matchFaq(message);
    if (faqReply) {
      logSearch({ sessionId, message, criteria: context || {}, outcome: 'faq_answered', matchCount: null, reply: faqReply });
      return res.json({
        reply: faqReply,
        criteria: context || {},
        matchCount: null,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    // Block obvious bulk-catalog-browsing requests immediately — this tool
    // is meant to help find a specific part, not act as a scraping vector
    // for someone trying to pull the whole catalog or product data en masse.
    if (looksLikeBulkBrowseRequest(message)) {
      const bulkReply = `I'm built to help you find a specific part for your vehicle, not browse everything at once — head to our <a href="/collections/all">shop page</a> to browse the full catalog directly.`;
      logSearch({ sessionId, message, criteria: {}, outcome: 'bulk_browse_blocked', matchCount: null, reply: bulkReply });
      return res.json({
        reply: bulkReply,
        criteria: {},
        matchCount: null,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    // Fast-path: if this looks like a part number/SKU, skip the AI entirely —
    // a SKU already uniquely identifies the exact part, no vehicle needed.
    const skuMatch = findBySku(message);
    if (skuMatch) {
      logSearch({ sessionId, message, criteria: {}, outcome: 'sku_direct_match', matchCount: 1, reply: `Found it — part number ${skuMatch.sku}.`, results: [{ title: skuMatch.title, sku: skuMatch.sku }] });
      return res.json({
        reply: `Found it — part number ${skuMatch.sku}.`,
        criteria: {},
        matchCount: 1,
        products: [trimForDisplay(skuMatch, {})],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    // Not a bare SKU, but might have one embedded in a longer description
    // ("...Trim Panel OEM 6BM40TX7AC") — check that before assuming this is
    // a normal vehicle/keyword search.
    const embeddedSkuMatch = findEmbeddedSku(message);
    if (embeddedSkuMatch) {
      logSearch({ sessionId, message, criteria: {}, outcome: 'sku_direct_match', matchCount: 1, reply: `Found it — part number ${embeddedSkuMatch.sku}.`, results: [{ title: embeddedSkuMatch.title, sku: embeddedSkuMatch.sku }] });
      return res.json({
        reply: `Found it — part number ${embeddedSkuMatch.sku}.`,
        criteria: {},
        matchCount: 1,
        products: [trimForDisplay(embeddedSkuMatch, {})],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    // VIN check runs BEFORE the generic part-number check — a VIN is a more
    // specific, exact match (17 chars, particular letter exclusions) and
    // should never be misread as "an OEM part number we don't carry."
    let criteria = null;
    const vinCandidate = extractVin(message);
    if (vinCandidate) {
      try {
        const decoded = await decodeVin(vinCandidate);
        if (decoded && decoded.make && decoded.model) {
          criteria = { ...context, ...decoded };
          // Confirm what the VIN actually decoded to — without this, a VIN
          // with no part mentioned yet falls straight into "that matches
          // quite a few parts," which never tells the customer their VIN
          // was even understood, let alone what vehicle it resolved to.
          if (!criteria.keyword) {
            const vinReply = `Got it — your VIN is a ${decoded.year} ${decoded.make} ${decoded.model}${decoded.engine ? ` (${decoded.engine})` : ''}. How can I help you find parts for it?`;
            logSearch({ sessionId, message, criteria, outcome: 'vin_decoded', matchCount: null, reply: vinReply });
            return res.json({
              reply: vinReply,
              criteria,
              matchCount: null,
              products: [],
              qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
            });
          }
        } else {
          const vinFailReply = `I couldn't decode that VIN — could you double-check it, or just tell me your year, make, and model instead?`;
          logSearch({ sessionId, message, criteria: {}, outcome: 'vin_decode_failed', matchCount: null, reply: vinFailReply });
          return res.json({
            reply: vinFailReply,
            criteria: context || {},
            matchCount: null,
            products: [],
            qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
          });
        }
      } catch (e) {
        console.error('VIN decode failed:', e.message);
        const vinErrReply = `I had trouble decoding that VIN — could you double-check it, or just tell me your year, make, and model instead?`;
        logSearch({ sessionId, message, criteria: {}, outcome: 'vin_decode_error', matchCount: null, reply: vinErrReply });
        return res.json({
          reply: vinErrReply,
          criteria: context || {},
          matchCount: null,
          products: [],
          qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
        });
      }
    }

    // Not in our catalog — but if a word in the message is SHAPED like a
    // part number (not a sentence, vehicle description, or VIN) — say so
    // directly instead of falling through to the normal vehicle-info flow,
    // which would just confuse a customer who already gave the one exact
    // identifier that matters, even if it's embedded in more text.
    const shapedPartNumber = criteria ? null : findPartNumberShapedToken(message);
    if (shapedPartNumber) {
      const partNumReply = `We don't currently carry part number "${shapedPartNumber}" — sorry about that! We may add it in the future if there's enough demand. Feel free to <a href="/pages/contact-us">contact us</a> if you'd like us to look into sourcing it.`;
      logSearch({ sessionId, message, criteria: {}, outcome: 'part_number_not_carried', matchCount: 0, reply: partNumReply });
      return res.json({
        reply: partNumReply,
        criteria: {},
        matchCount: 0,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    if (!criteria) {
      criteria = await parseCriteriaFromMessage(message, context);
    }

    if (criteria.intent === 'bulk_request') {
      const bulkReply2 = `I'm built to help you find a specific part for your vehicle, not browse everything at once — head to our <a href="/collections/all">shop page</a> to browse the full catalog directly.`;
      logSearch({ sessionId, message, criteria: {}, outcome: 'bulk_browse_blocked', matchCount: null, reply: bulkReply2 });
      return res.json({
        reply: bulkReply2,
        criteria: {},
        matchCount: null,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    // Small talk, greetings, thanks, general questions — respond naturally
    // instead of forcing the vehicle-search flow. Keeps whatever vehicle/
    // part context was already established, in case they follow up with an
    // actual search right after.
    if (criteria.intent === 'conversation') {
      const convReply = criteria.conversational_reply || "Happy to help! Tell me your vehicle and what part you're looking for, and I'll find it.";
      logSearch({ sessionId, message, criteria, outcome: 'conversation', matchCount: null, reply: convReply });
      return res.json({
        reply: convReply,
        criteria: context || {},
        matchCount: null,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    if (criteria.intent === 'order_status') {
      const orderReply = `For your order status and tracking, please visit our <a href="/pages/order-status">Order Status page</a> — that's the fastest way to get your live tracking info.`;
      logSearch({ sessionId, message, criteria: { intent: 'order_status' }, outcome: 'order_status_redirect', matchCount: null, reply: orderReply });
      return res.json({
        reply: orderReply,
        criteria: {},
        matchCount: null,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    // A customer asking for two different parts in one message ("battery
    // tray AND battery hold down clamp") will never match a single product
    // — searching for one part at a time and saying so beats a repeated,
    // confusing "no match" with no explanation.
    let compoundNote = '';
    if (criteria.keyword) {
      const parts = criteria.keyword.split(/\s+(?:and|&)\s+/i);
      if (parts.length > 1) {
        const primary = parts[0].trim();
        const extra = parts.slice(1).join(' and ').trim();
        criteria.keyword = primary;
        compoundNote = `I can only search one part at a time — let's find "${primary}" first, then just ask me about "${extra}" separately. `;
      }
    }

    // Year is required before anything else — without it, "matches" spans
    // every model year at once, which for a lot of parts (like this one)
    // means genuinely different physical parts getting lumped together.
    if (!criteria.year) {
      const yearReply = `What year is your vehicle? I need that first to make sure I find the exact right part — styles and part numbers often change between model years.`;
      logSearch({ sessionId, message, criteria, outcome: 'asked_for_year', matchCount: null, reply: yearReply });
      return res.json({
        reply: yearReply,
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
      const makeModelReply = `What make and model is your ${criteria.year}? That's the last piece I need.`;
      logSearch({ sessionId, message, criteria, outcome: 'asked_for_make_model', matchCount: null, reply: makeModelReply });
      return res.json({
        reply: makeModelReply,
        criteria,
        matchCount: null,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    // Make alone isn't enough — "Honda" spans dozens of different models,
    // and a part number that looks right for one model can be completely
    // wrong for another. Model is required before any matching runs.
    if (!criteria.model) {
      const modelReply = `Which ${criteria.make} model is it? Parts often differ between models even within the same brand.`;
      logSearch({ sessionId, message, criteria, outcome: 'asked_for_model', matchCount: null, reply: modelReply });
      return res.json({
        reply: modelReply,
        criteria,
        matchCount: null,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    // Check this decisively, before any matching runs — a fuzzy/loose match
    // on some unrelated product (e.g. a "brake CLUTCH PEDAL pad" technically
    // containing both words) shouldn't be able to mask this message. If the
    // customer is asking for a common maintenance item, that's the answer
    // regardless of what a keyword search might loosely turn up.
    if (isCommonMaintenancePart(criteria.keyword)) {
      const commonReply = `We specialize in OEM specialty parts, not common maintenance items — for "${criteria.keyword}" you'll want a local chain auto parts store like AutoZone or O'Reilly's. Happy to help you find something more specialized though!`;
      logSearch({ sessionId, message, criteria, outcome: 'common_maintenance_item', matchCount: 0, reply: commonReply });
      return res.json({
        reply: commonReply,
        criteria,
        matchCount: 0,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    if (!isKnownMake(criteria.make)) {
      const unsupportedReply = `We specialize in OEM parts for cars, trucks, and SUVs — we don't believe we carry parts for ${criteria.make}. Feel free to <a href="/pages/contact-us">contact us</a> to double check!`;
      logSearch({ sessionId, message, criteria, outcome: 'unsupported_make', matchCount: 0, reply: unsupportedReply });
      return res.json({
        reply: unsupportedReply,
        criteria,
        matchCount: 0,
        products: [],
        qualifiers: { side: [], position: [], color: [], engine: [], option_package: [] },
      });
    }

    let matches = getMatches(criteria.year, criteria.make, criteria.model);
    matches = filterByQualifiers(matches, criteria);
    matches = filterByKeyword(matches, criteria.keyword);

    // If the strict search (including engine/trim/color/etc.) found nothing,
    // try again with just year/make/model/keyword — a customer giving extra
    // detail (like a trim level or engine that doesn't map cleanly to any
    // stored qualifier) shouldn't turn a real, findable part into a flat
    // "no match." If the broader search finds something, show it with an
    // honest disclaimer instead of pretending nothing exists.
    let uncertainFallback = false;
    if (matches.length === 0) {
      const broaderMatches = filterByKeyword(getMatches(criteria.year, criteria.make, criteria.model), criteria.keyword);
      if (broaderMatches.length > 0) {
        matches = broaderMatches;
        uncertainFallback = true;
      }
    }

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
      const tooManyReply = compoundNote + didYouMeanNote + `That matches quite a few parts (${matches.length}) — can you tell me more specifically what part you're looking for? Or, if you'd like to browse all available parts for your vehicle, you can select your year, make, and model below, and it'll display everything we have for it.`;
      logSearch({ sessionId, message, criteria, outcome: 'too_many_matches', matchCount: matches.length, reply: tooManyReply });
      return res.json({
        reply: tooManyReply,
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
      const typeSelectReply = compoundNote + didYouMeanNote + `A few different parts could match "${criteria.keyword || message}" — which one do you need?`;
      logSearch({ sessionId,
        message,
        criteria,
        outcome: 'needs_type_selection',
        matchCount: matches.length,
        reply: typeSelectReply,
        options: options.map((p) => p.title),
      });
      return res.json({
        reply: typeSelectReply,
        criteria,
        matchCount: matches.length,
        products: options.map((p) => ({ ...trimForDisplay(p, criteria), shortLabel: buildShortLabel(p, criteria) })),
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

    const fallbackDisclaimer = uncertainFallback
      ? `I couldn't find an exact match including all those details — but these could possibly fit your ${criteria.year} ${criteria.make} ${criteria.model}. The specific trim/engine/option details you mentioned aren't confirmed to match, so please double-check before ordering. `
      : '';

    let reply;
    if (matches.length === 0) {
      if (!isKnownPartType(criteria.keyword)) {
        const suggestions = suggestVocabularyTerms(criteria.keyword);
        const suggestionText = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '';
        reply = `We don't currently carry "${criteria.keyword}" — sorry about that!${suggestionText} Feel free to <a href="/pages/contact-us">contact us</a> if you'd like us to try to source it, or check back later as our inventory grows.`;
      } else {
        reply = `We don't currently have this part for your ${criteria.year} ${criteria.make} ${criteria.model} — sorry about that! We may add it to the catalog in the future if there's enough demand.`;
      }
    } else if (stillAmbiguous) {
      const asks = [];
      if (qualifiers.side.length > 1) asks.push(`which side (${formatList(qualifiers.side)})`);
      if (qualifiers.engine.length > 1) asks.push(`which engine (${formatList(qualifiers.engine)})`);
      if (qualifiers.color.length > 1) asks.push(`which color (${formatList(qualifiers.color)})`);
      if (qualifiers.option_package.length > 1) asks.push(`whether you have ${formatList(qualifiers.option_package)}`);
      reply = `I found a few options for that vehicle — I just need to know ${asks.join(', and ')}.`;
    } else if (matches.length === 1) {
      reply = uncertainFallback ? `This might fit your vehicle — please double-check before ordering.` : `Found it — this fits your vehicle.`;
    } else {
      reply = `Found ${matches.length} matching options for your vehicle.`;
    }
    reply = fallbackDisclaimer + compoundNote + didYouMeanNote + reply;

    logSearch({ sessionId,
      message,
      criteria,
      outcome: matches.length === 0 ? 'no_match' : matches.length === 1 ? 'single_match' : 'multiple_matches',
      matchCount: matches.length,
      reply,
      results: matches.slice(0, 20).map((p) => ({ title: p.title, sku: p.sku })),
    });

    res.json({
      reply,
      criteria,
      matchCount: matches.length,
      products: matches.slice(0, 20).map((p) => ({ ...trimForDisplay(p, criteria), uncertain: uncertainFallback })),
      qualifiers,
      uncertainMatch: uncertainFallback,
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
