import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateLimiter } from "../server/http/RateLimiter.js";

describe("RateLimiter", () => {
  it("allows attempts up to the limit and then says how long to wait", () => {
    let time = 0;
    const limiter = new RateLimiter({
      limit: 2,
      windowMs: 60_000,
      now: () => time,
    });

    assert.equal(limiter.hit("ip"), 0);
    assert.equal(limiter.hit("ip"), 0);
    time = 15_000;

    assert.equal(limiter.hit("ip"), 45);
  });

  it("allows attempts again once the window has passed", () => {
    let time = 0;
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 1000,
      now: () => time,
    });
    limiter.hit("ip");
    assert.ok(limiter.hit("ip") > 0);

    time = 1000;

    assert.equal(limiter.hit("ip"), 0);
  });

  it("counts every key separately", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
    limiter.hit("first");

    assert.equal(limiter.hit("second"), 0);
  });
});
