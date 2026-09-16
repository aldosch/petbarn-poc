// GraphQL protection layer for the mesh gateway.
//
// Covers what Cloudflare API Shield's GraphQL protection covers (query depth
// and size limits, abusive-mutation blocking) natively in The Guild stack, and
// adds field-level rate limits, alias limits, schema-leak masking and
// structured block logs. Built for the card-testing scenario: bursts of
// low-value mutations from rotating IPs, which IP-based edge rules miss.
//
// References:
// - Hive Gateway security features:
//   https://the-guild.dev/graphql/hive/docs/gateway/other-features/security
// - GraphQL Armor (the same plugins Hive Gateway's own maxDepth/maxTokens use):
//   https://escape.tech/graphql-armor/docs
// - Cloudflare equivalent (for comparison):
//   https://developers.cloudflare.com/api-shield/security/graphql-protection/

import { GraphQLError } from 'graphql';
import { maxDepthPlugin } from '@escape.tech/graphql-armor-max-depth';
import { maxTokensPlugin } from '@escape.tech/graphql-armor-max-tokens';
import { maxAliasesPlugin } from '@escape.tech/graphql-armor-max-aliases';
import { costLimitPlugin } from '@escape.tech/graphql-armor-cost-limit';
import { blockFieldSuggestionsPlugin } from '@escape.tech/graphql-armor-block-field-suggestions';
import { useRateLimiting, LocalForageCacheStorage, RedisCacheStorage } from '@graphql-hive/gateway';

// ---------------------------------------------------------------------------
// Configuration. Every limit is env-tunable, so limits can be tuned
// against New Relic baselines without code changes.
// ---------------------------------------------------------------------------

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const securityConfig = {
  // Cloudflare parity: depth + size limits on incoming operations.
  maxDepth: num(process.env.MESH_MAX_DEPTH, 10),
  maxTokens: num(process.env.MESH_MAX_TOKENS, 1000),
  // Beyond Cloudflare: alias abuse, weighted cost, field-level quotas.
  maxAliases: num(process.env.MESH_MAX_ALIASES, 15),
  maxCost: num(process.env.MESH_MAX_COST, 5000),
  // Gateway-level mutation flood guard (the card-testing pattern: bursts of
  // low-value mutations from one identity, regardless of which field).
  mutationFlood: {
    max: num(process.env.MESH_MUTATION_FLOOD_MAX, 40),
    windowMs: num(process.env.MESH_MUTATION_FLOOD_WINDOW_MS, 60000)
  },
  // Field-level quotas. Production traffic should be tuned per environment;
  // these defaults map to the PoC checkout mutations.
  rateLimitedFields: [
    { type: 'Mutation', field: 'createCart', max: 5, ttl: 60000 },
    { type: 'Mutation', field: 'addToCart', max: 30, ttl: 60000 },
    { type: 'Mutation', field: 'updateCartLine', max: 30, ttl: 60000 },
    { type: 'Mutation', field: 'removeCartLine', max: 30, ttl: 60000 },
    { type: 'Mutation', field: 'placeOrder', max: 5, ttl: 60000 }
  ],
  // GraphiQL introspects the schema, so disabling breaks the playground.
  // Set MESH_DISABLE_INTROSPECTION=true in production deployments.
  introspectionDisabled: process.env.MESH_DISABLE_INTROSPECTION === 'true'
};

// ---------------------------------------------------------------------------
// Rate-limit state store. In-memory per gateway instance by default (fine for
// a single-instance PoC). On horizontally scaled/serverless deployments pass
// REDIS_URL so all instances share one counter store. Otherwise each
// instance gets its own quota (Hive documents the same caveat).
// ---------------------------------------------------------------------------

export function resolveRateLimitCache() {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    return new RedisCacheStorage({ url: redisUrl });
  }
  return new LocalForageCacheStorage();
}

const clientIpFrom = (context) => {
  const headers = context?.headers ?? {};
  const forwarded = headers['x-forwarded-for'];
  return forwarded?.split(',')[0]?.trim() || headers['x-real-ip'] || 'unknown';
};

