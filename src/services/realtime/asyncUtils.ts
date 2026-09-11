/**
 * Async orchestration utilities for the scraping cycle (reviewer: never fire 151
 * requests at once — bounded concurrency, timeouts, retry with backoff + jitter).
 * `sleep`/`rng` are injectable so the retry math is deterministic under test.
 */

/** Run `worker` over `items` with at most `concurrency` in flight; order preserved. */
export async function mapWithConcurrency<T, R>(items: T[], worker: (item: T, index: number) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: lanes }, run));
  return results;
}

export interface RetryOptions {
  retries: number; // additional attempts after the first
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with optional full jitter; deterministic given rng. */
export function backoffDelay(attempt: number, opts: RetryOptions): number {
  const raw = Math.min(opts.maxDelayMs, opts.baseDelayMs * Math.pow(2, attempt));
  if (!opts.jitter) return raw;
  const rng = opts.rng ?? Math.random;
  return Math.floor(raw * (0.5 + 0.5 * rng())); // full-ish jitter in [0.5, 1.0]×raw
}

/** Retry `fn` up to `retries` extra times with backoff. Rethrows the last error. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === opts.retries) break;
      await sleep(backoffDelay(attempt, opts));
    }
  }
  throw lastErr;
}

/** Schedules `cb` after `ms`, returning a cancel fn. Real timers by default;
 *  injectable so a test can make timeouts fire (or never fire) deterministically. */
export type Scheduler = (ms: number, cb: () => void) => () => void;
const realScheduler: Scheduler = (ms, cb) => {
  const h = setTimeout(cb, ms);
  return () => clearTimeout(h);
};

/** Reject if `p` doesn't settle within `ms`. The timer is ALWAYS cancelled once
 *  `p` settles, so no dangling handle keeps the process (or Jest) alive. */
export function withTimeout<T>(p: Promise<T>, ms: number, scheduler: Scheduler = realScheduler): Promise<T> {
  let cancel = (): void => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    cancel = scheduler(ms, () => reject(new Error(`timeout after ${ms}ms`)));
  });
  return Promise.race([p, timeout]).finally(() => cancel());
}
