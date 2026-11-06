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
  "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const STATUS_BY_CODE = {
  body_too_large: 413,
  chat_not_found: 404,
  file_not_found: 404,
  file_too_large: 413,
  invalid_code: 401,
  unauthorized: 401,
  user_not_found: 404,
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

function decodeFileName(headerValue = "") {
  try {
    return decodeURIComponent(headerValue);
  } catch {
    throw new ServiceError("invalid_file_name", "File name is not encoded");
  }
}

function buildAttachmentHeader(fileName) {
  const asciiName = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encodedName = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

// The proxy appends the address it saw to X-Forwarded-For. Entries before it
// come from the client and can be anything, so only the last one counts.
function readClientAddress(req, trustProxy) {
  if (trustProxy) {
    const lastEntry = req.headers["x-forwarded-for"]?.split(",").at(-1).trim();
    if (lastEntry) {
      return lastEntry;
    }
  }
  return req.socket.remoteAddress;
}

function parseCursor(value) {
  if (value === null) {
    return undefined;
  }
  if (!/^\d{1,16}$/.test(value)) {
    throw new ServiceError("invalid_cursor", "Cursor must be a message id");
  }
  return Number(value);
}

export class Server {
  #http;
  #router = new Router();
  #publicDir;
  #auth;
  #chatService;
  #fileService;
  #sockets;
  #trustProxy;
  #log;
  #loginAttempts;
  #registerAttempts;

  constructor({
    auth,
    chatService,
    fileService,
    sockets,
    publicDir,
    trustProxy = false,
    log = console.log,
  }) {
    this.#auth = auth;
    this.#chatService = chatService;
    this.#fileService = fileService;
    this.#sockets = sockets;
    this.#publicDir = resolve(publicDir);
    this.#trustProxy = trustProxy;
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
    routes.add("GET", "/api/chats", (ctx) => this.#listChats(ctx));
    routes.add("POST", "/api/chats", (ctx) => this.#openChat(ctx));
    routes.add("GET", "/api/chats/:id/messages", (ctx) =>
      this.#getMessages(ctx),
    );
    routes.add("PUT", "/api/files", (ctx) => this.#uploadFile(ctx));
    routes.add("GET", "/api/files/:id", (ctx) => this.#downloadFile(ctx));
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
    const clientLeft = req.destroyed && !req.complete;
    if (!expected && !clientLeft) {
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
    const retryAfter = limiter.hit(readClientAddress(req, this.#trustProxy));
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
    // Only the HTTPS proxy is trusted, so the cookie never needs plain HTTP.
    const cookie = buildSessionCookie(token, SESSION_LIFETIME_MS / 1000, {
      secure: this.#trustProxy,
    });
    sendJson(ctx.res, 200, { user }, { "Set-Cookie": cookie });
  }

  async #logout({ req, res }) {
    const token = readSessionToken(req);
    if (token) {
      await this.#auth.logout(token);
      this.#sockets.closeSession(token);
    }
    res.writeHead(204, {
      "Set-Cookie": buildSessionCookie("", 0, { secure: this.#trustProxy }),
    });
    res.end();
  }

  async #getCurrentUser({ req, res }) {
    sendJson(res, 200, { user: await this.#requireUser(req) });
  }

  async #listChats({ req, res }) {
    const user = await this.#requireUser(req);
    sendJson(res, 200, { chats: await this.#chatService.listChats(user.id) });
  }

  async #openChat({ req, res }) {
    const user = await this.#requireUser(req);
    const { peerId } = await readJsonBody(req);
    const { chat, created } = await this.#chatService.findOrCreateChat(
      user.id,
      peerId,
    );
    sendJson(res, created ? 201 : 200, { chat });
  }

  async #getMessages({ req, res, params, query }) {
    const user = await this.#requireUser(req);
    const history = await this.#chatService.getHistory(params.id, user.id, {
      before: parseCursor(query.get("before")),
      after: parseCursor(query.get("after")),
    });
    sendJson(res, 200, history);
  }

  async #uploadFile({ req, res }) {
    const user = await this.#requireUser(req);
    const file = await this.#fileService.saveUpload({
      uploadedBy: user.id,
      name: decodeFileName(req.headers["x-file-name"]),
      declaredSize: Number(req.headers["content-length"] ?? 0),
      content: req,
    });
    sendJson(res, 201, { file });
  }

  async #downloadFile({ req, res, params }) {
    const user = await this.#requireUser(req);
    const { file, content } = await this.#fileService.openForDownload(
      params.id,
      user.id,
    );
    // Always a download and never sniffed, otherwise an uploaded HTML file would
    // open as a page on this origin and could act as the signed-in visitor.
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": file.size,
      "Content-Disposition": buildAttachmentHeader(file.name),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    await this.#streamToClient(content, res);
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
