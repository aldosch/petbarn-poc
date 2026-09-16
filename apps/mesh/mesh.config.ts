// Compose configuration. Follows https://the-guild.dev/graphql/mesh/v1/getting-started
//
// The supergraph is composed from the Countries subgraph (the getting-started
// example source). Ecommerce types and resolvers are added at runtime in
// gateway.ts, keeping composition fast and network-free except for this one
// public endpoint.
//
// Run `pnpm generate` to regenerate lib/generated/supergraph.{graphql,ts}.
// The output is committed so builds never need network access.
import { defineConfig, loadGraphQLHTTPSubgraph } from '@graphql-mesh/compose-cli';

export const composeConfig = defineConfig({
  subgraphs: [
    {
      sourceHandler: loadGraphQLHTTPSubgraph('Countries', {
        endpoint: 'https://countries.trevorblades.com/graphql'
      })
    }
  ]
});
