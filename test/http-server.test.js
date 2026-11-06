import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import {
  makeTempDir,
  postJson,
  registerUser,
  signUp,
  startProcess,
  startServer,
} from "./helpers.js";

// fetch() normalizes "../" before sending, so traversal needs a raw request.
function sendRaw(baseUrl, method, path) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname, port, method, path, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("sign in over HTTP", () => {
  it("registers, signs in and recognises the session", async (t) => {
    const { url } = await startServer(t);

    const { user, code } = await registerUser(url, "Анна");
    const login = await postJson(`${url}/api/login`, { code });
    const cookie = login.headers.get("set-cookie");
    const me = await fetch(`${url}/api/me`, {
      headers: { Cookie: cookie.split(";")[0] },
    });

    assert.equal(login.status, 200);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /Secure/);
    assert.deepEqual((await me.json()).user, user);
  });

  it("answers 401 without a session", async (t) => {
    const { url } = await startServer(t);

    const response = await fetch(`${url}/api/me`);

    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "unauthorized");
  });

  it("answers 401 to a wrong code", async (t) => {
    const { url } = await startServer(t);

    const response = await postJson(`${url}/api/login`, {
      code: "0000-0000-0000-0000",
    });

    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "invalid_code");
  });

  it("ends the session on logout", async (t) => {
    const { url } = await startServer(t);
    const { cookie } = await signUp(url, "Анна");

    const logout = await postJson(`${url}/api/logout`, {}, { Cookie: cookie });
    const me = await fetch(`${url}/api/me`, { headers: { Cookie: cookie } });

    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(me.status, 401);
  });

  it("keeps the account and the session after a restart", async (t) => {
    const first = await startServer(t);
    const { user, cookie } = await signUp(first.url, "Анна");
    first.child.kill("SIGTERM");
    await first.exited;

    const second = await startServer(t, { DATA_DIR: first.dataDir });
    const me = await fetch(`${second.url}/api/me`, {
      headers: { Cookie: cookie },
    });

    assert.deepEqual((await me.json()).user, user);
  });

  it("limits sign-in attempts to ten a minute", async (t) => {
    const { url } = await startServer(t);
    const attempt = () =>
      postJson(`${url}/api/login`, { code: "0000-0000-0000-0000" });

    for (let index = 0; index < 10; index += 1) {
      assert.equal((await attempt()).status, 401);
    }
    const blocked = await attempt();

    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  });

  it("limits registrations to ten a minute", async (t) => {
    const { url } = await startServer(t);
    const attempt = () => postJson(`${url}/api/register`, { name: "Анна" });

    for (let index = 0; index < 10; index += 1) {
      assert.equal((await attempt()).status, 201);
    }

    assert.equal((await attempt()).status, 429);
  });

  it("rejects a body that is not JSON", async (t) => {
    const { url } = await startServer(t);

    const response = await fetch(`${url}/api/login`, {
      method: "POST",
      body: "{ not json",
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_json");
  });

  it("rejects an oversized body", async (t) => {
    const { url } = await startServer(t);

    const response = await postJson(`${url}/api/register`, {
      name: "x".repeat(20 * 1024),
    });

    assert.equal(response.status, 413);
  });
});

