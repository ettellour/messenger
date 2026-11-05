export class SessionRepository {
  #store;
  #byTokenHash = new Map();

  constructor(store) {
    this.#store = store;
  }

  async load(now = Date.now()) {
    await this.#store.load();
    this.#store.data.sessions = this.#store.data.sessions.filter(
      (session) => session.expiresAt > now,
    );
    for (const session of this.#store.data.sessions) {
      this.#byTokenHash.set(session.tokenHash, session);
    }
  }

  async add(session) {
    this.#store.data.sessions.push(session);
    this.#byTokenHash.set(session.tokenHash, session);
    await this.#store.save();
  }

  async findByTokenHash(tokenHash) {
    return this.#byTokenHash.get(tokenHash) ?? null;
  }

  async delete(tokenHash) {
    this.#byTokenHash.delete(tokenHash);
    this.#store.data.sessions = this.#store.data.sessions.filter(
      (session) => session.tokenHash !== tokenHash,
    );
    await this.#store.save();
  }
}
