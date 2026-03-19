import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Shared Upstash Redis client (serverless-safe, HTTP-based)
//
// Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars.
// Falls back gracefully — callers should handle null returns.
// ---------------------------------------------------------------------------

let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}
