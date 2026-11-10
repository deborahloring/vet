// The approved Gemini model and request limits.
//
// Owner-confirmed AI Studio configuration (free tier, no billing): Gemini 3.5 Flash Lite,
// 15 requests/minute, 250,000 tokens/minute, 500 requests/day. The identifier below must be
// confirmed against the project's model list before the first live request; any other
// value in GEMINI_MODEL fails closed rather than silently substituting a model.

export const APPROVED_GEMINI_MODELS = ['gemini-3.5-flash-lite'] as const;
export type GeminiModel = (typeof APPROVED_GEMINI_MODELS)[number];

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const GEMINI_LIMITS = {
  /** One request per review; no automatic retry. */
  requestsPerReview: 1,
  timeoutMs: 15_000,
  maxOutputTokens: 1024,
  /** Upper bound on the prompt text sent (system + invoice + notes), in characters. */
  maxPromptChars: 12_000,
  maxNotesChars: 1_200,
  maxLines: 10,
  /** Upper bound on the model's JSON reply, in characters. */
  maxResponseChars: 16_000,
  maxFindingsPerList: 12,
  maxExcerptChars: 300,
} as const;

export function isApprovedModel(value: string): value is GeminiModel {
  return (APPROVED_GEMINI_MODELS as readonly string[]).includes(value);
}

export function generateContentUrl(model: GeminiModel): string {
  return `${GEMINI_API_BASE}/models/${model}:generateContent`;
}
