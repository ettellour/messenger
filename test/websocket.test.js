import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CloseCode } from "../server/ws/frames.js";
import { WebSocketServer } from "../server/ws/WebSocketServer.js";
import { maskedFrame } from "./helpers.js";

const USER = { id: "ANNA0000", name: "Анна" };
const CLIENT_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

async function startSocketServer(t, options = {}) {
  const auth = {
    findSession: async (token) =>
      token === "good" ? { user: USER, expiresAt: Infinity } : null,
  };
  const sockets = new WebSocketServer({ auth, log: () => {}, ...options });
  const http = createServer();
  http.on("upgrade", (req, socket, head) => {
    sockets.handleUpgrade(req, socket, head);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");

  const { port } = http.address();
  t.after(async () => {
    await sockets.stop();
    http.close();
  });
  return { sockets, port };
}

function handshakeRequest(port, overrides = {}) {
  const headers = {
    Host: `127.0.0.1:${port}`,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": CLIENT_KEY,
    "Sec-WebSocket-Version": "13",
    Origin: `http://127.0.0.1:${port}`,
    Cookie: "sid=good",
    ...overrides,
  };
  const lines = Object.entries(headers)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}: ${value}`);
  return `GET ${overrides.path ?? "/ws"} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
}

// A hand-driven client, for what a well-behaved WebSocket refuses to send.
async function openRawClient(t, port, overrides) {
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  socket.on("error", () => {});

  const client = {
    socket,
    received: Buffer.alloc(0),
    ended: once(socket, "close"),
  };
  socket.on("data", (chunk) => {
    client.received = Buffer.concat([client.received, chunk]);
  });
  await once(socket, "connect");
  socket.write(handshakeRequest(port, overrides));

  while (!client.received.includes("\r\n\r\n")) {
    await once(socket, "data");
  }
  return client;
}

function readStatus(client) {
  return Number(client.received.toString().split(" ")[1]);
}

function bytesAfterHandshake(client) {
  const end = client.received.indexOf("\r\n\r\n") + 4;
  return client.received.subarray(end);
}

async function waitForCloseCode(client) {
  while (bytesAfterHandshake(client).length < 4) {
    await once(client.socket, "data");
  }
  const frame = bytesAfterHandshake(client);
  assert.equal(frame[0], 0x88);
  return frame.readUInt16BE(2);
}

function openClient(t, port, headers = {}) {
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: {
      Origin: `http://127.0.0.1:${port}`,
      Cookie: "sid=good",
      ...headers,
    },
  });
  t.after(() => client.close());
  return client;
}

describe("WebSocket handshake", () => {
  it("accepts a real client", async (t) => {
    const { port } = await startSocketServer(t);

    const client = openClient(t, port);
    await once(client, "open");

    assert.equal(client.readyState, WebSocket.OPEN);
  });

  it("answers with the accept key from the RFC", async (t) => {
    const { port } = await startSocketServer(t);

    const client = await openRawClient(t, port);

    assert.equal(readStatus(client), 101);
    assert.match(
      client.received.toString(),
      /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/,
    );
  });

  const refusals = [
    ["no session", { Cookie: null }, 401],
    ["an unknown session", { Cookie: "sid=stolen" }, 401],
    ["another site", { Origin: "https://evil.example" }, 403],
    ["a missing Origin", { Origin: null }, 403],
    ["a broken Origin", { Origin: "not a url" }, 403],
    ["another protocol version", { "Sec-WebSocket-Version": "8" }, 426],
    ["a broken key", { "Sec-WebSocket-Key": "short" }, 400],
    ["another path", { path: "/other" }, 404],
  ];

  for (const [name, overrides, status] of refusals) {
    it(`refuses ${name}`, async (t) => {
      const { port } = await startSocketServer(t);

      const client = await openRawClient(t, port, overrides);
      await client.ended;

      assert.equal(readStatus(client), status);
    });
  }
});

describe("WebSocket frames", () => {
  const violations = [
    ["a binary frame", Buffer.from([1, 2]), 0x82, CloseCode.UNSUPPORTED_DATA],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe]), 0x81, CloseCode.INVALID_TEXT],
    ["a fragment", Buffer.from("x"), 0x01, CloseCode.UNSUPPORTED_DATA],
    ["an unknown opcode", Buffer.from("x"), 0x83, CloseCode.PROTOCOL_ERROR],
  ];

  for (const [name, payload, firstByte, closeCode] of violations) {
    it(`closes the connection on ${name}`, async (t) => {
      const { port } = await startSocketServer(t);
      const client = await openRawClient(t, port);

      client.socket.write(maskedFrame(firstByte, payload));

      assert.equal(await waitForCloseCode(client), closeCode);
    });
  }

  it("closes the connection on an unmasked frame", async (t) => {
    const { port } = await startSocketServer(t);
    const client = await openRawClient(t, port);

    client.socket.write(Buffer.from([0x81, 0x01, 0x78]));

    assert.equal(await waitForCloseCode(client), CloseCode.PROTOCOL_ERROR);
  });

  it("closes the connection on an oversized frame before reading it", async (t) => {
    const { port } = await startSocketServer(t);
    const client = await openRawClient(t, port);

    client.socket.write(Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 1, 0, 1]));

    assert.equal(await waitForCloseCode(client), CloseCode.TOO_BIG);
  });

  it("reassembles a frame that arrives byte by byte", async (t) => {
    const { port } = await startSocketServer(t);
    const client = await openRawClient(t, port);
    const event = JSON.stringify({ type: "nope", payload: {} });

    for (const byte of maskedFrame(0x81, Buffer.from(event))) {
      client.socket.write(Buffer.from([byte]));
      await delay(1);
    }

    while (!bytesAfterHandshake(client).includes("unknown_event")) {
      await once(client.socket, "data");
    }
  });

  it("answers a ping with a pong carrying the same data", async (t) => {
    const { port } = await startSocketServer(t);
    const client = await openRawClient(t, port);

    client.socket.write(maskedFrame(0x89, Buffer.from("Hello")));

    while (bytesAfterHandshake(client).length < 7) {
      await once(client.socket, "data");
    }
    assert.deepEqual(
      bytesAfterHandshake(client),
      Buffer.from([0x8a, 0x05, ...Buffer.from("Hello")]),
    );
  });

  it("echoes the close code and ends the connection", async (t) => {
    const { port } = await startSocketServer(t);
    const client = await openRawClient(t, port);

    client.socket.write(maskedFrame(0x88, Buffer.from([0x03, 0xe8])));

    assert.equal(await waitForCloseCode(client), CloseCode.NORMAL);
    await client.ended;
  });
});

