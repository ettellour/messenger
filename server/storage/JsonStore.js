import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonStore {
  #filePath;
  #nextWrite = null;
  #lastWrite = Promise.resolve();

  constructor(filePath, initialData) {
    this.#filePath = filePath;
    this.data = initialData;
  }

  async load() {
    await mkdir(dirname(this.#filePath), { recursive: true });
    try {
      this.data = JSON.parse(await readFile(this.#filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Cannot read ${this.#filePath}: ${error.message}`);
      }
    }
  }

  // A write that has not started yet will snapshot the latest data, so callers
  // arriving in the meantime can share it instead of queueing their own.
  save() {
    if (!this.#nextWrite) {
      this.#nextWrite = this.#lastWrite
        .catch(() => {})
        .then(() => {
          this.#nextWrite = null;
          return this.#replaceFile();
        });
      this.#lastWrite = this.#nextWrite;
    }
    return this.#nextWrite;
  }

  async #replaceFile() {
    const tempPath = `${this.#filePath}.tmp`;
    const file = await open(tempPath, "w");
    try {
      await file.writeFile(JSON.stringify(this.data));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tempPath, this.#filePath);
  }
}
