import { createServer } from 'node:http';
import { gateway } from './lib/gateway.mjs';

const port = Number(process.env.PORT ?? 4000);

createServer(gateway).listen(port, () => {
  console.log(`Mesh ready at http://localhost:${port}/api/graphql`);
});
