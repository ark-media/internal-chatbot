import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

let limiter: Ratelimit | null = null;

function getLimiter(): Ratelimit | null {
  if (limiter) return limiter;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  limiter = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(20, '1 m'),
    prefix: 'ark-chat',
  });
  return limiter;
}

export async function checkRateLimit(identifier: string): Promise<{ ok: boolean; remaining: number }> {
  const rl = getLimiter();
  if (!rl) return { ok: true, remaining: Infinity };
  try {
    const res = await rl.limit(identifier);
    return { ok: res.success, remaining: res.remaining };
  } catch (e) {
    console.warn('rate-limit: upstash error, failing open:', e);
    return { ok: true, remaining: Infinity };
  }
}
