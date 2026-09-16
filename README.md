# Petbarn POC: Vercel as the front door

One domain, multiple independently deployed apps, zero compute in the routing
layer. Reverse engineered from staging Adobe Commerce/Fastly VCL (v1041).

## Apps

| Path          | Stack                                               | Purpose              |
| ------------- | --------------------------------------------------- | -------------------- |
| `apps/router` | static `vercel.json` + firewall-as-code, no compute | routing + firewall   |
| `apps/mesh`   | GraphQL Mesh v1 (Hive Gateway)                      | GraphQL + protection |

Everything else proxies the real staging apps (pwa-frontend, checkout,
pet-ai-chat, petwatch, consent-centre, repeat-delivery-admin) and the Magento
M2 lane on Adobe Commerce Cloud.

## What it demonstrates

1. **Routing parity.** The pwa allow-list, checkout dictionary redirects,
   per-app routes and the M2 lane recreated as static rewrites (39/2,048 routes).
2. **GraphQL protection.** The mesh covers what Cloudflare API Shield's GraphQL
   protection covers, natively in the Guild stack, and adds what it cannot do
   (depth, tokens, aliases, cost, mutation flood guard, per-field rate limits).
   See [apps/mesh/README.md](apps/mesh/README.md).
3. **Centralized security.** Firewall rules on the router protect every proxied
   backend, applied at build time. Log-only first, `MODE=enforce` at cutover.

## Validation

```bash
node scripts/validate-routes.mjs --live https://petbarn.aldo.io --bypass
pnpm --filter @poc/mesh test:security
```

## Deployment

Two Vercel projects, push-to-deploy from `main`:

| Project              | Root          | Domain            | Serves               |
| -------------------- | ------------- | ----------------- | -------------------- |
| `petbarn-poc-router` | `apps/router` | `petbarn.aldo.io` | routing + firewall   |
| `petbarn-poc-mesh`   | `apps/mesh`   | none              | GraphQL + protection |

Project env vars (set in the dashboard, never committed): `MESH_MAGENTO_AUTH`
(mesh, read-only staging Magento access), `FIREWALL_TOKEN` and
`FIREWALL_TEAM_ID` (router, build-time firewall apply).
