import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CloseCode,
  computeAcceptKey,
  encodeServerFrame,
  FrameError,
  Opcode,
  parseClientFrame,
} from "../server/ws/frames.js";
import { maskedFrame } from "./helpers.js";

const MAX_PAYLOAD = 64 * 1024;

// The frames below come from RFC 6455, section 5.7.
const MASKED_HELLO = Buffer.from([
  0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58,
]);
const UNMASKED_HELLO = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
const FRAGMENT_START = Buffer.from([0x01, 0x03, 0x48, 0x65, 0x6c]);
const MASKED_PONG = Buffer.from([
  0x8a, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58,
]);

function assertRejected(frame, closeCode) {
  assert.throws(
    () => parseClientFrame(frame, MAX_PAYLOAD),
    (error) => error instanceof FrameError && error.closeCode === closeCode,
  );
}

describe("handshake", () => {
  it("computes the accept key from the RFC example", () => {
    assert.equal(
      computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });
});

describe("parseClientFrame", () => {
  it("unmasks the RFC example", () => {
    const frame = parseClientFrame(MASKED_HELLO, MAX_PAYLOAD);

    assert.equal(frame.opcode, Opcode.TEXT);
    assert.equal(frame.payload.toString(), "Hello");
    assert.equal(frame.frameLength, MASKED_HELLO.length);
  });

  it("recognises a pong", () => {
    const frame = parseClientFrame(MASKED_PONG, MAX_PAYLOAD);

    assert.equal(frame.opcode, Opcode.PONG);
    assert.equal(frame.payload.toString(), "Hello");
  });

  it("waits for the rest of a frame at every split point", () => {
    for (let length = 0; length < MASKED_HELLO.length; length += 1) {
      assert.equal(
        parseClientFrame(MASKED_HELLO.subarray(0, length), MAX_PAYLOAD),
        null,
      );
    }
  });

  it("leaves the next frame in the buffer alone", () => {
    const twoFrames = Buffer.concat([MASKED_HELLO, MASKED_PONG]);

    const first = parseClientFrame(twoFrames, MAX_PAYLOAD);
    const second = parseClientFrame(
      twoFrames.subarray(first.frameLength),
      MAX_PAYLOAD,
    );

    assert.equal(first.opcode, Opcode.TEXT);
    assert.equal(second.opcode, Opcode.PONG);
  });

  it("reads the 16-bit length form", () => {
    const frame = parseClientFrame(
      maskedFrame(0x81, Buffer.alloc(300, 7)),
      MAX_PAYLOAD,
    );

    assert.equal(frame.payload.length, 300);
    assert.ok(frame.payload.every((byte) => byte === 7));
  });

  it("reads the 64-bit length form at the size limit", () => {
    const frame = parseClientFrame(
      maskedFrame(0x81, Buffer.alloc(65536, 7)),
      MAX_PAYLOAD,
    );

    assert.equal(frame.payload.length, 65536);
  });

  it("refuses an unmasked frame", () => {
    assertRejected(UNMASKED_HELLO, CloseCode.PROTOCOL_ERROR);
  });

  it("refuses fragments", () => {
    assertRejected(FRAGMENT_START, CloseCode.UNSUPPORTED_DATA);
    assertRejected(
      maskedFrame(0x80, Buffer.from([1])),
      CloseCode.UNSUPPORTED_DATA,
    );
  });

  it("refuses reserved bits", () => {
    assertRejected(
      maskedFrame(0xc1, Buffer.from([1])),
      CloseCode.PROTOCOL_ERROR,
    );
  });

  it("refuses unknown opcodes", () => {
    assertRejected(
      maskedFrame(0x83, Buffer.from([1])),
      CloseCode.PROTOCOL_ERROR,
    );
    assertRejected(
      maskedFrame(0x8b, Buffer.from([1])),
      CloseCode.PROTOCOL_ERROR,
    );
  });

  it("refuses a fragmented or long control frame", () => {
    assertRejected(
      maskedFrame(0x09, Buffer.from([1])),
      CloseCode.PROTOCOL_ERROR,
    );
    assertRejected(
      maskedFrame(0x89, Buffer.alloc(126)),
      CloseCode.PROTOCOL_ERROR,
    );
  });

  it("refuses a length that is not in its shortest form", () => {
    assertRejected(
      Buffer.from([0x81, 0xfe, 0x00, 0x05]),
      CloseCode.PROTOCOL_ERROR,
    );
    assertRejected(
      Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0, 0xff, 0xff]),
      CloseCode.PROTOCOL_ERROR,
    );
  });

  it("refuses a length with the top bit set", () => {
    assertRejected(
      Buffer.from([0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0]),
      CloseCode.PROTOCOL_ERROR,
    );
  });

  it("refuses an oversized frame from its header alone", () => {
    assertRejected(
      Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 1, 0, 1]),
      CloseCode.TOO_BIG,
    );
  });
});

describe("encodeServerFrame", () => {
  it("matches the unmasked RFC example", () => {
    assert.deepEqual(
      encodeServerFrame(Opcode.TEXT, Buffer.from("Hello")),
      UNMASKED_HELLO,
    );
  });

  it("uses the 16-bit length form from 126 bytes", () => {
    const frame = encodeServerFrame(Opcode.BINARY, Buffer.alloc(256));

    assert.deepEqual(
      frame.subarray(0, 4),
      Buffer.from([0x82, 0x7e, 0x01, 0x00]),
    );
    assert.equal(frame.length, 260);
  });

  it("uses the 64-bit length form from 65536 bytes", () => {
    const frame = encodeServerFrame(Opcode.BINARY, Buffer.alloc(65536));

    assert.deepEqual(
      frame.subarray(0, 10),
      Buffer.from([0x82, 0x7f, 0, 0, 0, 0, 0, 1, 0, 0]),
    );
  });
});
