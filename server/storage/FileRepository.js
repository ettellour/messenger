export class FileRepository {
  #store;
  #byId = new Map();

  constructor(store) {
    this.#store = store;
  }

  async load() {
    await this.#store.load();
    for (const file of this.#store.data.files) {
      this.#byId.set(file.id, file);
    }
  }

  async add(file) {
    this.#store.data.files.push(file);
    this.#byId.set(file.id, file);
    await this.#store.save();
  }

  async findById(id) {
    return this.#byId.get(id) ?? null;
  }
}