describe("behind a proxy", () => {
  const signInFrom = (url, forwardedFor) =>
    postJson(
      `${url}/api/login`,
      { code: "0000-0000-0000-0000" },
      { "X-Forwarded-For": forwardedFor },
    );

  it("limits sign-in attempts by the address the proxy added", async (t) => {
    const { url } = await startServer(t, { TRUST_PROXY: "1" });

    // Entries before the last one are the client's own and change every time.
    for (let index = 0; index < 10; index += 1) {
      const response = await signInFrom(url, `10.0.0.${index}, 203.0.113.1`);
      assert.equal(response.status, 401);
    }

    assert.equal((await signInFrom(url, "203.0.113.1")).status, 429);
    assert.equal((await signInFrom(url, "203.0.113.2")).status, 401);
  });

  it("ignores X-Forwarded-For without TRUST_PROXY", async (t) => {
    const { url } = await startServer(t);

    for (let index = 0; index < 10; index += 1) {
      assert.equal((await signInFrom(url, `203.0.113.${index}`)).status, 401);
    }

    assert.equal((await signInFrom(url, "203.0.113.99")).status, 429);
  });

  it("marks the session cookie Secure", async (t) => {
    const { url } = await startServer(t, { TRUST_PROXY: "1" });
    const { code } = await registerUser(url, "Анна");

    const login = await postJson(`${url}/api/login`, { code });
    const session = login.headers.get("set-cookie").split(";")[0];
    const logout = await postJson(`${url}/api/logout`, {}, { Cookie: session });

    assert.match(login.headers.get("set-cookie"), /Secure/);
    assert.match(logout.headers.get("set-cookie"), /Secure/);
  });
});

describe("routing", () => {
  it("answers 404 to an unknown API path", async (t) => {
    const { url } = await startServer(t);

    const response = await fetch(`${url}/api/unknown`);

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "not_found");
  });

  it("answers 405 with the allowed methods", async (t) => {
    const { url } = await startServer(t);

    const response = await fetch(`${url}/api/login`);

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  });
});

describe("static files", () => {
  it("serves the page at the root path", async (t) => {
    const { url } = await startServer(t);

    const response = await fetch(url);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      response.headers.get("content-security-policy"),
      /default-src 'self'/,
    );
    assert.match(await response.text(), /<title>Мессенджер<\/title>/);
  });

  it("answers HEAD with headers only", async (t) => {
    const { url } = await startServer(t);

    const response = await sendRaw(url, "HEAD", "/index.html");

    assert.equal(response.status, 200);
    assert.ok(Number(response.headers["content-length"]) > 0);
    assert.equal(response.body, "");
  });

  it("does not accept writes", async (t) => {
    const { url } = await startServer(t);

    const response = await sendRaw(url, "POST", "/index.html");

    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "GET, HEAD");
  });

  it("refuses paths outside the public folder", async (t) => {
    const { url } = await startServer(t);
    const refusedPaths = [
      "/../package.json",
      "/../server/index.js",
      "/%2e%2e/package.json",
      "/..%2fpackage.json",
      "/%2E%2E%2Fpackage.json",
      "/..%5cpackage.json",
      "/.hidden",
      "/index.html%00.js",
      "/%E0%A4%A",
      "/missing.js",
    ];

    for (const path of refusedPaths) {
      const response = await sendRaw(url, "GET", path);

      assert.equal(response.status, 404, path);
      assert.doesNotMatch(response.body, /"scripts"|createServerFromEnv/, path);
    }
  });
});

describe("server process", () => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    it(`exits cleanly on ${signal}`, async (t) => {
      const server = await startServer(t);

      server.child.kill(signal);
      const [exitCode] = await server.exited;

      assert.equal(exitCode, 0);
      assert.match(server.output.stdout, /Messenger stopped/);
    });
  }

  it("explains the failure when the port is taken", async (t) => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    t.after(() => blocker.close());

    const server = startProcess(t, {
      PORT: String(blocker.address().port),
      DATA_DIR: (await startServer(t)).dataDir,
    });
    const [exitCode] = await server.exited;

    assert.equal(exitCode, 1);
    assert.match(server.output.stderr, /already in use/);
  });

  it("explains the failure when PORT is invalid", async (t) => {
    const server = startProcess(t, { PORT: "not-a-port" });
    const [exitCode] = await server.exited;

    assert.equal(exitCode, 1);
    assert.match(server.output.stderr, /PORT must be a number/);
  });

  it("explains the failure when TRUST_PROXY is invalid", async (t) => {
    const server = startProcess(t, {
      TRUST_PROXY: "yes",
      DATA_DIR: await makeTempDir(t),
    });
    const [exitCode] = await server.exited;

    assert.equal(exitCode, 1);
    assert.match(server.output.stderr, /TRUST_PROXY must be 1 or 0/);
  });
});
