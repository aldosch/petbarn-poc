// Smoke test: loads the gateway and verifies the composed schema resolves.
import { gateway } from '../lib/gateway.mjs';

const res = await gateway.fetch('http://localhost/api/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: '{ collections { handle } }' })
});
const body = await res.json();
if (res.status !== 200 || body.errors || !body.data?.collections?.length) {
  console.error('Mesh smoke test failed:', JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log('Mesh OK: schema composed and resolvers live.');
