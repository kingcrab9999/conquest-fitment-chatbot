/**
 * extractFitment.js
 *
 * Batch job: reads every active product, asks Claude to pull structured
 * fitment data out of the title/tags/description, and writes it back as
 * Shopify metafields under the "fitment" namespace.
 *
 * Only processes products that don't already have fitment data — safe to
 * re-run anytime, including on a schedule, since it always skips anything
 * already extracted.
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

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'parts1.myshopify.com';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // cheap model, this is a structured extraction task
const CONCURRENCY_LIMIT = 3; // matches the limit already used in bulk.js
const API_VERSION = '2024-10';
const LOG_FILE = path.join(__dirname, 'fitment-extraction-log.jsonl');
const FAILED_FILE = path.join(__dirname, 'fitment-extraction-failed.jsonl');

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
          title
          tags
          descriptionHtml
          metafield(namespace: "fitment", key: "extracted") { value }
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
  "color": string or null,
  "engine": string or null,
  "option_package": string or null,
  "other_qualifiers": string or null
}

Rules:
- Only include a field if the source text actually states it. Never guess or infer beyond what's written.
- "side" only if the part is explicitly side-specific (driver/passenger/left/right).
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

// ---------- Writing metafields back to Shopify ----------

const METAFIELDS_SET_MUTATION = `
  mutation SetFitmentMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key }
      userErrors { field message }
    }
  }
`;

async function writeFitmentMetafields(token, productId, fitment) {
  const metafields = [
    { ownerId: productId, namespace: 'fitment', key: 'extracted', type: 'boolean', value: 'true' },
    { ownerId: productId, namespace: 'fitment', key: 'data', type: 'json', value: JSON.stringify(fitment) },
  ];
  const data = await shopifyGraphQL(token, METAFIELDS_SET_MUTATION, { metafields });
  const errors = data.metafieldsSet.userErrors;
  if (errors && errors.length) {
    throw new Error(`Metafield write error for ${productId}: ${JSON.stringify(errors)}`);
  }
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

// ---------- Core logic, callable directly or run standalone ----------

async function runExtraction() {
  if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY in environment.');
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) throw new Error('Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET in environment.');

  console.log('Authenticating with Shopify...');
  const token = await getShopifyAccessToken();

  console.log('Fetching products...');
  const allProducts = await fetchAllProducts(token);

  const toProcess = allProducts.filter((p) => !p.metafield);
  const alreadyDone = allProducts.length - toProcess.length;
  console.log(`${allProducts.length} active products found. ${alreadyDone} already have fitment data — skipping those.`);
  console.log(`Processing ${toProcess.length} products...`);

  if (toProcess.length === 0) {
    console.log('Nothing to do.');
    return { totalProducts: allProducts.length, alreadyDone, processed: 0, succeeded: 0, failed: 0 };
  }

  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const failedStream = fs.createWriteStream(FAILED_FILE, { flags: 'a' });
  let successCount = 0;
  let failCount = 0;
  let printedSampleErrors = 0;

  await processQueue(
    toProcess,
    async (product) => {
      const fitment = await extractFitment(product);
      await writeFitmentMetafields(token, product.id, fitment);
      logStream.write(JSON.stringify({ id: product.id, title: product.title, fitment }) + '\n');
      successCount++;
      return fitment;
    },
    CONCURRENCY_LIMIT,
    (product, err) => {
      failCount++;
      failedStream.write(JSON.stringify({ id: product.id, title: product.title, error: err.message }) + '\n');
      if (printedSampleErrors < 3) {
        printedSampleErrors++;
        console.error(`\n[FAILED] "${product.title}":\n${err.message}\n`);
      }
    }
  );

  logStream.end();
  failedStream.end();

  console.log(`\nDone. ${successCount} succeeded, ${failCount} failed.`);
  console.log(`Successes logged to: ${LOG_FILE}`);
  console.log(`Failures logged to: ${FAILED_FILE}`);
  if (failCount > 0 && successCount === 0) {
    console.log(`\nEverything failed — that usually means something systemic (bad API key, wrong model name, or a Shopify permission issue) rather than per-product problems. Check the errors printed above and in ${FAILED_FILE}.`);
  } else if (failCount > 0) {
    console.log(`Run this again later — it only processes products missing fitment data, so it'll retry the failures.`);
  }

  return { totalProducts: allProducts.length, alreadyDone, processed: toProcess.length, succeeded: successCount, failed: failCount };
}

module.exports = { runExtraction };

// Only auto-run when executed directly (`node extractFitment.js`) — not
// when required as a module by server.js for the scheduled endpoint.
if (require.main === module) {
  runExtraction().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
