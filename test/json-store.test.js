import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonStore } from "../server/storage/JsonStore.js";
import { makeTempDir } from "./helpers.js";

describe("JsonStore", () => {
  it("starts from the initial data when there is no file yet", async (t) => {
    const dir = await makeTempDir(t);
    const store = new JsonStore(join(dir, "nested", "items.json"), {
      items: [],
    });

    await store.load();

    assert.deepEqual(store.data, { items: [] });
  });

  it("reads back what was saved", async (t) => {
    const dir = await makeTempDir(t);
    const path = join(dir, "items.json");
    const store = new JsonStore(path, { items: [] });
    await store.load();
    store.data.items.push("сохранено");
    await store.save();

    const reopened = new JsonStore(path, { items: [] });
    await reopened.load();

    assert.deepEqual(reopened.data, { items: ["сохранено"] });
  });

  it("keeps every change when saves overlap", async (t) => {
    const dir = await makeTempDir(t);
    const path = join(dir, "items.json");
    const store = new JsonStore(path, { items: [] });
    await store.load();

    const saves = [];
    for (let index = 0; index < 50; index += 1) {
      store.data.items.push(index);
      saves.push(store.save());
    }
    await Promise.all(saves);

    const { items } = JSON.parse(await readFile(path, "utf8"));
    assert.equal(items.length, 50);
    assert.deepEqual(await readdir(dir), ["items.json"]);
  });

  it("recovers after a failed write", async (t) => {
    const dir = await makeTempDir(t);
    const path = join(dir, "missing", "items.json");
    const store = new JsonStore(path, { items: [] });

    await assert.rejects(store.save(), { code: "ENOENT" });

    await store.load();
    await store.save();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { items: [] });
  });

  it("refuses to start on a damaged file instead of overwriting it", async (t) => {
    const dir = await makeTempDir(t);
    const path = join(dir, "items.json");
    await writeFile(path, "{ not json");
    const store = new JsonStore(path, { items: [] });

    await assert.rejects(store.load(), /Cannot read/);

    assert.equal(await readFile(path, "utf8"), "{ not json");
  });
});
