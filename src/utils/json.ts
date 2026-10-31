/** Narrowing for parsed JSON from outside: the registry and lockfiles. */

export type JsonObject = Record<string, unknown>;

export const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
