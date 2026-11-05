import { createHash, randomBytes } from "node:crypto";
import { ServiceError } from "../errors.js";
import { normalizeIdentifier, randomIdentifier } from "./identifiers.js";

const CODE_BYTES = 10;
const CODE_LENGTH = 16;
const USER_ID_BYTES = 5;
const SESSION_TOKEN_BYTES = 32;
const MAX_NAME_LENGTH = 40;

export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toPublicUser({ id, name }) {
  return { id, name };
}

export class AuthService {
  #users;
  #sessions;
  #now;

  constructor({ users, sessions, now = Date.now }) {
    this.#users = users;
    this.#sessions = sessions;
    this.#now = now;
  }

  async register(rawName) {
    const name =
      typeof rawName === "string" ? rawName.replace(/\s+/g, " ").trim() : "";
    if (name === "" || name.length > MAX_NAME_LENGTH) {
      throw new ServiceError(
        "invalid_name",
        `Name must be 1 to ${MAX_NAME_LENGTH} characters`,
      );
    }

    const code = randomIdentifier(CODE_BYTES);
    const user = {
      id: await this.#generateUserId(),
      codeHash: sha256(code),
      name,
      createdAt: this.#now(),
    };
    await this.#users.add(user);

    return { user: toPublicUser(user), code: code.match(/.{4}/g).join("-") };
  }

  async login(rawCode) {
    const code =
      typeof rawCode === "string" ? normalizeIdentifier(rawCode) : "";
    const user =
      code.length === CODE_LENGTH
        ? await this.#users.findByCodeHash(sha256(code))
        : null;
    if (!user) {
      throw new ServiceError("invalid_code", "Unknown code");
    }

    const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    await this.#sessions.add({
      tokenHash: sha256(token),
      userId: user.id,
      expiresAt: this.#now() + SESSION_LIFETIME_MS,
    });
    return { user: toPublicUser(user), token };
  }

  async logout(token) {
    await this.#sessions.delete(sha256(token));
  }

  async findSession(token) {
    if (!token) {
      return null;
    }
    const session = await this.#sessions.findByTokenHash(sha256(token));
    if (!session || session.expiresAt <= this.#now()) {
      return null;
    }
    const user = await this.#users.findById(session.userId);
    return user
      ? { user: toPublicUser(user), expiresAt: session.expiresAt }
      : null;
  }

  async #generateUserId() {
    let id;
    do {
      id = randomIdentifier(USER_ID_BYTES);
    } while (await this.#users.findById(id));
    return id;
  }
}
