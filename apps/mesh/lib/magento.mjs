// Read-only Magento catalog client. Pulls live product data from the
// staging M2 (Adobe Commerce Cloud) through the same basic-auth the Fastly
// VCL uses for media. Queries only; the POC never writes to staging.
//
// Production shape note: the production api-mesh fronts M2 GraphQL as a proper
// Mesh subgraph. Here M2 is called from resolvers via this thin client so
// the demo apps keep a small schema free of Magento type collisions.
// Swapping this for a composed Magento subgraph is the cutover refactor.
//
// Auth: MESH_MAGENTO_AUTH (base64 user:pass). Unset → Magento reads are
// disabled and everything falls back to the local demo catalog.

const ENDPOINT = process.env.MESH_MAGENTO_URL ?? 'https://mcstaging.petbarn.com.au/graphql';

const authHeader = () =>
  process.env.MESH_MAGENTO_AUTH ? { authorization: `Basic ${process.env.MESH_MAGENTO_AUTH}` } : {};

export const magentoEnabled = () => Boolean(process.env.MESH_MAGENTO_AUTH);

// In-memory response cache (POC-sized). Keeps the demo alive when staging
// flakes mid-session and keeps us polite on repeated reads.
const cache = new Map(); // key -> { at, value }
const TTL_MS = 5 * 60 * 1000;

const cached = async (key, loader) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
};

async function magentoQuery(query, variables = {}) {
  if (!magentoEnabled()) throw new Error('MESH_MAGENTO_AUTH not set: Magento reads disabled');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader() },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`Magento ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Magento GraphQL error: ${body.errors[0].message}`);
  return body.data;
}

const collectionFromCategories = (categories = []) => {
  for (const { url_path } of categories) {
    if (url_path?.startsWith('dogs')) return 'dog';
    if (url_path?.startsWith('cats')) return 'cat';
    if (url_path?.startsWith('fish')) return 'fish';
  }
  return null;
};

// Staging has junk entries (sku-only names, placeholder art, $0 price).
// None of that belongs in a storefront demo.
const presentable = (item) =>
  item.name &&
  item.name !== item.sku &&
  (item.price_range?.minimum_price?.final_price?.value ?? 0) > 0 &&
  item.small_image?.url &&
  !item.small_image.url.includes('placeholder');

const toProduct = (item) => ({
  id: item.sku,
  handle: item.url_key,
  title: item.name,
  description: item.description?.html ?? item.short_description?.html ?? '',
  price: item.price_range.minimum_price.final_price.value,
  currency: item.price_range.minimum_price.final_price.currency,
  image: item.small_image.url,
  collection: collectionFromCategories(item.categories) ?? 'dog',
  availableForSale: item.stock_status === 'IN_STOCK'
});

const PRODUCT_FIELDS = `
  sku
  url_key
  name
  short_description { html }
  description { html }
  stock_status
  small_image { url }
  price_range { minimum_price { final_price { value currency } } }
  categories { url_path }
`;

export async function searchProducts(first = 24) {
  return cached(`search:${first}`, async () => {
    const data = await magentoQuery(
      `query($first: Int) {
        products(filter: { price: { from: \"1\" } }, pageSize: $first, sort: { name: ASC }) {
          items { ${PRODUCT_FIELDS} }
        }
      }`,
      { first: Math.max(first, 100) }
    );
    return (data.products?.items ?? []).filter(presentable).map(toProduct);
  });
}

export async function findProductByUrlKey(handle) {
  return cached(`product:${handle}`, async () => {
    const data = await magentoQuery(
      `query($handle: String) {
        products(filter: { url_key: { eq: $handle } }, pageSize: 1) {
          items { ${PRODUCT_FIELDS} }
        }
      }`,
      { handle }
    );
    const item = data.products?.items?.[0];
    return item && presentable(item) ? toProduct(item) : null;
  });
}
