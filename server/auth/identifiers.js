import { randomBytes } from "node:crypto";

// Crockford base32 has no I, L, O or U, so codes survive being read out loud.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomIdentifier(byteCount) {
  let identifier = "";
  let buffer = 0;
  let bufferedBits = 0;

  for (const byte of randomBytes(byteCount)) {
    buffer = (buffer << 8) | byte;
    bufferedBits += 8;
    while (bufferedBits >= 5) {
      bufferedBits -= 5;
      identifier += ALPHABET[(buffer >>> bufferedBits) & 31];
    }
    buffer &= (1 << bufferedBits) - 1;
  }
  return identifier;
}

export function normalizeIdentifier(value) {
  return value
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}
