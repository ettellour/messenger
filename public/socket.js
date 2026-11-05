const FIRST_RECONNECT_DELAY_MS = 1000;
const LONGEST_RECONNECT_DELAY_MS = 30_000;
const REPLY_TIMEOUT_MS = 10_000;
const CONNECTION_CHECK_INTERVAL_MS = 25_000;
const SESSION_ENDED_CLOSE_CODE = 1008;

export class SocketClient extends EventTarget {
  #socket = null;
  #isConnected = false;
  #isStopped = true;
  #unconfirmed = new Map();
  #readMarks = new Map();
  #reconnectDelay = FIRST_RECONNECT_DELAY_MS;
  #reconnectTimer = null;
  #replyTimer = null;
  #checkTimer = null;

  constructor() {
    super();
    window.addEventListener("online", () => this.#checkConnectionNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.#checkConnectionNow();
      }
    });
  }

  get isConnected() {
    return this.#isConnected;
  }

  get hasUnconfirmedMessages() {
    return this.#unconfirmed.size > 0;
  }

  connect() {
    this.#isStopped = false;
    this.#open();
  }

  disconnect() {
    this.#isStopped = true;
    this.#unconfirmed.clear();
    this.#readMarks.clear();
    clearTimeout(this.#reconnectTimer);
    this.#stopWatching();
    this.#dropSocket();
  }

  // Kept until the server confirms it. After a reconnect it goes out again with
  // the same clientId, and the server recognises the repeat.
  sendMessage(payload) {
    this.#unconfirmed.set(payload.clientId, payload);
    if (this.#isConnected) {
      this.#send("message.send", payload);
      this.#waitForReply();
    }
  }

  // Repeated on every new connection: the last mark may never have left, or may
  // have gone down with the old connection, and the server ignores what it has.
  markRead(chatId, messageId) {
    this.#readMarks.set(chatId, messageId);
    if (this.#isConnected) {
      this.#send("message.read", { chatId, messageId });
    }
  }

  #open() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    this.#socket = socket;

    socket.onopen = () => this.#handleOpen();
    socket.onmessage = ({ data }) => this.#handleEvent(JSON.parse(data));
    socket.onclose = ({ code }) => this.#handleClose(code);
    // An attempt to connect can hang as silently as a working connection.
    this.#waitForReply();
  }

  #send(type, payload) {
    this.#socket.send(JSON.stringify({ type, payload }));
  }

  #handleOpen() {
    const wasReconnecting = this.#reconnectDelay > FIRST_RECONNECT_DELAY_MS;
    this.#isConnected = true;
    this.#reconnectDelay = FIRST_RECONNECT_DELAY_MS;
    this.#noteReply();
    this.#checkTimer = setInterval(
      () => this.#checkConnection(),
      CONNECTION_CHECK_INTERVAL_MS,
    );

    for (const payload of this.#unconfirmed.values()) {
      this.#send("message.send", payload);
    }
    for (const [chatId, messageId] of this.#readMarks) {
      this.#send("message.read", { chatId, messageId });
    }
    this.dispatchEvent(
      new CustomEvent("connected", { detail: { wasReconnecting } }),
    );
  }

  #handleEvent({ type, payload }) {
    if (type === "message.sent" || type === "error") {
      this.#unconfirmed.delete(payload.clientId);
    }
    this.#noteReply();
    this.dispatchEvent(new CustomEvent(type, { detail: payload }));
  }

  #handleClose(code) {
    this.#socket = null;
    this.#isConnected = false;
    this.#stopWatching();

    if (code === SESSION_ENDED_CLOSE_CODE) {
      this.dispatchEvent(new CustomEvent("session-ended"));
      return;
    }
    this.dispatchEvent(new CustomEvent("disconnected"));
    this.#scheduleReconnect();
  }

  // Browsers answer the server's ping frames on their own and hide them from the
  // page, so an idle page has to ask for itself whether the server still hears it.
  #checkConnection() {
    this.#send("connection.check", {});
    this.#waitForReply();
  }

  // A dead network often gives no close event for minutes. A missing reply is
  // the first sign, so the connection is replaced rather than waited for.
  #waitForReply() {
    if (this.#replyTimer) {
      return;
    }
    this.#replyTimer = setTimeout(() => {
      this.#dropSocket();
      this.#handleClose();
    }, REPLY_TIMEOUT_MS);
  }

  #noteReply() {
    clearTimeout(this.#replyTimer);
    this.#replyTimer = null;
    if (this.hasUnconfirmedMessages) {
      this.#waitForReply();
    }
  }

  #stopWatching() {
    clearInterval(this.#checkTimer);
    clearTimeout(this.#replyTimer);
    this.#replyTimer = null;
  }

  #dropSocket() {
    if (!this.#socket) {
      return;
    }
    this.#socket.onopen = null;
    this.#socket.onmessage = null;
    this.#socket.onclose = null;
    this.#socket.close();
    this.#socket = null;
    this.#isConnected = false;
  }

  #scheduleReconnect() {
    if (this.#isStopped) {
      return;
    }
    const jitter = Math.random() * 500;
    this.#reconnectTimer = setTimeout(
      () => this.#open(),
      this.#reconnectDelay + jitter,
    );
    this.#reconnectDelay = Math.min(
      this.#reconnectDelay * 2,
      LONGEST_RECONNECT_DELAY_MS,
    );
  }

  #checkConnectionNow() {
    if (this.#isConnected) {
      this.#checkConnection();
    } else if (!this.#isStopped && !this.#socket) {
      clearTimeout(this.#reconnectTimer);
      this.#open();
    }
  }
}
