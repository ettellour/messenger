import { createServer } from "node:http";
import { open } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { SESSION_LIFETIME_MS } from "../auth/AuthService.js";
import { ServiceError } from "../errors.js";
import { RateLimiter } from "./RateLimiter.js";
import { Router } from "./Router.js";
import { buildSessionCookie, readSessionToken } from "./sessionCookie.js";

const MAX_JSON_BYTES = 16 * 1024;
const FORCE_CLOSE_AFTER_MS = 5000;
const ATTEMPTS_PER_MINUTE = 10;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const STATUS_BY_CODE = {
  body_too_large: 413,
  invalid_code: 401,
  unauthorized: 401,
};

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

function sendError(res, status, code, message, headers) {
  sendJson(res, status, { error: { code, message } }, headers);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw new ServiceError("body_too_large", "Request body is too large");
    }
    chunks.push(chunk);
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("invalid_json", "Request body is not valid JSON");
  }
  if (body === null || typeof body !== "object") {
    throw new ServiceError("invalid_json", "Request body must be an object");
  }
  return body;
}

export class Server {
  #http;
  #router = new Router();
  #publicDir;
  #auth;
  #sockets;
  #log;
  #loginAttempts;
  #registerAttempts;

  constructor({ auth, sockets, publicDir, log = console.log }) {
    this.#auth = auth;
    this.#sockets = sockets;
    this.#publicDir = resolve(publicDir);
    this.#log = log;

    const limit = { limit: ATTEMPTS_PER_MINUTE, windowMs: 60_000 };
    this.#loginAttempts = new RateLimiter(limit);
    this.#registerAttempts = new RateLimiter(limit);

    this.#http = createServer((req, res) => this.#handleRequest(req, res));
    this.#http.on("upgrade", (req, socket, earlyData) => {
      sockets.handleUpgrade(req, socket, earlyData);
    });
    this.#addRoutes();
  }

  listen(port, host) {
    return new Promise((resolvePromise, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(port, host, () => {
        this.#http.off("error", reject);
        const address = this.#http.address();
        resolvePromise(`http://${address.address}:${address.port}`);
      });
    });
  }

  async stop() {
    const httpClosed = new Promise((resolvePromise) => {
      const forceClose = setTimeout(
        () => this.#http.closeAllConnections(),
        FORCE_CLOSE_AFTER_MS,
      );
      this.#http.close(() => {
        clearTimeout(forceClose);
        resolvePromise();
      });
      this.#http.closeIdleConnections();
    });
    await Promise.all([this.#sockets.stop(), httpClosed]);
  }

  #addRoutes() {
    const routes = this.#router;
    routes.add("POST", "/api/register", (ctx) => this.#register(ctx));
    routes.add("POST", "/api/login", (ctx) => this.#login(ctx));
    routes.add("POST", "/api/logout", (ctx) => this.#logout(ctx));
    routes.add("GET", "/api/me", (ctx) => this.#getCurrentUser(ctx));
  }

  async #handleRequest(req, res) {
    const startedAt = Date.now();
    const queryStart = req.url.indexOf("?");
    const path = queryStart === -1 ? req.url : req.url.slice(0, queryStart);
    const query = new URLSearchParams(
      queryStart === -1 ? "" : req.url.slice(queryStart + 1),
    );

    res.on("finish", () => {
      const elapsed = Date.now() - startedAt;
      this.#log(`${req.method} ${path} ${res.statusCode} ${elapsed}ms`);
    });

    try {
      if (path === "/api" || path.startsWith("/api/")) {
        await this.#routeApiRequest(req, res, path, query);
      } else {
        await this.#serveStaticFile(req, res, path);
      }
    } catch (error) {
      this.#sendFailure(req, res, error);
    }
  }

  async #routeApiRequest(req, res, path, query) {
    const { handler, params, allowed } = this.#router.find(req.method, path);
    if (handler) {
      await handler({ req, res, params, query });
    } else if (allowed.length > 0) {
      sendError(res, 405, "method_not_allowed", "Method not allowed", {
        Allow: allowed.join(", "),
      });
    } else {
      sendError(res, 404, "not_found", "Not found");
    }
  }

  #sendFailure(req, res, error) {
    const expected = error instanceof ServiceError;
    if (!expected) {
      this.#log(`Request failed: ${error.stack}`);
    }
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }

    // Answering before the body was read leaves the rest of it on the socket,
    // so that connection cannot serve another request.
    const headers = req.complete ? {} : { Connection: "close" };
    if (expected) {
      const status = STATUS_BY_CODE[error.code] ?? 400;
      sendError(res, status, error.code, error.message, headers);
    } else {
      sendError(res, 500, "internal_error", "Internal server error", headers);
    }
  }

  #isOverLimit(limiter, { req, res }) {
    const retryAfter = limiter.hit(req.socket.remoteAddress);
    if (retryAfter > 0) {
      sendError(res, 429, "rate_limited", "Too many attempts", {
        "Retry-After": String(retryAfter),
      });
    }
    return retryAfter > 0;
  }

  async #requireUser(req) {
    const session = await this.#auth.findSession(readSessionToken(req));
    if (!session) {
      throw new ServiceError("unauthorized", "Sign in first");
    }
    return session.user;
  }

  async #register(ctx) {
    if (this.#isOverLimit(this.#registerAttempts, ctx)) {
      return;
    }
    const { name } = await readJsonBody(ctx.req);
    sendJson(ctx.res, 201, await this.#auth.register(name));
  }

  async #login(ctx) {
    if (this.#isOverLimit(this.#loginAttempts, ctx)) {
      return;
    }
    const { code } = await readJsonBody(ctx.req);
    const { user, token } = await this.#auth.login(code);
    sendJson(
      ctx.res,
      200,
      { user },
      { "Set-Cookie": buildSessionCookie(token, SESSION_LIFETIME_MS / 1000) },
    );
  }

  async #logout({ req, res }) {
    const token = readSessionToken(req);
    if (token) {
      await this.#auth.logout(token);
      this.#sockets.closeSession(token);
    }
    res.writeHead(204, { "Set-Cookie": buildSessionCookie("", 0) });
    res.end();
  }

  async #getCurrentUser({ req, res }) {
    sendJson(res, 200, { user: await this.#requireUser(req) });
  }

  async #serveStaticFile(req, res, path) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "method_not_allowed", "Method not allowed", {
        Allow: "GET, HEAD",
      });
      return;
    }

    const filePath = this.#resolvePublicPath(path);
    const file = filePath ? await this.#openPublicFile(filePath) : null;
    if (!file) {
      sendError(res, 404, "not_found", "Not found");
      return;
    }

    const contentType =
      CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": file.size,
      "Cache-Control": "no-cache",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
    });

    if (req.method === "HEAD") {
      await file.handle.close();
      res.end();
      return;
    }
    await this.#streamToClient(file.handle.createReadStream(), res);
  }

  async #streamToClient(stream, res) {
    try {
      await pipeline(stream, res);
    } catch (error) {
      if (error.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        throw error;
      }
    }
  }

  // Works on the still-encoded path on purpose: URL parsing would quietly
  // collapse "../" before it could be refused here.
  #resolvePublicPath(path) {
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (!decoded.startsWith("/") || /[\0\\]/.test(decoded)) {
      return null;
    }

    const segments = (decoded === "/" ? "/index.html" : decoded).split("/");
    if (segments.some((segment) => segment.startsWith("."))) {
      return null;
    }
    return join(this.#publicDir, ...segments);
  }

  async #openPublicFile(filePath) {
    let handle;
    try {
      handle = await open(filePath, "r");
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(error.code)) {
        return null;
      }
      throw error;
    }

    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return null;
    }
    return { handle, size: stats.size };
  }
}
