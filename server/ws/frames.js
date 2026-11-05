import { createHash } from "node:crypto";

const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_CONTROL_PAYLOAD = 125;

export const Opcode = Object.freeze({
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

export const CloseCode = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  INVALID_TEXT: 1007,
  POLICY_VIOLATION: 1008,
  TOO_BIG: 1009,
});

const KNOWN_OPCODES = new Set(Object.values(Opcode));

export class FrameError extends Error {
  constructor(closeCode, message) {
    super(message);
    this.closeCode = closeCode;
  }
}

export function computeAcceptKey(clientKey) {
  return createHash("sha1")
    .update(clientKey + HANDSHAKE_GUID)
    .digest("base64");
}

// Returns null until the buffer holds a whole frame. The size limit is checked
// as soon as the header is in, so an oversized frame is never buffered.
export function parseClientFrame(buffer, maxPayload) {
  if (buffer.length < 2) {
    return null;
  }

  const isFinal = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const isControl = (opcode & 0x08) !== 0;
  const isMasked = (buffer[1] & 0x80) !== 0;
  const shortLength = buffer[1] & 0x7f;

  if ((buffer[0] & 0x70) !== 0) {
    throw new FrameError(CloseCode.PROTOCOL_ERROR, "Reserved bits are set");
  }
  if (opcode === 0 || (!isFinal && !isControl)) {
    throw new FrameError(
      CloseCode.UNSUPPORTED_DATA,
      "Fragmented messages are not supported",
    );
  }
  if (!KNOWN_OPCODES.has(opcode)) {
    throw new FrameError(CloseCode.PROTOCOL_ERROR, "Unknown opcode");
  }
  if (isControl && (!isFinal || shortLength > MAX_CONTROL_PAYLOAD)) {
    throw new FrameError(CloseCode.PROTOCOL_ERROR, "Invalid control frame");
  }
  if (!isMasked) {
    throw new FrameError(CloseCode.PROTOCOL_ERROR, "Frame is not masked");
  }

  let payloadLength = shortLength;
  let headerLength = 2;
  if (shortLength === 126) {
    if (buffer.length < 4) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(2);
    headerLength = 4;
    if (payloadLength < 126) {
      throw new FrameError(CloseCode.PROTOCOL_ERROR, "Length is not minimal");
    }
  } else if (shortLength === 127) {
    if (buffer.length < 10) {
      return null;
    }
    const longLength = buffer.readBigUInt64BE(2);
    headerLength = 10;
    if (longLength < 65536n || longLength >> 63n !== 0n) {
      throw new FrameError(CloseCode.PROTOCOL_ERROR, "Invalid frame length");
    }
    payloadLength =
      longLength > BigInt(maxPayload) ? Infinity : Number(longLength);
  }
  if (payloadLength > maxPayload) {
    throw new FrameError(CloseCode.TOO_BIG, "Frame is too big");
  }

  const payloadStart = headerLength + 4;
  const frameLength = payloadStart + payloadLength;
  if (buffer.length < frameLength) {
    return null;
  }

  const payload = Buffer.allocUnsafe(payloadLength);
  for (let index = 0; index < payloadLength; index += 1) {
    payload[index] =
      buffer[payloadStart + index] ^ buffer[headerLength + (index % 4)];
  }
  return { opcode, payload, frameLength };
}

export function encodeServerFrame(opcode, payload) {
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}
