/**
 * extractFitment.js
 *
 * Batch job: reads every active product, asks Claude to pull structured
 * fitment data out of the title/tags/description, and writes it back as
 * Shopify metafields under the "fitment" namespace.
 *
 * Processes products that were never extracted, OR whose title/description
 * changed since extraction (tracked with a fitment.source_hash fingerprint).
 * Safe to re-run anytime, including on a schedule.
 * ONLY=handle1,handle2 forces specific products to re-extract right now.
 *
 * Usage (manual, from your Mac):
 *   cd ~/Desktop/shopify-importer
 *   node extractFitment.js
 *
 * Also callable as a module — exports runExtraction(), used by the fitment
 * chatbot's /api/admin/extract-missing-fitment endpoint so this can run on
 * a daily schedule without anyone needing to trigger it by hand.
 *
 * Requires in .env (alongside your existing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET):
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   SHOPIFY_STORE=parts1.myshopify.com
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'parts1.myshopify.com';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // cheap model, this is a structured extraction task
const CONCURRENCY_LIMIT = 3; // matches the limit already used in bulk.js
const API_VERSION = '2024-10';
const LOG_FILE = path.join(__dirname, 'fitment-extraction-log.jsonl');
const FAILED_FILE = path.join(__dirname, 'fitment-extraction-failed.jsonl');
// Max products re-extracted per run because their listing was edited (protects
// against a surprise AI bill after a bulk description change; the rest roll to the next night).
const MAX_EDIT_REEXTRACT = parseInt(process.env.MAX_EDIT_REEXTRACT || '300', 10);
const ENGINE_CLEANUP_LOG = path.join(__dirname, 'fitment-engine-cleanup-log.jsonl');

// ---------- Shopify auth (same pattern as server.js) ----------

async function getShopifyAccessToken() {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Shopify auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function shopifyGraphQL(token, query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(data.errors)}`);
  return data.data;
}

// ---------- Product fetching ----------

const PRODUCTS_QUERY = `
  query GetProducts($cursor: String) {
    products(first: 50, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          handle
          title
          tags
          descriptionHtml
          metafield(namespace: "fitment", key: "extracted") { value }
          data: metafield(namespace: "fitment", key: "data") { value }
          srcHash: metafield(namespace: "fitment", key: "source_hash") { value }
        }
      }
    }
  }
`;

async function fetchAllProducts(token) {
  const products = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL(token, PRODUCTS_QUERY, { cursor });
    for (const edge of data.products.edges) {
      products.push(edge.node);
    }
    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
    process.stdout.write(`\rFetched ${products.length} products...`);
  }
  console.log('');
  return products;
}

// ---------- Fitment extraction via Claude ----------

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
  "position": "front" | "rear" | "upper" | "lower" | "both" | null,
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
  Use position="both" when the listing states the part fits EITHER front or rear (a single interchangeable
  part, not a pair) — same logic as side="both".
- "engine" only if a specific engine size/type is required for fitment (e.g. "1.4L Turbo", "6.2L").
- "option_package" for things like tow package, power windows, folding mirrors — features the vehicle must already have.
- "other_qualifiers" for anything else fitment-relevant that doesn't fit the above (trim level, generation code, cab style, etc.) — keep it short.
- makes/models should be the actual vehicle names (e.g. "Silverado", not "Chevrolet Silverado 1500 LT").
- Respond with the JSON object only.`;

async function extractFitment(product) {
  const description = stripHtml(product.descriptionHtml).slice(0, 2000);
  const userContent = `Title: ${product.title}\nTags: ${product.tags.join(', ')}\nDescription: ${description}`;

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

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text = data.content.find((b) => b.type === 'text')?.text || '';
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// Fingerprint of exactly what the AI reads (title + tags + first 2000 chars of
// the description). When it changes, the stored fitment data is out of date.
function sourceHash(product) {
  const text = [product.title, (product.tags || []).join(','), stripHtml(product.descriptionHtml).slice(0, 2000)].join('\n');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// ---------- Writing metafields back to Shopify ----------

const METAFIELDS_SET_MUTATION = `
  mutation SetFitmentMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key }
      userErrors { field message }
    }
  }
`;

// Writes ONLY the fitment data (leaves the "extracted" flag alone) — used
// by the engine cleanup, which edits existing data without re-extracting.
async function writeFitmentData(token, productId, fitment) {
  const metafields = [{ ownerId: productId, namespace: 'fitment', key: 'data', type: 'json', value: JSON.stringify(fitment) }];
  const data = await shopifyGraphQL(token, METAFIELDS_SET_MUTATION, { metafields });
  const errors = data.metafieldsSet.userErrors;
  if (errors && errors.length) {
    throw new Error(`Metafield write error for ${productId}: ${JSON.stringify(errors)}`);
  }
}

async function writeFitmentMetafields(token, productId, fitment, hash) {
  const metafields = [
    { ownerId: productId, namespace: 'fitment', key: 'extracted', type: 'boolean', value: 'true' },
    { ownerId: productId, namespace: 'fitment', key: 'data', type: 'json', value: JSON.stringify(fitment) },
    { ownerId: productId, namespace: 'fitment', key: 'source_hash', type: 'single_line_text_field', value: hash },
  ];
  const data = await shopifyGraphQL(token, METAFIELDS_SET_MUTATION, { metafields });
  const errors = data.metafieldsSet.userErrors;
  if (errors && errors.length) {
    throw new Error(`Metafield write error for ${productId}: ${JSON.stringify(errors)}`);
  }
}

// Baseline: records the fingerprint for products that predate this feature,
// WITHOUT calling the AI (assumes their current data matches their listing).
async function writeHashOnly(token, product) {
  const metafields = [{ ownerId: product.id, namespace: 'fitment', key: 'source_hash', type: 'single_line_text_field', value: sourceHash(product) }];
  const data = await shopifyGraphQL(token, METAFIELDS_SET_MUTATION, { metafields });
  const errors = data.metafieldsSet.userErrors;
  if (errors && errors.length) throw new Error(`Hash write error for ${product.id}: ${JSON.stringify(errors)}`);
}

// ---------- Concurrency-limited processing ----------

async function processQueue(items, worker, concurrency, onError) {
  let index = 0;
  let completed = 0;
  const results = [];

  async function runNext() {
    if (index >= items.length) return;
    const i = index++;
    try {
      const result = await worker(items[i], i);
      results[i] = { ok: true, result };
    } catch (err) {
      results[i] = { ok: false, error: err.stack || err.message };
      if (onError) onError(items[i], err);
    }
    completed++;
    process.stdout.write(`\rProcessed ${completed}/${items.length}`);
    await runNext();
  }

  const runners = Array.from({ length: concurrency }, () => runNext());
  await Promise.all(runners);
  console.log('');
  return results;
}

// ---------- Engine relevance ----------

// An engine requirement only matters for parts that depend on the engine.
// The listing's fitment table names an engine for EVERY part, so extraction
// often stores one on interior/trim/body parts where it makes no difference.
// This is the exact same rule the product page uses to hide the engine line
// (copied verbatim from fitment-product-page-confirm.liquid) — if you change
// one, change the other.
function engineMattersForPart(title) {
  var t = (title || '').toLowerCase();
  if (/\b\d\.\d\s?l?\b|\bv(?:6|8|10|12)\b|\bi[3-6]\b|\bturbo|\bdiesel\b|\bhybrid\b|\becoboost\b|\bhemi\b|\bsupercharged\b|\bcylinder\b/.test(t)) return true;
  if (/\b(?:engine|motor|transmission|transaxle|exhaust|muffler|catalytic|manifold|intake|throttle|supercharger|injector|fuel|pump|radiator|coolant|cooling|oil|timing|camshaft|crankshaft|piston|valve|head gasket|alternator|starter|spark|ignition|oxygen|o2|egr|emission|evap|pcv|axle|differential|driveshaft|clutch|flywheel|tensioner|serpentine)\b/.test(t)) return true;
  if (/\b(?:trim|cover|cap|pocket|pull|handle|bezel|molding|moulding|panel|grille|grill|lens|emblem|badge|nameplate|weatherstrip|armrest|console|seat|visor|sill|scuff|pillar|bumper|fender|liner|splash|mud flap|mirror|glass|window|door|hood|trunk|liftgate|tailgate|carpet|mat|dash|dashboard|vent|knob|button|speaker|headliner|garnish|clip|retainer|bracket|reflector|lamp|light|wiper|spoiler|rail|step|insert|applique|decal|stripe|filler|plug|grommet|seal)\b/.test(t)) return false;
  return true;
}

// Already-extracted product whose stored engine can't matter for that part.
function needsEngineCleanup(product) {
  if (!product.metafield) return false;
  try {
    const data = JSON.parse(product.data && product.data.value);
    return !!(data && data.engine && !engineMattersForPart(product.title));
  } catch (e) {
    return false;
  }
}

// ---------- Which products need work ----------

// A product needs (re-)extraction if it was never extracted, OR its stored
// fitment data predates the "position" field (front/rear/upper/lower) —
// those were extracted by an older version of this script's prompt and
// would otherwise never show a front/rear check on the product page.
function needsExtraction(product) {
  if (!product.metafield) return true;
  try {
    const data = JSON.parse(product.data && product.data.value);
    return !data || !Object.prototype.hasOwnProperty.call(data, 'position');
  } catch (e) {
    return true; // flagged as extracted but data missing/unreadable — redo it
  }
}

// Listing was edited after fitment was extracted (fingerprint no longer matches).
function listingChanged(product) {
  return !!(product.srcHash && product.srcHash.value && product.srcHash.value !== sourceHash(product));
}

// ONLY=handle1,handle2 forces those products to be re-extracted right now.
function forcedHandles() {
  return (process.env.ONLY || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

// Guarantees the "position" key always exists after extraction (null if the
// listing doesn't state one) — otherwise a product the AI leaves position
// off of would be picked up for re-extraction again every single night.
function withPositionKey(fitment) {
  if (!Object.prototype.hasOwnProperty.call(fitment, 'position')) fitment.position = null;
  return fitment;
}

// ---------- Core logic, callable directly or run standalone ----------

async function runExtraction() {
  if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY in environment.');
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) throw new Error('Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET in environment.');

  console.log('Authenticating with Shopify...');
  const token = await getShopifyAccessToken();

  console.log('Fetching products...');
  const allProducts = await fetchAllProducts(token);

  const forced = new Set(forcedHandles());
  const forcedList = allProducts.filter((p) => forced.has((p.handle || '').toLowerCase()));
  const forcedIds = new Set(forcedList.map((p) => p.id));
  const baseList = allProducts.filter((p) => !forcedIds.has(p.id) && needsExtraction(p));
  const baseIds = new Set(baseList.map((p) => p.id));
  const editedAll = allProducts.filter((p) => !forcedIds.has(p.id) && !baseIds.has(p.id) && listingChanged(p));
  const edited = editedAll.slice(0, MAX_EDIT_REEXTRACT);
  const toProcess = forcedList.concat(baseList, edited);
  const processIdsAll = new Set(toProcess.map((p) => p.id));
  // Extracted before fingerprints existed: record one (no AI call).
  const toBaseline = allProducts.filter((p) => !processIdsAll.has(p.id) && p.metafield && !(p.srcHash && p.srcHash.value));
  const alreadyDone = allProducts.length - toProcess.length;
  const neverExtracted = allProducts.filter((p) => !p.metafield).length;
  const missingPosition = baseList.length - neverExtracted;
  // Already-extracted parts carrying an engine that can't matter for that
  // kind of part (anything being re-extracted gets the same rule applied
  // as it's written, so it's excluded here).
  const processIds = new Set(toProcess.map((p) => p.id));
  const toCleanEngine = allProducts.filter((p) => !processIds.has(p.id) && needsEngineCleanup(p));

  console.log(`${allProducts.length} active products found. ${alreadyDone} already have current fitment data — skipping those.`);
  console.log(`Processing ${toProcess.length} products (${neverExtracted} never extracted, ${missingPosition} re-extracting to add the position field, ${edited.length} edited since last extraction${editedAll.length > edited.length ? ` [${editedAll.length - edited.length} more wait for tomorrow night]` : ''}, ${forcedList.length} forced via ONLY)...`);
  console.log(`Recording a baseline fingerprint (no AI) for ${toBaseline.length} existing products...`);
  if (edited.length) edited.slice(0, 25).forEach((p) => console.log(`  edited: ${p.title}`));
  console.log(`Removing the engine from ${toCleanEngine.length} trim/body/interior parts where it can't matter...`);

  // DRY_RUN=true node extractFitment.js  ->  report only, writes nothing.
  if (process.env.DRY_RUN === 'true') {
    console.log('\nDRY RUN — nothing will be written. Sample of parts that would lose their engine line:');
    toCleanEngine.slice(0, 40).forEach((p) => console.log(`  [${JSON.parse(p.data.value).engine}]  ${p.title}`));
    console.log(`... ${toCleanEngine.length} parts total.`);
    return { totalProducts: allProducts.length, alreadyDone, processed: 0, succeeded: 0, failed: 0, engineCleaned: 0, dryRun: true };
  }

  if (toProcess.length === 0 && toCleanEngine.length === 0 && toBaseline.length === 0) {
    console.log('Nothing to do.');
    return { totalProducts: allProducts.length, alreadyDone, processed: 0, succeeded: 0, failed: 0, engineCleaned: 0 };
  }

  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const failedStream = fs.createWriteStream(FAILED_FILE, { flags: 'a' });
  const cleanStream = fs.createWriteStream(ENGINE_CLEANUP_LOG, { flags: 'a' });
  let successCount = 0;
  let failCount = 0;
  let cleanedCount = 0;
  let printedSampleErrors = 0;

  const onError = (product, err) => {
    failCount++;
    failedStream.write(JSON.stringify({ id: product.id, title: product.title, error: err.message }) + '\n');
    if (printedSampleErrors < 3) {
      printedSampleErrors++;
      console.error(`\n[FAILED] "${product.title}":\n${err.message}\n`);
    }
  };

  if (toProcess.length > 0) {
    await processQueue(
      toProcess,
      async (product) => {
        const fitment = withPositionKey(await extractFitment(product));
        // An engine on a trim/body/interior part is noise from the listing's fitment table.
        if (fitment.engine && !engineMattersForPart(product.title)) fitment.engine = null;
        await writeFitmentMetafields(token, product.id, fitment, sourceHash(product));
        logStream.write(JSON.stringify({ id: product.id, title: product.title, fitment }) + '\n');
        successCount++;
        return fitment;
      },
      CONCURRENCY_LIMIT,
      onError
    );
  }

  if (toCleanEngine.length > 0) {
    await processQueue(
      toCleanEngine,
      async (product) => {
        const data = JSON.parse(product.data.value);
        const removedEngine = data.engine;
        data.engine = null;
        await writeFitmentData(token, product.id, data);
        // The removed value is logged so any of these can be put back.
        cleanStream.write(JSON.stringify({ id: product.id, title: product.title, removedEngine }) + '\n');
        cleanedCount++;
      },
      CONCURRENCY_LIMIT,
      onError
    );
  }

  if (toBaseline.length > 0) {
    await processQueue(toBaseline, (product) => writeHashOnly(token, product), CONCURRENCY_LIMIT + 3, onError);
  }

  logStream.end();
  failedStream.end();
  cleanStream.end();

  console.log(`\nDone. ${successCount} extracted, ${cleanedCount} had the engine removed, ${failCount} failed.`);
  console.log(`Extractions logged to: ${LOG_FILE}`);
  console.log(`Removed engines logged to: ${ENGINE_CLEANUP_LOG}`);
  console.log(`Failures logged to: ${FAILED_FILE}`);
  if (failCount > 0 && successCount === 0 && cleanedCount === 0) {
    console.log(`\nEverything failed — that usually means something systemic (bad API key, wrong model name, or a Shopify permission issue) rather than per-product problems. Check the errors printed above and in ${FAILED_FILE}.`);
  } else if (failCount > 0) {
    console.log(`Run this again later — it only touches products that still need work, so it'll retry the failures.`);
  }

  return { totalProducts: allProducts.length, alreadyDone, processed: toProcess.length, succeeded: successCount, failed: failCount, engineCleaned: cleanedCount };
}

module.exports = { runExtraction, needsExtraction, sourceHash, listingChanged, withPositionKey, engineMattersForPart, needsEngineCleanup };

// Only auto-run when executed directly (`node extractFitment.js`) — not
// when required as a module by server.js for the scheduled endpoint.
if (require.main === module) {
  runExtraction().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
