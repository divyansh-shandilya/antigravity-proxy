/**
 * Request Queue & Upstream Mutex
 * 
 * Strictly serializes outgoing requests to Google Antigravity backend to prevent:
 * 1. Concurrency limit collisions (Google rejects simultaneous requests from the same OAuth account)
 * 2. Thundering herd retry storms when clients (like Claude Desktop) fire multiple parallel requests
 * 3. Cascading 429s by enforcing a cool-down across all queued requests
 */

import { createLogger } from '../lib/logger.js';

const log = createLogger('request-queue');

export interface QueueOptions {
  minIntervalMs?: number;
}

export class RequestQueue {
  private chain: Promise<void> = Promise.resolve();
  private minIntervalMs: number;
  private lastRequestTime = 0;
  private waitingCount = 0;

  constructor(options: QueueOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 250;
  }

  /**
   * Acquire a slot in the queue.
   * Guarantees strict FIFO execution and at least minIntervalMs spacing.
   */
  async acquire(): Promise<() => void> {
    this.waitingCount++;
    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const previousChain = this.chain;
    this.chain = this.chain.then(() => lockAcquired);

    await previousChain;
    this.waitingCount = Math.max(0, this.waitingCount - 1);

    // Enforce spacing between upstream request handshakes
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    if (timeSinceLast < this.minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - timeSinceLast));
    }
    this.lastRequestTime = Date.now();

    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.lastRequestTime = Date.now();
        releaseLock();
      }
    };
  }

  /**
   * Executes an async operation with queue protection and automatic retry with jittered backoff on 429
   */
  async execute(
    fn: () => Promise<Response>,
    context: { model: string; maxRetries?: number } = { model: 'unknown' }
  ): Promise<Response> {
    const maxRetries = context.maxRetries ?? 4;
    let attempt = 0;

    while (true) {
      const release = await this.acquire();

      try {
        log.debug('Dispatching serialized upstream request', {
          model: context.model,
          attempt: attempt + 1,
          waitingRemaining: this.waitingCount,
        });

        const response = await fn();

        // If response is NOT 429, release lock and return immediately
        if (response.status !== 429) {
          release();
          return response;
        }

        // Upstream returned 429
        attempt++;
        if (attempt > maxRetries) {
          log.warn('Max retries exceeded for upstream 429', {
            model: context.model,
            attempts: attempt,
          });
          release();
          return response;
        }

        // Parse retry-after if provided by upstream
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 0;

        // Jittered exponential backoff
        const baseDelayMs = retryAfterSec > 0
          ? retryAfterSec * 1000
          : Math.min(1500 * Math.pow(1.8, attempt - 1), 6000);
        const jitterMs = Math.floor(Math.random() * 800);
        const delayMs = baseDelayMs + jitterMs;

        log.warn(`Upstream 429 received, cooling down for ${delayMs}ms before retry (${attempt}/${maxRetries})...`, {
          model: context.model,
          delayMs,
          waitingRemaining: this.waitingCount,
        });

        // Hold the lock during cooldown so queued requests don't hit the active rate-limit window
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        release();
      } catch (err) {
        release();
        throw err;
      }
    }
  }

  getWaitingCount(): number {
    return this.waitingCount;
  }
}

// Singleton queue for serializing Google Antigravity backend calls
export const upstreamQueue = new RequestQueue({
  minIntervalMs: 250,
});
