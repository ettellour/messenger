import { once } from "node:events";
import { ServiceError } from "../errors.js";
import { readSessionToken } from "../http/sessionCookie.js";
import { CloseCode, computeAcceptKey } from "./frames.js";
import { WebSocketConnection } from "./WebSocketConnection.js";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_MISSED_PONGS = 2;
const WEBSOCKET_PATH = "/ws";
const STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  426: "Upgrade Required",
};

function refuseHandshake(socket, status, extraHeader = "") {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n` +
      `Connection: close\r\nContent-Length: 0\r\n${extraHeader}\r\n`,
  );
}

function isSameOrigin(req) {
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Returns the HTTP status to refuse with, or null if the request is fine.
function findHandshakeProblem(req) {
  const key = req.headers["sec-websocket-key"] ?? "";
  if (req.url.split("?", 1)[0] !== WEBSOCKET_PATH) {
    return 404;
  }
  if (req.method !== "GET" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    return 400;
  }
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    return 400;
  }
  if (req.headers["sec-websocket-version"] !== "13") {
    return 426;
  }
  // SameSite does not cover the handshake, so without this check any site could
  // open a socket with the visitor's cookie.
  return isSameOrigin(req) ? null : 403;
}

export class WebSocketServer {
  #auth;
  #chatService;
  #log;
  #clientsByUser = new Map();
  #pingTimer;

  constructor({
    auth,
    chatService,
    log = console.log,
    pingIntervalMs = 30_000,
  }) {
    this.#auth = auth;
    this.#chatService = chatService;
    this.#log = log;
    this.#pingTimer = setInterval(
      () => this.#checkConnections(),
      pingIntervalMs,
    );
    this.#pingTimer.unref();
  }

  async handleUpgrade(req, socket, earlyData) {
    socket.on("error", () => socket.destroy());

    const problem = findHandshakeProblem(req);
    if (problem) {
      refuseHandshake(
        socket,
        problem,
        problem === 426 ? "Sec-WebSocket-Version: 13\r\n" : "",
      );
      return;
    }

    let session;
    const token = readSessionToken(req);
    try {
      session = await this.#auth.findSession(token);
    } catch (error) {
      this.#log(`Handshake failed: ${error.stack}`);
      socket.destroy();
      return;
    }
    if (!session) {
      refuseHandshake(socket, 401);
      return;
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${computeAcceptKey(req.headers["sec-websocket-key"])}\r\n\r\n`,
    );

    const connection = new WebSocketConnection(socket, {
      maxPayload: MAX_FRAME_BYTES,
    });
    this.#addClient({
      connection,
      user: session.user,
      token,
      expiresAt: session.expiresAt,
      queue: Promise.resolve(),
    });
    connection.receiveEarlyData(earlyData);
  }

  sendToUser(userId, type, payload, exceptConnection) {
    const text = JSON.stringify({ type, payload });
    for (const { connection } of this.#clientsByUser.get(userId) ?? []) {
      if (connection !== exceptConnection) {
        connection.send(text);
      }
    }
  }

  closeSession(token) {
    for (const client of this.#allClients()) {
      if (client.token === token) {
        client.connection.close(CloseCode.POLICY_VIOLATION, "Signed out");
      }
    }
  }

  // Resolves once every client has gone, so the HTTP server can finish closing.
  async stop() {
    clearInterval(this.#pingTimer);
    const closed = [];
    for (const { connection } of this.#allClients()) {
      closed.push(once(connection, "close"));
      connection.close(CloseCode.GOING_AWAY, "Server is stopping");
    }
    await Promise.all(closed);
  }

  *#allClients() {
    for (const clients of this.#clientsByUser.values()) {
      yield* clients;
    }
  }

  #addClient(client) {
    const { connection, user } = client;
    const clients = this.#clientsByUser.get(user.id) ?? new Set();
    clients.add(client);
    this.#clientsByUser.set(user.id, clients);
    this.#log(`WebSocket connected: ${user.id}`);

    // Events of one connection run in order, so replies keep the order of sends.
    connection.on("message", (text) => {
      client.queue = client.queue.then(() => this.#handleEvent(client, text));
    });
    connection.on("close", () => {
      clients.delete(client);
      if (clients.size === 0) {
        this.#clientsByUser.delete(user.id);
      }
      this.#log(`WebSocket disconnected: ${user.id}`);
    });
  }

  #checkConnections() {
    const now = Date.now();
    for (const { connection, expiresAt, user } of this.#allClients()) {
      if (expiresAt <= now) {
        connection.close(CloseCode.POLICY_VIOLATION, "Session expired");
      } else if (connection.missedPongs >= MAX_MISSED_PONGS) {
        this.#log(`WebSocket stopped answering: ${user.id}`);
        connection.terminate();
      } else {
        connection.missedPongs += 1;
        connection.ping();
      }
    }
  }

  async #handleEvent(client, text) {
    let clientId;
    try {
      const { type, payload } = this.#parseEvent(text);
      clientId = payload.clientId;
      await this.#applyEvent(client, type, payload);
    } catch (error) {
      this.#reportEventFailure(client, error, clientId);
    }
  }

  #parseEvent(text) {
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      throw new ServiceError("invalid_event", "Event is not valid JSON");
    }
    if (typeof event?.payload !== "object" || event.payload === null) {
      throw new ServiceError("invalid_event", "Event has no payload");
    }
    return event;
  }

  async #applyEvent(client, type, payload) {
    switch (type) {
      case "message.send":
        await this.#sendMessage(client, payload);
        break;
      case "message.read":
        await this.#markRead(client, payload);
        break;
      case "connection.check":
        client.connection.send(
          JSON.stringify({ type: "connection.alive", payload: {} }),
        );
        break;
      default:
        throw new ServiceError("unknown_event", "Unknown event type");
    }
  }

  async #sendMessage({ connection, user }, payload) {
    const { message, created, memberIds } = await this.#chatService.sendMessage(
      user.id,
      payload,
    );
    connection.send(
      JSON.stringify({
        type: "message.sent",
        payload: { clientId: payload.clientId, message },
      }),
    );

    // A repeat is the sender retrying after a lost reply: everyone else has it.
    if (!created) {
      return;
    }
    for (const memberId of memberIds) {
      this.sendToUser(memberId, "message.new", { message }, connection);
      this.sendToUser(memberId, "chat.updated", {
        chat: await this.#chatService.getChat(message.chatId, memberId),
      });
    }
  }

  async #markRead({ user }, { chatId, messageId }) {
    const chat = await this.#chatService.markRead(user.id, chatId, messageId);
    this.sendToUser(user.id, "chat.updated", { chat });
  }

  #reportEventFailure({ connection, user }, error, clientId) {
    const expected = error instanceof ServiceError;
    if (!expected) {
      this.#log(`Event failed for ${user.id}: ${error.stack}`);
    }
    const payload = {
      code: expected ? error.code : "internal_error",
      message: expected ? error.message : "Internal server error",
      clientId,
    };
    connection.send(JSON.stringify({ type: "error", payload }));
  }
}
