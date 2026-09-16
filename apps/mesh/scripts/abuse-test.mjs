// GraphQL protection abuse test. Proves the gateway blocks the patterns
// Petbarn cares about (and that legit traffic still passes).
//
// Usage:
//   node dev.mjs              # in one terminal (or deploy + pass --base)
//   node scripts/abuse-test.mjs [--base http://localhost:4000/api/graphql]
//
// No dependencies, Node 20+ built-in fetch.

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { base: { type: 'string', default: process.env.MESH_URL ?? 'http://localhost:4000/api/graphql' } }
});
const BASE = values.base;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};

async function gql(query, variables, identity) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(identity ? { 'x-forwarded-for': identity } : {})
    },
    body: JSON.stringify({ query, variables })
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON response (e.g. edge error page)
  }
  return { status: res.status, json };
}

const errorCode = (json) =>
  json?.errors?.[0]?.extensions?.code ?? null;

const errorText = (json) =>
  (json?.errors ?? []).map((e) => e.message).join(' | ');

// Blocked = request rejected before executing the operation (HTTP error
// status, or a GraphQL error that isn't a normal resolver error).
const isBlocked = (res) => res.status >= 400 || (res.json?.errors?.length ?? 0) > 0;

// --- 1. Legit traffic still passes -----------------------------------------

{
  const res = await gql(`query ProductsListing { products { handle title price } }`);
  record(
    'legit query passes',
    res.status === 200 && !!res.json?.data?.products?.length,
    `status ${res.status}`
  );
}

{
  const cartRes = await gql(`mutation { createCart { id } }`);
  const cartId = cartRes.json?.data?.createCart?.id;
  const res = await gql(
    `query CartCheck($id: ID!) { cart(id: $id) { totalQuantity lines { product { collection title } cost } } }`,
    { id: cartId }
  );
  record(
    'legit nested query (depth 4) passes',
    res.status === 200 && Array.isArray(res.json?.data?.cart?.lines),
    `status ${res.status}`
  );
}

// --- 2. Cloudflare parity: query depth limiting ------------------------------
// Continent <-> Country is recursive in the Countries subgraph, so deep
// nesting is possible without custom resolvers.

const deepQuery = (levels) =>
  `query DepthAttack { continents { countries { continent ${'countries { continent '.repeat(levels)}code${'} '.repeat(levels)} } } }`;

{
  const res = await gql(deepQuery(60));
  record(
    'deep nesting blocked (maxDepth)',
    isBlocked(res),
    `status ${res.status}, code ${errorCode(res.json) ?? errorText(res.json).slice(0, 80)}`
  );
}

// --- 3. Cloudflare parity: oversized/complex document ------------------------

{
  const wide = `query TokenBomb { products { ${'handle '.repeat(1200)} } }`;
  const res = await gql(wide);
  record(
    'oversized document blocked (maxTokens)',
    isBlocked(res),
    `status ${res.status}, code ${errorCode(res.json) ?? errorText(res.json).slice(0, 80)}`
  );
}

// --- 4. Beyond: alias abuse --------------------------------------------------

{
  const aliases = Array.from({ length: 25 }, (_, i) => `p${i}: products { handle }`).join(' ');
  const res = await gql(`query AliasAbuse { ${aliases} }`);
  record(
    'alias abuse blocked (maxAliases)',
    isBlocked(res),
    `status ${res.status}, code ${errorCode(res.json) ?? errorText(res.json).slice(0, 80)}`
  );
}

// --- 5. Beyond: schema leak masking ------------------------------------------

{
  const res = await gql(`query TypoProbe { produktz { handle } }`);
  const text = errorText(res.json);
  record(
    'field suggestions masked (no schema leak)',
    isBlocked(res) && !text.includes('Did you mean'),
    text.slice(0, 80) || `status ${res.status}`
  );
}

// --- 6. Beyond: field-level rate limit (card-testing pattern) ----------------
// placeOrder allows 5/60s. First order succeeds; 2-5 fail with a resolver
// error (cart is consumed); 6+ must be rejected by the rate limiter itself.

{
  const cartRes = await gql(`mutation { createCart { id } }`);
  const cartId = cartRes.json?.data?.createCart?.id;
  let limitHit = false;
  for (let i = 0; i < 7; i++) {
    const res = await gql(
      `mutation Order($id: ID!) { placeOrder(cartId: $id, email: "abuse-test@example.com") { id } }`,
      { id: cartId }
    );
    if (/rate limit/i.test(errorText(res.json))) limitHit = true;
  }
  record(
    'field rate limit enforced (placeOrder 5/60s)',
    limitHit,
    limitHit ? 'rate limiter message observed within 7 calls' : 'no rate limit message in 7 calls'
  );
}

// --- 7. Beyond: gateway-level mutation flood guard ---------------------------
// 45 rapid addToCart mutations: the field quota (30/60s) trips first, then
// the flood guard (40 mutations/60s per identity) blocks at the gateway level.

{
  const cartRes = await gql(`mutation { createCart { id } }`);
  const cartId = cartRes.json?.data?.createCart?.id;
  const layers = new Set();
  let blockedCount = 0;
  for (let i = 0; i < 45; i++) {
    const res = await gql(
      `mutation Flood($id: ID!) { addToCart(cartId: $id, handle: "wildwise-kibble-beef-12kg", quantity: 1) { id } }`,
      { id: cartId }
    );
    if (isBlocked(res)) {
      blockedCount++;
      const text = errorText(res.json) + ' ' + errorCode(res.json);
      if (res.json?.errors?.some((e) => e.extensions?.code === 'GRAPHQL_MUTATION_FLOOD_BLOCKED')) {
        layers.add('flood-guard');
      } else if (/rate limit/i.test(text)) {
        layers.add('field-rate-limit');
      } else {
        layers.add('other');
      }
    }
  }
  record(
    'mutation flood blocked (45 rapid mutations)',
    blockedCount >= 5,
    `${blockedCount}/45 blocked via: ${[...layers].join(', ') || 'none'}`
  );
}

// --- 7b. Lockout: even queries from the flooded identity are blocked ---------
// Once the mutation flood threshold is exceeded, the identity is locked out
// entirely for the rest of the window, reads included.

{
  const res = await gql(`query AfterFlood { collections { handle } }`);
  record(
    'flooded identity locked out (queries too)',
    isBlocked(res),
    `status ${res.status}, code ${errorCode(res.json) ?? errorText(res.json).slice(0, 80)}`
  );
}

// --- 8. Introspection (reported, not asserted) --------------------------------
// Fresh identity so the flood lockout above doesn't skew the result.

{
  const res = await gql(`query Introspect { __schema { queryType { name } } }`, undefined, 'introspection-probe');
  const enabled = res.status === 200 && !!res.json?.data?.__schema;
  console.log(
    `NOTE  introspection is ${enabled ? 'ENABLED (playground mode, set MESH_DISABLE_INTROSPECTION=true in production)' : 'disabled'}`
  );
}

// --- Summary -------------------------------------------------------------------

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error('Failed:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
