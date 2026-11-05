import { EventEmitter } from "node:events";
import {
  CloseCode,
  encodeServerFrame,
  FrameError,
  Opcode,
  parseClientFrame,
} from "./frames.js";

const CLOSE_TIMEOUT_MS = 5000;

function isValidCloseCode(code) {
  return (
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1011) ||
    (code >= 3000 && code <= 4999)
  );
}

function buildCloseReply(payload) {
  let code = CloseCode.NORMAL;
  if (payload.length > 0) {
    const isValid =
      payload.length >= 2 && isValidCloseCode(payload.readUInt16BE(0));
    code = isValid ? payload.readUInt16BE(0) : CloseCode.PROTOCOL_ERROR;
  }
  const reply = Buffer.alloc(2);
  reply.writeUInt16BE(code);
  return reply;
}

export class WebSocketConnection extends EventEmitter {
  #socket;
  #maxPayload;
  #buffer = Buffer.alloc(0);
  #isOpen = true;
  #closeTimer = null;
  #textDecoder = new TextDecoder("utf-8", { fatal: true });

  missedPongs = 0;

  constructor(socket, { maxPayload }) {
    super();
    this.#socket = socket;
    this.#maxPayload = maxPayload;

    socket.on("data", (chunk) => this.#receive(chunk));
    socket.on("end", () => socket.end());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(this.#closeTimer);
      this.#isOpen = false;
      this.emit("close");
    });
  }

  // The bytes that came in the same packet as the handshake.
  receiveEarlyData(data) {
    if (data.length > 0) {
      this.#receive(data);
    }
  }

  send(text) {
    if (this.#isOpen) {
      this.#write(Opcode.TEXT, Buffer.from(text));
    }
  }

  ping() {
    if (this.#isOpen) {
      this.#write(Opcode.PING, Buffer.alloc(0));
    }
  }

  close(code, reason) {
    if (!this.#isOpen) {
      return;
    }
    this.#isOpen = false;

    const reasonBytes = Buffer.from(reason);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code);
    reasonBytes.copy(payload, 2);
    this.#write(Opcode.CLOSE, payload);

    this.#closeTimer = setTimeout(
      () => this.#socket.destroy(),
      CLOSE_TIMEOUT_MS,
    );
  }

  terminate() {
    this.#socket.destroy();
  }

  #write(opcode, payload) {
    if (this.#socket.writable) {
      this.#socket.write(encodeServerFrame(opcode, payload));
    }
  }

  #receive(chunk) {
    this.#buffer =
      this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    try {
      let frame;
      while ((frame = parseClientFrame(this.#buffer, this.#maxPayload))) {
        this.#buffer = this.#buffer.subarray(frame.frameLength);
        this.#applyFrame(frame);
      }
    } catch (error) {
      if (!(error instanceof FrameError)) {
        throw error;
      }
      this.#buffer = Buffer.alloc(0);
      this.close(error.closeCode, error.message);
    }
  }

  #applyFrame({ opcode, payload }) {
    switch (opcode) {
      case Opcode.TEXT:
        this.#emitText(payload);
        break;
      case Opcode.BINARY:
        this.close(CloseCode.UNSUPPORTED_DATA, "Only text frames are accepted");
        break;
      case Opcode.PING:
        if (this.#isOpen) {
          this.#write(Opcode.PONG, payload);
        }
        break;
      case Opcode.PONG:
        this.missedPongs = 0;
        break;
      case Opcode.CLOSE:
        this.#answerClose(payload);
        break;
    }
  }

  #emitText(payload) {
    if (!this.#isOpen) {
      return;
    }
    let text;
    try {
      text = this.#textDecoder.decode(payload);
    } catch {
      this.close(CloseCode.INVALID_TEXT, "Text is not valid UTF-8");
      return;
    }
    this.emit("message", text);
  }

  #answerClose(payload) {
    if (this.#isOpen) {
      this.#isOpen = false;
      this.#write(Opcode.CLOSE, buildCloseReply(payload));
    }
    this.#socket.end();
  }
}
