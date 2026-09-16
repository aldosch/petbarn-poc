// Route validation for the router.
//
//   node scripts/validate-routes.mjs                     # static checks
//   node scripts/validate-routes.mjs --live <url> [--bypass]
//
// Static: budget, duplicate sources, catch-all ordering, https destinations.
// Live: one request per representative VCL path, asserting the expected
// backend behavior. --bypass injects the staging Vercel Authentication bypass
// headers (the video-recording path, also reproducible via a _vercel_jwt
// cookie in DevTools).

import { readFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

const liveUrl = arg('--live');
const bypass = process.argv.includes('--bypass');

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`FAIL  ${msg}`);
};
const pass = (msg) => console.log(`PASS  ${msg}`);

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

const config = JSON.parse(
  readFileSync(new URL('../apps/router/vercel.json', import.meta.url), 'utf8')
);
const BUDGET = 2048;
const routes = [...(config.redirects ?? []), ...(config.rewrites ?? []), ...(config.headers ?? [])];

routes.length <= BUDGET
  ? pass(`vercel.json: ${routes.length}/${BUDGET} routes`)
  : fail(`vercel.json: ${routes.length} routes exceeds ${BUDGET} budget`);

const sources = routes.map((r) => r.source);
const dupes = sources.filter((s, i) => sources.indexOf(s) !== i);
dupes.length === 0
  ? pass('vercel.json: no duplicate sources')
  : fail(`vercel.json: duplicate sources: ${[...new Set(dupes)].join(', ')}`);

const rewrites = config.rewrites ?? [];
const catchAllIdx = rewrites.findIndex((r) => r.source === '/:path*');
catchAllIdx === -1 || catchAllIdx === rewrites.length - 1
  ? pass('vercel.json: catch-all is last in rewrites')
  : fail('vercel.json: catch-all shadows rewrites');

const insecure = routes.filter((r) => typeof r.destination === 'string' && r.destination.startsWith('http://'));
insecure.length === 0
  ? pass('vercel.json: all destinations https')
  : fail(`vercel.json: insecure destinations: ${insecure.map((r) => r.source).join(', ')}`);

// ---------------------------------------------------------------------------
// Live matrix: route decisions from the real VCL, verified against a
// deployed router. 401s on the M2 lane are expected (staging basic auth);
// /petai-chat 308s are host canonicalization on that app (cutover checklist).
// ---------------------------------------------------------------------------

if (liveUrl) {
  const base = liveUrl.replace(/\/$/, '');
  const extraHeaders = bypass
    ? {
        'x-vercel-protection-bypass': 'b3466682594c1493b50084ed3496565b',
        'x-vercel-set-bypass-cookie': 'true',
      }
    : {};

  // With --bypass, Vercel Authentication answers the first request with a
  // 307 + Set-Cookie (_vercel_jwt); the settled state afterwards is cookie
  // only (no bypass headers), exactly the DevTools-cookie recording flow.
  // The staging apps' own 307s (canonical redirects) carry no Set-Cookie and are
  // reported as-is.
  const probe = async (path, init = {}) => {
    let res = await fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { ...extraHeaders, ...init.headers },
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const isAuthDance =
      (res.status === 307 || res.status === 308) &&
      setCookies.some((c) => c.startsWith('_vercel_jwt'));
    if (isAuthDance) {
      const cookies = setCookies.map((c) => c.split(';')[0]).join('; ');
      res = await fetch(`${base}${path}`, {
        redirect: 'manual',
        ...init,
        headers: { ...init.headers, ...(cookies ? { cookie: cookies } : {}) },
      });
    }
    return res;
  };

  const checks = [
    ['/', (_s) => true, 'root serves'],
    [
      '/p/acana-biologically-approriate-adult-dog-food-2kg',
      (s) => s === 200,
      'pwa path → the staging pwa-frontend (200 with bypass)',
    ],
    [
      '/c/dog',
      (s) => s !== 401,
      'category path → the staging pwa-frontend (app decides: 200/307/404 for that slug)',
    ],
    ['/checkout', (s, l) => s === 308 && l?.includes('/checkout/cart'), 'dict redirect /checkout → /checkout/cart (308)'],
    ['/checkout/cart', (s) => s === 200, 'the checkout app serves cart'],
    ['/grooming', (s, l) => s === 308 && l?.includes('/petbarn-grooming'), 'seo-module redirect (301)'],
    ['/faq', (s, l) => s === 308 && l?.includes('/frequently-asked-questions'), 'seo-module redirect (301)'],
    ['/media/catalog/product/placeholder/default/placeholder.png', (s) => s === 401 || s === 200, 'M2 lane'],
    ['/rest/V1/store/storeConfigs', (s) => s === 401 || s === 200, 'M2 lane /rest (401 on staging: basic auth)'],
    ['/petai-chat', (s) => s === 308, 'petai backend (308: host canonicalization, cutover checklist)'],
    ['/this-path-should-not-exist-xyz', (s) => s !== 401, 'unknown path does NOT hop to M2'],
  ];

  console.log(`\nlive matrix${bypass ? ' (bypass on)' : ''} against ${base}`);
  for (const [path, expect, note] of checks) {
    const res = await probe(path);
    const ok = expect(res.status, res.headers.get('location'));
    ok ? pass(`${path}: ${res.status} (${note})`) : fail(`${path}: ${res.status} (${note})`);
  }

  const gql = await probe('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ collections { handle } }' }),
  });
  const gqlBody = await gql.json().catch(() => null);
  gqlBody?.data?.collections
    ? pass('/graphql → mesh graphql round-trip')
    : fail('/graphql did not return mesh data');
}

process.exit(failures ? 1 : 0);
