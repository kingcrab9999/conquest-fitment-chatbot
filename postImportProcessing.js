/**
 * postImportProcessing.js
 *
 * Combines two projects into a single call you make right after your
 * importer creates a new product:
 *
 *   1. Fitment extraction (AI) — reads title/tags/description, writes
 *      structured fitment.data metafield (year/make/model/side/engine/
 *      color/option package). Same logic as extractFitment.js.
 *
 *   2. Metafield optimization (rule-based, NO AI call) — category
 *      metafields, Google Shopping variant fields, date added, SEO
 *      title/description. Same logic as metafield-optimizer.js.
 *
 * USAGE — add this near the top of server.js / bulk.js:
 *
 *   const { processNewProduct } = require('./postImportProcessing');
 *
 * Then right after a product is successfully created and you have its
 * GID (e.g. from the productCreate/create-product response):
 *
 *   const result = await processNewProduct(newProduct.id);
 *   console.log(`Post-import processing: ${result.summary}`);
 *
 * That's the only integration point needed — this file handles its own
 * Shopify auth, its own Anthropic call, and writes everything in one
 * batched metafieldsSet + one productUpdate for SEO.
 *
 * Requires in .env (all of which you already have):
 *   SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, ANTHROPIC_API_KEY
 *   SHOPIFY_STORE (optional, defaults to parts1.myshopify.com)
 */

require('dotenv').config();

const SHOP = process.env.SHOPIFY_STORE || 'parts1.myshopify.com';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const API_VERSION = '2025-01';

// ── Shopify auth (shared, cached) ──────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error('Shopify token fetch failed: ' + (await res.text()));
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const token = await getAccessToken();
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(json.errors));
  return json.data;
}

// ── PART A: Fitment extraction (AI) ────────────────────────────────

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const EXTRACTION_SYSTEM_PROMPT = `You extract structured vehicle fitment data from OEM auto parts listings.
Given a product title, tags, and description, output ONLY a JSON object (no markdown, no preamble) with these fields:

{
  "year_start": number or null,
  "year_end": number or null,
  "makes": [string],
  "models": [string],
  "side": "driver" | "passenger" | "both" | null,
  "position": "front" | "rear" | "upper" | "lower" | null,
  "color": string or null,
  "engine": string or null,
  "option_package": string or null,
  "other_qualifiers": string or null
}

Rules:
- Only include a field if the source text actually states it. Never guess or infer beyond what's written.
- "side" only if the part is explicitly side-specific (driver/passenger/left/right).
- "position" only if the part is explicitly front/rear/upper/lower-specific — this is REQUIRED whenever the
  source text states it, even alongside "side". A "front left door" part must have BOTH side="driver" AND
  position="front" — never drop position just because side is also present. If a vehicle has separate
  front and rear parts for the same side, omitting position would let a customer confirm the wrong one.
- "engine" only if a specific engine size/type is required for fitment (e.g. "1.4L Turbo", "6.2L").
- "option_package" for things like tow package, power windows, folding mirrors — features the vehicle must already have.
- "other_qualifiers" for anything else fitment-relevant that doesn't fit the above (trim level, generation code, cab style, etc.) — keep it short.
- makes/models should be the actual vehicle names (e.g. "Silverado", not "Chevrolet Silverado 1500 LT").
- Respond with the JSON object only.`;

