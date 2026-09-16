// In-memory catalog, cart and order store. Resets on redeploy, fine for a
// POC. Swap the additionalResolvers in gateway.mjs for real source handlers
// (JSON Schema, OpenAPI, gRPC, SQL, ...) to point this at live systems.

const img = (seed) => `https://picsum.photos/seed/${seed}/800/800`;

export const products = [
  {
    id: 'p-001',
    handle: 'wildwise-kibble-beef-12kg',
    title: 'WildWise Kibble - Beef 12kg',
    description: 'Grain-free dry food for adult dogs, free-run beef, single protein.',
    price: 89.0,
    currency: 'AUD',
    image: img('dog-kibble'),
    collection: 'dog',
    availableForSale: true
  },
  {
    id: 'p-002',
    handle: 'fetchtoy-rope-tough',
    title: 'FetchToy Rope - Tough',
    description: 'Braided cotton rope toy for aggressive chewers.',
    price: 18.5,
    currency: 'AUD',
    image: img('dog-rope'),
    collection: 'dog',
    availableForSale: true
  },
  {
    id: 'p-003',
    handle: 'purrfect-litter-clumping-10l',
    title: 'Purrfect Litter - Clumping 10L',
    description: 'Bentonite clumping litter, low dust, high absorbency.',
    price: 24.0,
    currency: 'AUD',
    image: img('cat-litter'),
    collection: 'cat',
    availableForSale: true
  },
  {
    id: 'p-004',
    handle: 'purrfect-tunnel-mega',
    title: 'Purrfect Tunnel - Mega',
    description: 'Collapsible play tunnel with crinkle lining and plush ends.',
    price: 39.9,
    currency: 'AUD',
    image: img('cat-tunnel'),
    collection: 'cat',
    availableForSale: true
  },
  {
    id: 'p-005',
    handle: 'reefkit-nano-40l',
    title: 'ReefKit Nano - 40L',
    description: 'All-in-one nano aquarium with filtration and LED lighting.',
    price: 249.0,
    currency: 'AUD',
    image: img('aquarium'),
    collection: 'fish',
    availableForSale: true
  },
  {
    id: 'p-006',
    handle: 'tropical-flakes-50g',
    title: 'Tropical Flakes - 50g',
    description: 'Colour-enhancing daily flakes for tropical community fish.',
    price: 12.9,
    currency: 'AUD',
    image: img('fish-flakes'),
    collection: 'fish',
    availableForSale: false
  },
  {
    id: 'p-007',
    handle: 'featherwand-deluxe',
    title: 'FeatherWand - Deluxe',
    description: 'Telescopic wand with replaceable feather teasers.',
    price: 16.0,
    currency: 'AUD',
    image: img('cat-wand'),
    collection: 'cat',
    availableForSale: true
  },
  {
    id: 'p-008',
    handle: 'trailpup-harness-reflective',
    title: 'TrailPup Harness - Reflective',
    description: 'Padded no-pull harness with 3M reflective stitching.',
    price: 54.5,
    currency: 'AUD',
    image: img('dog-harness'),
    collection: 'dog',
    availableForSale: true
  }
];

export const collections = [
  { handle: 'dog', title: 'Dog' },
  { handle: 'cat', title: 'Cat' },
  { handle: 'fish', title: 'Fish' }
];

export const storeLocations = [
  { code: 'AU', city: 'Melbourne', postcode: '3000' },
  { code: 'AU', city: 'Sydney', postcode: '2000' },
  { code: 'NZ', city: 'Auckland', postcode: '1010' }
];

export const carts = new Map();
export const orders = new Map();

export const findProduct = (handle) => products.find((p) => p.handle === handle);