describe("WebSocket events", () => {
  async function nextError(client) {
    const [{ data }] = await once(client, "message");
    const event = JSON.parse(data);
    assert.equal(event.type, "error");
    return event.payload.code;
  }

  it("reports a broken event and keeps the connection", async (t) => {
    const { port } = await startSocketServer(t);
    const client = openClient(t, port);
    await once(client, "open");

    client.send("{ not json");
    assert.equal(await nextError(client), "invalid_event");

    client.send(JSON.stringify({ type: "message.send" }));
    assert.equal(await nextError(client), "invalid_event");

    client.send(JSON.stringify({ type: "nope", payload: {} }));
    assert.equal(await nextError(client), "unknown_event");

    assert.equal(client.readyState, WebSocket.OPEN);
  });

  it("treats a type that is not a string as unknown and logs nothing", async (t) => {
    const logged = [];
    const { port } = await startSocketServer(t, {
      log: (line) => logged.push(line),
    });
    const client = openClient(t, port);
    await once(client, "open");

    client.send(JSON.stringify({ type: { toString: 1 }, payload: {} }));

    assert.equal(await nextError(client), "unknown_event");
    assert.deepEqual(
      logged.filter((line) => line.startsWith("Event failed")),
      [],
    );
  });

  it("answers a connection check", async (t) => {
    const { port } = await startSocketServer(t);
    const client = openClient(t, port);
    await once(client, "open");

    client.send(JSON.stringify({ type: "connection.check", payload: {} }));

    const [{ data }] = await once(client, "message");
    assert.deepEqual(JSON.parse(data), {
      type: "connection.alive",
      payload: {},
    });
  });

  it("delivers to every connection of a user", async (t) => {
    const { sockets, port } = await startSocketServer(t);
    const first = openClient(t, port);
    const second = openClient(t, port);
    await Promise.all([once(first, "open"), once(second, "open")]);

    const received = [once(first, "message"), once(second, "message")];
    sockets.sendToUser(USER.id, "hello", { n: 1 });

    for (const [{ data }] of await Promise.all(received)) {
      assert.deepEqual(JSON.parse(data), { type: "hello", payload: { n: 1 } });
    }
  });
});

describe("WebSocket lifecycle", () => {
  it("keeps a client that answers pings", async (t) => {
    const { port } = await startSocketServer(t, { pingIntervalMs: 10 });
    const client = openClient(t, port);
    await once(client, "open");

    await delay(100);

    assert.equal(client.readyState, WebSocket.OPEN);
  });

  it("drops a client after two unanswered pings", async (t) => {
    const { port } = await startSocketServer(t, { pingIntervalMs: 10 });
    const client = await openRawClient(t, port);

    await client.ended;

    const pings = bytesAfterHandshake(client);
    assert.deepEqual(pings, Buffer.from([0x89, 0x00, 0x89, 0x00]));
  });

  it("closes the connections of a session on sign out", async (t) => {
    const { sockets, port } = await startSocketServer(t);
    const client = openClient(t, port);
    await once(client, "open");

    const closed = once(client, "close");
    sockets.closeSession("good");
    const [event] = await closed;

    assert.equal(event.code, CloseCode.POLICY_VIOLATION);
  });

  it("closes the connection when the session expires", async (t) => {
    const auth = {
      findSession: async () => ({ user: USER, expiresAt: Date.now() + 20 }),
    };
    const { port } = await startSocketServer(t, { auth, pingIntervalMs: 10 });
    const client = openClient(t, port);
    await once(client, "open");

    const [event] = await once(client, "close");

    assert.equal(event.code, CloseCode.POLICY_VIOLATION);
  });

  it("says goodbye to clients when the server stops", async (t) => {
    const { sockets, port } = await startSocketServer(t);
    const client = openClient(t, port);
    await once(client, "open");

    const closed = once(client, "close");
    await sockets.stop();
    const [event] = await closed;

    assert.equal(event.code, CloseCode.GOING_AWAY);
  });
});
