import { createGatewayRuntime } from '@graphql-hive/gateway';
import httpTransport from '@graphql-mesh/transport-http';
import { supergraph } from './generated/supergraph.mjs';
import { carts, collections, findProduct, orders, products, storeLocations } from './data.mjs';
import { searchProducts, findProductByUrlKey } from './magento.mjs';
import { gatewaySecurityOptions, securityConfig, securityPlugins } from './security.mjs';

const resolveCartLines = async (cart) =>
  Promise.all(
    cart.lines.map(async (line) => {
      const product = await resolveProduct(line.handle);
      return {
        ...line,
        product,
        productPrice: product?.price ?? 0,
        cost: (product?.price ?? 0) * line.quantity
      };
    })
  );

const cartCost = (cart) => cart.lines.reduce((sum, line) => sum + (line.productPrice ?? 0) * line.quantity, 0);

// Real catalog first (staging M2), local demo data as the fallback so
// the POC keeps working when staging is down or auth isn't configured.
const resolveProduct = async (handle) =>
  (await findProductByUrlKey(handle).catch(() => null)) ?? findProduct(handle) ?? null;

const listProducts = async (collection) => {
  const live = await searchProducts().catch(() => []);
  const handles = new Set(live.map((p) => p.handle));
  // local demo inventory fills gaps (e.g. fish) and covers staging outages
  const merged = [...live, ...products.filter((p) => !handles.has(p.handle))];
  return collection ? merged.filter((p) => p.collection === collection) : merged;
};

export const gateway = createGatewayRuntime({
  supergraph,
  graphqlEndpoint: '/api/graphql',
  transports: {
    http: httpTransport
  },
  // GraphQL protection layer: see lib/security.mjs and README.
  ...gatewaySecurityOptions(),
  plugins: () => securityPlugins(),
  additionalTypeDefs: /* GraphQL */ `
    type Product {
      id: ID!
      handle: String!
      title: String!
      description: String!
      price: Float!
      currency: String!
      image: String
      collection: String!
      availableForSale: Boolean!
    }

    type Collection {
      handle: String!
      title: String!
    }

    type CartLine {
      id: ID!
      handle: String!
      quantity: Int!
      product: Product!
      cost: Float!
    }

    type Cart {
      id: ID!
      lines: [CartLine!]!
      totalQuantity: Int!
      cost: Float!
    }

    type OrderLine {
      handle: String!
      quantity: Int!
    }

    type Order {
      id: ID!
      email: String!
      total: Float!
      lines: [OrderLine!]!
      createdAt: String!
    }

    type StoreLocation {
      code: ID!
      city: String!
      postcode: String!
      countryName: String!
      countryFlag: String!
    }

    extend type Query {
      products(collection: String): [Product!]!
      product(handle: String!): Product
      collections: [Collection!]!
      cart(id: ID!): Cart
      order(id: ID!): Order
      storeLocations: [StoreLocation!]!
    }

    type Mutation {
      createCart: Cart!
      addToCart(cartId: ID!, handle: String!, quantity: Int!): Cart!
      updateCartLine(cartId: ID!, lineId: ID!, quantity: Int!): Cart
      removeCartLine(cartId: ID!, lineId: ID!): Cart
      placeOrder(cartId: ID!, email: String!): Order!
    }
  `,
  additionalResolvers: {
    Query: {
      products: (_root, args) => listProducts(args.collection),
      product: (_root, args) => resolveProduct(String(args.handle)),
      collections: () => collections,
      cart: (_root, args) => carts.get(String(args.id)) ?? null,
      order: (_root, args) => orders.get(String(args.id)) ?? null,
      storeLocations: () =>
        // Aggregation across sources: resolve store details from the Countries
        // subgraph API rather than duplicating them in this store.
        Promise.all(
          storeLocations.map(async (location) => {
            const res = await fetch('https://countries.trevorblades.com/graphql', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                query: 'query($code: ID!) { country(code: $code) { name emoji } }',
                variables: { code: location.code }
              })
            });
            const { data } = await res.json();
            return {
              ...location,
              countryName: data?.country?.name ?? location.code,
              countryFlag: data?.country?.emoji ?? ''
            };
          })
        )
    },
    Mutation: {
      createCart: () => {
        const cart = {
          id: `cart_${Math.random().toString(36).slice(2, 10)}`,
          lines: [],
          createdAt: Date.now()
        };
        carts.set(cart.id, cart);
        return cart;
      },
      addToCart: async (_root, args) => {
        const cart = carts.get(String(args.cartId));
        if (!cart) throw new Error(`Cart not found: ${args.cartId}`);
        if (!(await resolveProduct(String(args.handle)))) throw new Error(`Unknown product: ${args.handle}`);
        const existing = cart.lines.find((line) => line.handle === args.handle);
        if (existing) {
          existing.quantity += args.quantity;
        } else {
          cart.lines.push({
            id: `line_${Math.random().toString(36).slice(2, 10)}`,
            handle: String(args.handle),
            quantity: args.quantity
          });
        }
        return cart;
      },
      updateCartLine: (_root, args) => {
        const cart = carts.get(String(args.cartId));
        if (!cart) return null;
        const line = cart.lines.find((l) => l.id === args.lineId);
        if (!line) return null;
        if (args.quantity <= 0) {
          cart.lines = cart.lines.filter((l) => l.id !== args.lineId);
        } else {
          line.quantity = args.quantity;
        }
        return cart;
      },
      removeCartLine: (_root, args) => {
        const cart = carts.get(String(args.cartId));
        if (!cart) return null;
        cart.lines = cart.lines.filter((l) => l.id !== args.lineId);
        return cart;
      },
      placeOrder: async (_root, args) => {
        const cart = carts.get(String(args.cartId));
        if (!cart) throw new Error(`Cart not found: ${args.cartId}`);
        if (cart.lines.length === 0) throw new Error('Cart is empty');
        const lines = await Promise.all(
          cart.lines.map(async (line) => ({
            handle: line.handle,
            quantity: line.quantity,
            productPrice: (await resolveProduct(line.handle))?.price ?? 0
          }))
        );
        const order = {
          id: `ord_${Math.random().toString(36).slice(2, 10)}`,
          email: String(args.email),
          lines: lines.map(({ handle, quantity }) => ({ handle, quantity })),
          total: lines.reduce((sum, line) => sum + line.productPrice * line.quantity, 0),
          createdAt: new Date().toISOString()
        };
        orders.set(order.id, order);
        carts.delete(cart.id);
        return order;
      }
    },
    Cart: {
      totalQuantity: (cart) => cart.lines.reduce((sum, line) => sum + line.quantity, 0),
      lines: (cart) => resolveCartLines(cart),
      cost: async (cart) => cartCost({ ...cart, lines: await resolveCartLines(cart) })
    }
  },
  cors: {
    origin: ['*']
  }
});

// One structured line per cold start so staging/prod logs prove which build
// and which protection limits are live.
console.log(JSON.stringify({ event: 'graphql.protection_config', ...securityConfig }));
