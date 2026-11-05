import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SocketClient } from "../public/socket.js";

const CHECK_INTERVAL_MS = 25_000;
const REPLY_TIMEOUT_MS = 10_000;
const FIRST_RECONNECT_WITH_JITTER_MS = 1500;

class FakeWebSocket {
  sent = [];
  isClosed = false;

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  close() {
    this.isClosed = true;
  }

  receive(type, payload = {}) {
    this.onmessage({ data: JSON.stringify({ type, payload }) });
  }

  sentOfType(type) {
    return this.sent.filter((event) => event.type === type);
  }
}

// The browser is replaced only around the class under test: its timers, its
// sockets and the page events it listens to.
function startClient(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

  const sockets = [];
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor() {
      super();
      sockets.push(this);
    }
  };
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  globalThis.location = { protocol: "http:", host: "localhost" };

  const client = new SocketClient();
  const events = [];
  for (const type of ["connected", "disconnected", "session-ended"]) {
    client.addEventListener(type, ({ detail }) => {
      events.push({ type, detail });
    });
  }
  client.connect();
  return {
    client,
    sockets,
    events,
    tick: (milliseconds) => t.mock.timers.tick(milliseconds),
  };
}

function lastEventType(events) {
  return events.at(-1)?.type;
}

describe("noticing a dead connection", () => {
  it("keeps a connection that answers the check", (t) => {
    const { sockets, events, tick } = startClient(t);
    sockets[0].onopen();

    tick(CHECK_INTERVAL_MS);
    assert.equal(sockets[0].sentOfType("connection.check").length, 1);
    sockets[0].receive("connection.alive");
    tick(REPLY_TIMEOUT_MS);

    assert.equal(sockets[0].isClosed, false);
    assert.equal(lastEventType(events), "connected");
  });

  it("replaces a connection that does not answer and tells about the return", (t) => {
    const { client, sockets, events, tick } = startClient(t);
    sockets[0].onopen();

    tick(CHECK_INTERVAL_MS);
    tick(REPLY_TIMEOUT_MS);

    assert.equal(sockets[0].isClosed, true);
    assert.equal(client.isConnected, false);
    assert.equal(lastEventType(events), "disconnected");

    tick(FIRST_RECONNECT_WITH_JITTER_MS);
    sockets[1].onopen();

    assert.deepEqual(events.at(-1), {
      type: "connected",
      detail: { wasReconnecting: true },
    });
  });

  it("gives up on an attempt to connect that hangs", (t) => {
    const { sockets, events, tick } = startClient(t);

    tick(REPLY_TIMEOUT_MS);

    assert.equal(sockets[0].isClosed, true);
    assert.equal(lastEventType(events), "disconnected");

    tick(FIRST_RECONNECT_WITH_JITTER_MS);

    assert.equal(sockets.length, 2);
  });

  it("does not time out a connection attempt that succeeded", (t) => {
    const { sockets, tick } = startClient(t);
    sockets[0].onopen();

    tick(REPLY_TIMEOUT_MS);

    assert.equal(sockets[0].isClosed, false);
  });

  it("stops checking after a normal close", (t) => {
    const { sockets, tick } = startClient(t);
    sockets[0].onopen();
    sockets[0].onclose({ code: 1006 });

    tick(CHECK_INTERVAL_MS);

    assert.deepEqual(sockets[0].sentOfType("connection.check"), []);
  });

  it("checks at once when the network comes back", (t) => {
    const { sockets, events, tick } = startClient(t);
    sockets[0].onopen();

    window.dispatchEvent(new Event("online"));

    assert.equal(sockets[0].sentOfType("connection.check").length, 1);

    tick(REPLY_TIMEOUT_MS);

    assert.equal(lastEventType(events), "disconnected");
  });

  it("checks at once when the tab becomes visible", (t) => {
    const { sockets } = startClient(t);
    sockets[0].onopen();

    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    assert.deepEqual(sockets[0].sentOfType("connection.check"), []);

    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(sockets[0].sentOfType("connection.check").length, 1);
  });

  it("connects at once when the network comes back during a pause", (t) => {
    const { sockets } = startClient(t);
    sockets[0].onopen();
    sockets[0].onclose({ code: 1006 });

    window.dispatchEvent(new Event("online"));

    assert.equal(sockets.length, 2);
  });

  it("leaves an attempt in progress alone when the network comes back", (t) => {
    const { sockets } = startClient(t);

    window.dispatchEvent(new Event("online"));

    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].isClosed, false);
  });

  it("stays away after sign out", (t) => {
    const { client, sockets, tick } = startClient(t);
    sockets[0].onopen();

    client.disconnect();
    window.dispatchEvent(new Event("online"));
    tick(CHECK_INTERVAL_MS + REPLY_TIMEOUT_MS);

    assert.equal(sockets.length, 1);
    assert.deepEqual(sockets[0].sentOfType("connection.check"), []);
  });

  it("does not reconnect when the server ended the session", (t) => {
    const { sockets, events, tick } = startClient(t);
    sockets[0].onopen();

    sockets[0].onclose({ code: 1008 });
    tick(FIRST_RECONNECT_WITH_JITTER_MS);

    assert.equal(lastEventType(events), "session-ended");
    assert.equal(sockets.length, 1);
  });
});

describe("messages waiting for confirmation", () => {
  const message = { chatId: "chat", clientId: "c1", text: "привет" };

  it("go out as soon as the connection opens", (t) => {
    const { client, sockets } = startClient(t);

    client.sendMessage(message);
    assert.deepEqual(sockets[0].sent, []);
    sockets[0].onopen();

    assert.deepEqual(sockets[0].sentOfType("message.send"), [
      { type: "message.send", payload: message },
    ]);
  });

  it("go out again over a new connection with the same clientId", (t) => {
    const { client, sockets, tick } = startClient(t);
    sockets[0].onopen();
    client.sendMessage(message);

    tick(REPLY_TIMEOUT_MS);
    assert.equal(sockets[0].isClosed, true);
    tick(FIRST_RECONNECT_WITH_JITTER_MS);
    sockets[1].onopen();

    assert.deepEqual(sockets[1].sentOfType("message.send"), [
      { type: "message.send", payload: message },
    ]);
  });

  it("are forgotten once confirmed", (t) => {
    const { client, sockets, tick } = startClient(t);
    sockets[0].onopen();
    client.sendMessage(message);

    sockets[0].receive("message.sent", { clientId: "c1" });
    tick(REPLY_TIMEOUT_MS);

    assert.equal(client.hasUnconfirmedMessages, false);
    assert.equal(sockets[0].isClosed, false);
  });

  it("are forgotten once refused", (t) => {
    const { client, sockets } = startClient(t);
    sockets[0].onopen();
    client.sendMessage(message);

    sockets[0].receive("error", { clientId: "c1", code: "message_empty" });

    assert.equal(client.hasUnconfirmedMessages, false);
  });

  it("keep the connection under watch while some are left", (t) => {
    const { client, sockets, tick } = startClient(t);
    sockets[0].onopen();
    client.sendMessage(message);
    client.sendMessage({ ...message, clientId: "c2" });

    sockets[0].receive("message.sent", { clientId: "c1" });
    tick(REPLY_TIMEOUT_MS);

    assert.equal(sockets[0].isClosed, true);
  });
});
