// Worker bindings from wrangler.jsonc. Minimal local interfaces are declared here because
// @cloudflare/workers-types is not installed; only the members this Worker uses are listed.

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface Env {
  ASSETS?: AssetFetcher;
  DESK?: DurableObjectNamespaceLike;
  /** "true" opens live reviews; anything else keeps them closed. */
  DESK_OPEN?: string;
  VISITOR_DAILY_LIMIT?: string;
  SHARED_DAILY_LIMIT?: string;
  RECORDING_URL?: string;
  /** Approved Gemini model identifier; see src/gemini/model.ts. */
  GEMINI_MODEL?: string;
  /** Secrets (uploaded with --secrets-file). Not used until Steps 3 and 4. */
  GEMINI_API_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAIL?: string;
}
