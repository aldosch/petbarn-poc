// Firewall rules-as-code for this project, applied at BUILD time.
//
// On every deploy (git push or vercel deploy) the build runs this script:
// it upserts the rules below into the project's firewall config via the
// Vercel API (match by name), leaving everything else untouched.
//
// Requires env vars (set on the project):
//   FIREWALL_TOKEN: Vercel API token (scoped token recommended)
//   FIREWALL_TEAM_ID: team id
// VERCEL_PROJECT_ID is injected by the build automatically.
// Missing token → warn and skip, deploys never break.
//
// MODE=log (default) ships the deny-class rules as log-only; MODE=enforce
// flips them to deny at cutover. Rate limits always enforce; they are the
// demo. Tune against logs before enforcing.
//
// Parity map (Fastly VCL → rule):
//   block_bots                       → Block crawler bots (UA)
//   magentomodule_blockNonAUCheckout → Challenge non-AU traffic on checkout
//   magentomodule_pwa_rate_limit     → Coupon GraphQL (10 req/60s per IP, the
//                                      pwaratelimit dict paths)
//   mesh volumetric layer            → GraphQL volumetric (JA4 upgrade story)
//   maint_allowlist (~170 IPs)       → not shipped; bulk-import via
//                                      vercel-bulk-waf-rules if needed

const api = 'https://api.vercel.com';
const token = process.env.FIREWALL_TOKEN;
const teamId = process.env.FIREWALL_TEAM_ID;
const projectId = process.env.VERCEL_PROJECT_ID ?? process.env.FIREWALL_PROJECT_ID;

const ENFORCE = process.env.MODE === 'enforce';

// condition types: host/path/method/header/query/cookie/ip_address/
// geo_country/... mitigate.action: allow/bypass/challenge/deny/log/redirect
const denyAction = ENFORCE ? 'deny' : 'log';

const desiredRules = [
  {
    name: 'Block crawler bots (UA)',
    description: 'block_bots VCL parity: BLEXBot/ClaudeBot/GPTBot/Scrapy',
    active: true,
    conditionGroup: [
      {
        conditions: [
          { type: 'user_agent', op: 'pre', value: 'BLEXBot' },
          { type: 'user_agent', op: 'pre', value: 'ClaudeBot' },
          { type: 'user_agent', op: 'pre', value: 'GPTBot' },
          { type: 'user_agent', op: 'pre', value: 'Scrapy' },
        ],
      },
    ],
    action: { mitigate: { action: denyAction } },
  },
  {
    name: 'Challenge non-AU traffic on checkout',
    description: 'blockNonAUCheckout VCL parity. Log-only first, enforce at cutover',
    active: true,
    conditionGroup: [
      {
        conditions: [
          { type: 'path', op: 'pre', value: '/checkout' },
          { type: 'geo_country', op: 'nex', value: 'AU' },
        ],
      },
    ],
    action: { mitigate: { action: denyAction } },
  },
  {
    name: 'Coupon GraphQL: 10 req/60s per IP',
    description: 'pwa_rate_limit VCL parity (pwaratelimit dict paths)',
    active: true,
    conditionGroup: [{ conditions: [{ type: 'path', op: 'pre', value: '/api/coupons/graphql' }] }],
    action: {
      mitigate: { action: 'rate_limit', rateLimit: { algo: 'fixed_window', keys: ['ip'], limit: 10, window: 60 } },
    },
  },
  {
    name: 'GraphQL volumetric: 100 req/60s per IP',
    description: 'Mesh layer; JA4-fingerprint rate limiting is the upgrade over the IP+path ratecounter',
    active: true,
    conditionGroup: [{ conditions: [{ type: 'path', op: 'eq', value: '/graphql' }] }],
    action: {
      mitigate: { action: 'rate_limit', rateLimit: { algo: 'fixed_window', keys: ['ip'], limit: 100, window: 60 } },
    },
  },
];

if (!token || !projectId) {
  console.warn('[firewall] FIREWALL_TOKEN/FIREWALL_TEAM_ID not set, skipping firewall apply');
  process.exit(0);
}

const qs = new URLSearchParams({ projectId });
if (teamId) qs.set('teamId', teamId);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const configUrl = `${api}/v1/security/firewall/config?${qs}`;
const configRes = await fetch(configUrl, { headers });
if (!configRes.ok) {
  console.warn(`[firewall] could not read config (${configRes.status}), skipping apply`);
  process.exit(0);
}
const existing = (await configRes.json())?.active?.rules ?? [];

let inserted = 0;
let updated = 0;
for (const rule of desiredRules) {
  const match = existing.find((r) => r.name === rule.name);
  const op = match
    ? { action: 'rules.update', id: match.id, value: rule }
    : { action: 'rules.insert', value: rule };
  const res = await fetch(configUrl, { method: 'PATCH', headers, body: JSON.stringify(op) });
  if (res.ok) {
    match ? updated++ : inserted++;
  } else {
    const err = await res.json().catch(() => ({}));
    console.warn(`[firewall] ${match ? 'update' : 'insert'} failed for "${rule.name}": ${err?.error?.message ?? res.status}`);
  }
}

console.log(
  `[firewall] applied: ${inserted} inserted, ${updated} updated (${ENFORCE ? 'enforce' : 'log'} mode)`
);