async function extractFitment(title, tags, descriptionHtml) {
  const description = stripHtml(descriptionHtml).slice(0, 2000);
  const userContent = `Title: ${title}\nTags: ${(tags || []).join(', ')}\nDescription: ${description}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.content.find((b) => b.type === 'text')?.text || '';
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// ── PART B: Metafield optimization (rule-based, no AI) ─────────────
// Same rules as metafield-optimizer.js:
//   fit-type -> Direct, item-condition -> New, manufacturer-type -> OEM (always)
//   color-pattern/material/item-material -> only if confident title match
//   motor-vehicle-type/vehicle-type -> via model->segment table
//   dated_added_ -> today, only if blank
//   Google Shopping variant fields (mpn/condition/age_group/gender)
//   SEO title/description -> rule-based cleanup of existing title only

const FIT_TYPE_DIRECT = 'gid://shopify/Metaobject/89288016159';
const ITEM_CONDITION_NEW = 'gid://shopify/Metaobject/89271271711';
const MANUFACTURER_TYPE_OEM = 'gid://shopify/Metaobject/89271304479';
// Matches the category already present on the existing catalog (verified against
// live products). Required before Shopify will accept the "shopify" namespace
// taxonomy-linked metafields (fit-type, item-condition, manufacturer-type,
// color-pattern, material, item-material, motor-vehicle-type, vehicle-type) —
// those fail with "Owner subtype does not match" on any product with no category set.
const PRODUCT_CATEGORY_MOTOR_VEHICLE_PARTS = 'gid://shopify/TaxonomyCategory/vp-1-4';

const HARDCODED_METAOBJECTS = {
  'color-pattern': {
    black: 'gid://shopify/Metaobject/89271042335',
    red: 'gid://shopify/Metaobject/89287983391',
    silver: 'gid://shopify/Metaobject/89292112159',
    gray: 'gid://shopify/Metaobject/89368461599',
    clear: 'gid://shopify/Metaobject/89369575711',
    white: 'gid://shopify/Metaobject/89369805087',
    orange: 'gid://shopify/Metaobject/89372360991',
    brown: 'gid://shopify/Metaobject/89566085407',
    green: 'gid://shopify/Metaobject/89566150943',
    pink: 'gid://shopify/Metaobject/90021396767',
    blue: 'gid://shopify/Metaobject/90285867295',
    yellow: 'gid://shopify/Metaobject/95894765855',
    multicolor: 'gid://shopify/Metaobject/97371390239',
    beige: 'gid://shopify/Metaobject/98365669663',
    geometric: 'gid://shopify/Metaobject/98825994527',
    bronze: 'gid://shopify/Metaobject/102309036319',
    gold: 'gid://shopify/Metaobject/103247675679',
    purple: 'gid://shopify/Metaobject/113677009183',
    striped: 'gid://shopify/Metaobject/160961134879',
    checkered: 'gid://shopify/Metaobject/161048822047',
  },
  material: {
    plastic: 'gid://shopify/Metaobject/90191757599',
    'stainless steel': 'gid://shopify/Metaobject/101904285983',
    metal: 'gid://shopify/Metaobject/103468138783',
    rubber: 'gid://shopify/Metaobject/118390259999',
  },
  'item-material': {
    plastic: 'gid://shopify/Metaobject/89273172255',
    metal: 'gid://shopify/Metaobject/89274974495',
    chrome: 'gid://shopify/Metaobject/89291817247',
    rubber: 'gid://shopify/Metaobject/89460736287',
    other: 'gid://shopify/Metaobject/97033847071',
    vinyl: 'gid://shopify/Metaobject/99191750943',
    glass: 'gid://shopify/Metaobject/100208148767',
    wood: 'gid://shopify/Metaobject/100994580767',
    leather: 'gid://shopify/Metaobject/101185421599',
    aluminum: 'gid://shopify/Metaobject/102411993375',
    'carbon fiber': 'gid://shopify/Metaobject/137355067679',
    'polyvinyl chloride (pvc)': 'gid://shopify/Metaobject/139029283103',
    'acrylonitrile butadiene styrene (abs)': 'gid://shopify/Metaobject/139215896863',
    synthetic: 'gid://shopify/Metaobject/169847521567',
  },
  'motor-vehicle-type': {
    van: 'gid://shopify/Metaobject/89273139487',
    suv: 'gid://shopify/Metaobject/89291784479',
    car: 'gid://shopify/Metaobject/89575948575',
    truck: 'gid://shopify/Metaobject/90278199583',
  },
  'vehicle-type': {
    car: 'gid://shopify/Metaobject/89271009567',
    suv: 'gid://shopify/Metaobject/89274515743',
    truck: 'gid://shopify/Metaobject/89274581279',
    van: 'gid://shopify/Metaobject/89289163039',
    other: 'gid://shopify/Metaobject/224155304223',
  },
};

const DYNAMIC_CATEGORY_FIELDS = [
  { key: 'color-pattern', type: 'shopify--color-pattern' },
  { key: 'material', type: 'shopify--material' },
  { key: 'item-material', type: 'shopify--item-material' },
];

const MODEL_VEHICLE_TYPE_MAP = {
  Truck: [
    'F-150', 'F-250', 'F-350', 'F-450', 'Ranger', 'Maverick',
    'Ram 1500', 'Ram 2500', 'Ram 3500', 'Ram 4500',
    'Silverado', 'Sierra', 'Colorado', 'Canyon',
    'Tundra', 'Tacoma', 'Ridgeline', 'Frontier', 'Titan', 'Gladiator',
  ],
  SUV: [
    'Tahoe', 'Yukon', 'Suburban', 'Escalade', 'Trailblazer', 'Blazer', 'Equinox', 'Traverse',
    'Explorer', 'Expedition', 'Bronco Sport', 'Bronco', 'Edge', 'Escape',
    'Grand Cherokee', 'Cherokee', 'Renegade', 'Compass', 'Wrangler', 'Wagoneer', 'Durango', 'Journey',
    'MDX', 'RDX', 'CR-V', 'HR-V', 'Pilot', 'Passport',
    '4Runner', 'RAV4', 'Highlander', 'Land Cruiser', 'Sequoia',
    'CX-5', 'CX-9', 'CX-30', 'CX-50',
    'Rogue', 'Murano', 'Pathfinder', 'Armada', 'Kicks',
    'Outlander', 'Sportage', 'Sorento', 'Telluride', 'Palisade', 'Santa Fe', 'Tucson',
    'Q5', 'Q7', 'X3', 'X5', 'GLC', 'GLE', 'Atlas', 'Tiguan',
  ],
  Van: [
    'Grand Caravan', 'Town & Country', 'Pacifica', 'Sienna', 'Odyssey', 'Sedona',
    'Transit', 'Express', 'Savana', 'Sprinter', 'ProMaster', 'Voyager',
  ],
  Car: [
    'Camaro', 'Mustang', 'Challenger', 'Charger', 'Dart',
    'Impala', 'Malibu', 'Cruze', 'Fusion', 'Focus', 'Fiesta', 'Taurus',
    'Accord', 'Civic', 'Corolla', 'Camry', 'Avalon', 'Prius',
    'Altima', 'Sentra', 'Maxima', 'Versa',
    'Elantra', 'Sonata', 'Accent', 'Forte', 'Optima',
    'Jetta', 'Passat', 'Golf',
  ],
};

const MODEL_LOOKUP = Object.entries(MODEL_VEHICLE_TYPE_MAP)
  .flatMap(([type, models]) => models.map((name) => ({ name, type })))
  .sort((a, b) => b.name.length - a.name.length);

function findModelVehicleType(title) {
  const lowerTitle = title.toLowerCase();
  for (const { name, type } of MODEL_LOOKUP) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lowerTitle)) return type;
  }
  return null;
}

function findTitleMatch(title, lookupMap) {
  const lowerTitle = title.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const [name, gid] of Object.entries(lookupMap)) {
    if (name.length < 3) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lowerTitle) && name.length > bestLen) {
      best = gid;
      bestLen = name.length;
    }
  }
  return best;
}

const NOISE_WORDS = /\b(OEM|Genuine|New|Used)\b/gi;

function cleanTitle(rawTitle) {
  return rawTitle.replace(NOISE_WORDS, '').replace(/\s{2,}/g, ' ').trim();
}

function stripLikelyPartNumbers(text) {
  return text
    .split(/\s+/)
    .filter((tok) => {
      const stripped = tok.replace(/[-]/g, '');
      const looksLikePartNumber = /[A-Z]/.test(stripped) && /\d/.test(stripped) && stripped.length >= 5;
      return !looksLikePartNumber;
    })
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildSeoTitle(rawTitle) {
  let t = stripLikelyPartNumbers(cleanTitle(rawTitle));
  if (t.length > 60) t = t.slice(0, 57).replace(/\s+\S*$/, '') + '...';
  return t;
}

function buildSeoDescription(rawTitle) {
  let base = stripLikelyPartNumbers(cleanTitle(rawTitle));
  let desc = `${base} — genuine OEM factory replacement, direct fit.`;
  if (desc.length > 160) {
    desc = base.slice(0, 150).replace(/\s+\S*$/, '') + '...';
  }
  return desc;
}

// ── Fetch full product detail needed by both parts ─────────────────
async function fetchProductDetail(productId) {
  const data = await shopifyGraphQL(
    `query($id: ID!) {
      product(id: $id) {
        id
        title
        tags
        descriptionHtml
        dateAdded: metafield(namespace: "custom", key: "dated_added_") { value }
        variants(first: 25) {
          edges { node { id sku } }
        }
      }
    }`,
    { id: productId }
  );
  return data.product;
}

// ── Main entry point ────────────────────────────────────────────────
async function processNewProduct(productId) {
  const product = await fetchProductDetail(productId);
  if (!product) throw new Error(`Product ${productId} not found`);

  const metafields = [];
  const summary = [];

  // --- Part B fields first (fast, no network wait needed for these) ---
  metafields.push(
    { ownerId: product.id, namespace: 'shopify', key: 'fit-type', type: 'list.metaobject_reference', value: JSON.stringify([FIT_TYPE_DIRECT]) },
    { ownerId: product.id, namespace: 'shopify', key: 'item-condition', type: 'list.metaobject_reference', value: JSON.stringify([ITEM_CONDITION_NEW]) },
    { ownerId: product.id, namespace: 'shopify', key: 'manufacturer-type', type: 'list.metaobject_reference', value: JSON.stringify([MANUFACTURER_TYPE_OEM]) }
  );

  for (const field of DYNAMIC_CATEGORY_FIELDS) {
    const gid = findTitleMatch(product.title, HARDCODED_METAOBJECTS[field.key]);
    if (gid) {
      metafields.push({ ownerId: product.id, namespace: 'shopify', key: field.key, type: 'list.metaobject_reference', value: JSON.stringify([gid]) });
      summary.push(field.key);
    }
  }

  const inferredSegment = findModelVehicleType(product.title);
  for (const key of ['motor-vehicle-type', 'vehicle-type']) {
    const gid = inferredSegment ? HARDCODED_METAOBJECTS[key][inferredSegment.toLowerCase()] : null;
    if (gid) {
      metafields.push({ ownerId: product.id, namespace: 'shopify', key, type: 'list.metaobject_reference', value: JSON.stringify([gid]) });
      summary.push(`${key}(${inferredSegment})`);
    }
  }

  if (!product.dateAdded || !product.dateAdded.value) {
    const today = new Date().toISOString().slice(0, 10);
    metafields.push({ ownerId: product.id, namespace: 'custom', key: 'dated_added_', type: 'date', value: today });
    summary.push(`dateAdded=${today}`);
  }

  for (const { node: variant } of product.variants.edges) {
    if (!variant.sku) continue;
    metafields.push(
      { ownerId: variant.id, namespace: 'mm-google-shopping', key: 'mpn', type: 'single_line_text_field', value: variant.sku },
      { ownerId: variant.id, namespace: 'mm-google-shopping', key: 'condition', type: 'single_line_text_field', value: 'new' },
      { ownerId: variant.id, namespace: 'mm-google-shopping', key: 'age_group', type: 'single_line_text_field', value: 'adult' },
      { ownerId: variant.id, namespace: 'mm-google-shopping', key: 'gender', type: 'single_line_text_field', value: 'unisex' }
    );
  }
  summary.push(`googleShopping(${product.variants.edges.filter((e) => e.node.sku).length} variants)`);

  const seoTitle = buildSeoTitle(product.title);
  const seoDescription = buildSeoDescription(product.title);

  // --- Set category FIRST (must exist before the "shopify" namespace metafields
  //     below will be accepted) — combined with the SEO update in one call. ---
  const categoryResult = await shopifyGraphQL(
    `mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        id: product.id,
        category: PRODUCT_CATEGORY_MOTOR_VEHICLE_PARTS,
        seo: { title: seoTitle, description: seoDescription },
      },
    }
  );
  if (categoryResult.productUpdate.userErrors?.length) {
    summary.push(`categoryErrors=${JSON.stringify(categoryResult.productUpdate.userErrors)}`);
  } else {
    summary.push('category=set');
  }

  // --- Part A: fitment extraction (AI call) ---
  let fitmentSummary = 'fitment=FAILED';
  try {
    const fitment = await extractFitment(product.title, product.tags, product.descriptionHtml);
    metafields.push(
      { ownerId: product.id, namespace: 'fitment', key: 'extracted', type: 'boolean', value: 'true' },
      { ownerId: product.id, namespace: 'fitment', key: 'data', type: 'json', value: JSON.stringify(fitment) }
    );
    fitmentSummary = 'fitment=OK';
  } catch (err) {
    fitmentSummary = `fitment=FAILED (${err.message})`;
  }
  summary.push(fitmentSummary);

  // --- Write everything: metafields batched (25 max per call), then SEO ---
  for (let i = 0; i < metafields.length; i += 25) {
    const batch = metafields.slice(i, i + 25);
    const result = await shopifyGraphQL(
      `mutation($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key namespace }
          userErrors { field message }
        }
      }`,
      { metafields: batch }
    );
    if (result.metafieldsSet.userErrors?.length) {
      summary.push(`metafieldErrors=${JSON.stringify(result.metafieldsSet.userErrors)}`);
    }
  }

  // Tell the live chatbot backend about this product so it's searchable
  // right away, instead of waiting for the next full index rebuild (which
  // only happens on deploy). Best-effort — if the chatbot is asleep
  // (Render free tier) or unreachable, this just gets skipped without
  // blocking the import.
  const CHATBOT_URL = process.env.CHATBOT_URL;
  const CHATBOT_ADMIN_SECRET = process.env.CHATBOT_ADMIN_SECRET;
  if (CHATBOT_URL && CHATBOT_ADMIN_SECRET) {
    try {
      const reindexRes = await fetch(`${CHATBOT_URL}/api/admin/reindex-product`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': CHATBOT_ADMIN_SECRET },
        body: JSON.stringify({ productId: product.id }),
      });
      const reindexData = await reindexRes.json();
      summary.push(reindexData.indexed ? 'chatbotIndex=OK' : `chatbotIndex=skipped(${reindexData.reason || reindexData.error})`);
    } catch (err) {
      summary.push(`chatbotIndex=FAILED(${err.message})`);
    }
  }

  return { productId: product.id, title: product.title, summary: summary.join(', ') };
}

module.exports = { processNewProduct };