const logEvent = (event, fields) => {
  console.log(JSON.stringify({ event, ...fields }));
};

// ---------------------------------------------------------------------------
// Custom Envelop plugin: client-IP context + mutation flood guard + structured
// operation logs. This piece has no direct Cloudflare equivalent:
// it sees the parsed operation AST, not just the raw body.
// ---------------------------------------------------------------------------

export function useOperationGuard({ max, windowMs }) {
  const buckets = new Map(); // identity -> { start, count }

  const sweepIfNeeded = () => {
    if (buckets.size < 10000) return;
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.start > windowMs) buckets.delete(key);
    }
  };

  return {
    // Makes the client IP available to other plugins as `context.clientIp`
    // (the field-level rate limiter uses it as its identity bucket).
    onContextBuilding({ context, extendContext }) {
      extendContext({ clientIp: clientIpFrom(context) });
    },

    // Runs on the parsed DocumentNode, before validation/execution: the
    // earliest point where the operation type is known.
    onParse() {
      return ({ context, result }) => {
        if (!result || result instanceof Error || !Array.isArray(result.definitions)) return;

        const operations = result.definitions.filter(
          (def) => def.kind === 'OperationDefinition'
        );
        if (operations.length === 0) return;

        const identity = clientIpFrom(context);
        const mutationCount = operations.filter((op) => op.operation === 'mutation').length;
        const operationName = operations.map((op) => op.name?.value ?? '<anonymous>').join(', ');
        const rootFields = operations.flatMap((op) =>
          op.selectionSet.selections
            .filter((sel) => sel.kind === 'Field')
            .map((sel) => sel.name.value)
        );

        const now = Date.now();
        let bucket = buckets.get(identity);
        if (!bucket || now - bucket.start > windowMs) {
          bucket = { start: now, count: 0 };
          buckets.set(identity, bucket);
        }
        sweepIfNeeded();
        bucket.count += mutationCount;
        const blocked = bucket.count > max;

        logEvent(blocked ? 'graphql.flood_blocked' : 'graphql.operation', {
          operationName,
          operationType: mutationCount > 0 ? 'mutation' : 'query',
          rootFields,
          clientIp: identity,
          mutationsInWindow: bucket.count,
          windowMs
        });

        if (blocked) {
          throw new GraphQLError('Too many mutation requests. Blocked by GraphQL protection.', {
            extensions: {
              code: 'GRAPHQL_MUTATION_FLOOD_BLOCKED',
              mutationsInWindow: bucket.count,
              windowMs
            }
          });
        }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function securityPlugins() {
  return [
    // Depth/size/complexity: the Cloudflare GraphQL protection parity set.
    maxDepthPlugin({ n: securityConfig.maxDepth }),
    maxTokensPlugin({ n: securityConfig.maxTokens }),
    maxAliasesPlugin({ n: securityConfig.maxAliases }),
    costLimitPlugin({ maxCost: securityConfig.maxCost }),
    // Don't leak the schema through "Did you mean" typo suggestions.
    blockFieldSuggestionsPlugin(),
    // Per-field mutation quotas (needs shared store when horizontally scaled).
    useRateLimiting({
      config: securityConfig.rateLimitedFields.map((field) => ({
        ...field,
        identifier: '{context.clientIp}'
      })),
      cache: resolveRateLimitCache()
    }),
    // Gateway-level mutation flood guard + operation logging.
    useOperationGuard(securityConfig.mutationFlood)
  ];
}

export function gatewaySecurityOptions() {
  return {
    // Weighted cost ceiling; mutations carry a base cost of 10 by default.
    // Add @cost/@listSize directives to the schema to model expensive fields.
    demandControl: {
      maxCost: securityConfig.maxCost,
      listSize: 100
    },
    // Reject form-style content types. GraphQL clients POST application/json.
    csrfPrevention: true,
    // Don't leak resolver internals to clients (gateway default, made explicit).
    maskedErrors: true,
    ...(securityConfig.introspectionDisabled ? { disableIntrospection: {} } : {})
  };
}
