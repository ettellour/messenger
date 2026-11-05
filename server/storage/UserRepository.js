export class UserRepository {
  #store;
  #byId = new Map();
  #byCodeHash = new Map();

  constructor(store) {
    this.#store = store;
  }

  async load() {
    await this.#store.load();
    for (const user of this.#store.data.users) {
      this.#index(user);
    }
  }

  async add(user) {
    this.#store.data.users.push(user);
    this.#index(user);
    await this.#store.save();
  }

  async findById(id) {
    return this.#byId.get(id) ?? null;
  }

  async findByCodeHash(codeHash) {
    return this.#byCodeHash.get(codeHash) ?? null;
  }

  #index(user) {
    this.#byId.set(user.id, user);
    this.#byCodeHash.set(user.codeHash, user);
  }
}
