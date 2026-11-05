import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ServiceError } from "../errors.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_NAME_LENGTH = 255;
const FALLBACK_NAME = "file";
const UNFINISHED_SUFFIX = ".part";

// The name is only shown to people and sent back in a header. On disk a file
// lives under a random id, so a hostile name cannot reach the file system.
function cleanFileName(rawName) {
  const name = Array.from(rawName.replace(/[\u0000-\u001f\u007f]/g, ""))
    .slice(0, MAX_NAME_LENGTH)
    .join("")
    .replace(/[/\\]/g, "_")
    .trim();
  return name || FALLBACK_NAME;
}

function fileTooLarge() {
  return new ServiceError("file_too_large", "File is larger than 10 MB");
}

export class FileService {
  #files;
  #chats;
  #dir;
  #maxBytes;
  #now;

  constructor({
    files,
    chats,
    dir,
    maxBytes = MAX_FILE_BYTES,
    now = Date.now,
  }) {
    this.#files = files;
    this.#chats = chats;
    this.#dir = dir;
    this.#maxBytes = maxBytes;
    this.#now = now;
  }

  async load() {
    await mkdir(this.#dir, { recursive: true });
    // Nothing is uploading yet, so these were left by a process that got killed.
    for (const name of await readdir(this.#dir)) {
      if (name.endsWith(UNFINISHED_SUFFIX)) {
        await rm(join(this.#dir, name), { force: true });
      }
    }
  }

  async saveUpload({ uploadedBy, name, declaredSize, content }) {
    if (declaredSize > this.#maxBytes) {
      throw fileTooLarge();
    }

    const id = randomBytes(16).toString("hex");
    const size = await this.#writeToDisk(id, content);
    const file = {
      id,
      uploadedBy,
      name: cleanFileName(name),
      size,
      uploadedAt: this.#now(),
    };
    await this.#files.add(file);
    return { id, name: file.name, size };
  }

  async openForDownload(fileId, userId) {
    const file = await this.#files.findById(fileId);
    const canRead =
      file &&
      (file.uploadedBy === userId ||
        (await this.#chats.isFileSharedWith(fileId, userId)));
    if (!canRead) {
      throw new ServiceError("file_not_found", "File not found");
    }

    const handle = await open(join(this.#dir, file.id));
    return { file, content: handle.createReadStream() };
  }

  async #writeToDisk(id, content) {
    const partPath = join(this.#dir, `${id}${UNFINISHED_SUFFIX}`);
    let size = 0;
    const maxBytes = this.#maxBytes;
    const sizeLimit = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(size > maxBytes ? fileTooLarge() : null, chunk);
      },
    });

    try {
      await pipeline(content, sizeLimit, createWriteStream(partPath));
      await rename(partPath, join(this.#dir, id));
    } catch (error) {
      await rm(partPath, { force: true });
      throw error;
    }
    return size;
  }
}
