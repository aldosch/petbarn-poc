// Vercel Node Function. The gateway runtime is a standard Node HTTP handler.
import { gateway } from '../lib/gateway.mjs';

export default function handler(req, res) {
  return gateway(req, res);
}
