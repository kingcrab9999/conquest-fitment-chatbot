/**
 * buildIndex.js
 *
 * Pulls every active product's fitment.data metafield from Shopify and
 * writes a flat local index (fitmentIndex.json) that the chatbot backend
 * reads at startup. This is what makes Year/Make/Model filtering instant
 * and free — no Shopify API calls, no AI calls, per customer interaction.
 *
 * Run this:
 *   - once now, to build the initial index
 *   - again any time you want to refresh it (new imports, price changes, etc.)
 *
 * Usage:
 *   node buildIndex.js
 *
 * Requires the same .env as your importer (SHOPIFY_CLIENT_ID,
 * SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'parts1.myshopify.com';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';
const OUTPUT_FILE = path.join(__dirname, 'fitmentIndex.json');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET in .env.');
  process.exit(1);
}

async function getAccessToken() {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error('Shopify token fetch failed: ' + (await res.text()));
  const data = await res.json();
  return data.access_token;
}

async function shopifyGraphQL(token, query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(json.errors));
  return json.data;
}

const PRODUCTS_QUERY = `
  query GetProducts($cursor: String) {
    products(first: 100, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          featuredImage { url }
          fitmentData: metafield(namespace: "fitment", key: "data") { value }
          variants(first: 5) {
            edges { node { id sku price } }
          }
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
    for (const edge of data.products.edges) products.push(edge.node);
    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
    process.stdout.write(`\rFetched ${products.length} products...`);
  }
  console.log('');
  return products;
}

function buildRecord(product) {
  if (!product.fitmentData || !product.fitmentData.value) return null;
  let fitment;
  try {
    fitment = JSON.parse(product.fitmentData.value);
  } catch (e) {
    return null; // skip malformed entries rather than crash the whole index
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
    color: fitment.color || null,
    engine: fitment.engine || null,
    option_package: fitment.option_package || null,
    other_qualifiers: fitment.other_qualifiers || null,
  };
}

async function main() {
  console.log('Authenticating with Shopify...');
  const token = await getAccessToken();

  console.log('Fetching products...');
  const rawProducts = await fetchAllProducts(token);

  const records = rawProducts.map(buildRecord).filter(Boolean);
  const skipped = rawProducts.length - records.length;

  const index = {
    builtAt: new Date().toISOString(),
    productCount: records.length,
    products: records,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(index));
  console.log(`\nIndex built: ${records.length} products indexed, ${skipped} skipped (no fitment data or no variant).`);
  console.log(`Written to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
