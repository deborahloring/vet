// Worker entry point (wrangler.jsonc "main"). No PDF parsing, no file access, and no
// model calls happen here; invoice data is bundled at build time.

import { productionDependencies } from './api/dependencies.ts';
import { handleRequest } from './api/router.ts';
import type { Env } from './env.ts';

export { DeskState } from './desk-state.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, productionDependencies(env));
  },
};
