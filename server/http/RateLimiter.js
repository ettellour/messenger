export class RateLimiter {
  #limit;
  #windowMs;
  #now;
  #windows = new Map();
  #nextCleanupAt = 0;

  constructor({ limit, windowMs, now = Date.now }) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  // Returns how many seconds the caller has to wait, 0 if the attempt is allowed.
  hit(key) {
    const now = this.#now();
    this.#forgetExpiredWindows(now);

    let window = this.#windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { attempts: 0, resetAt: now + this.#windowMs };
      this.#windows.set(key, window);
    }

    window.attempts += 1;
    return window.attempts > this.#limit
      ? Math.ceil((window.resetAt - now) / 1000)
      : 0;
  }

  #forgetExpiredWindows(now) {
    if (now < this.#nextCleanupAt) {
      return;
    }
    this.#nextCleanupAt = now + this.#windowMs;
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) {
        this.#windows.delete(key);
      }
    }
  }
}
