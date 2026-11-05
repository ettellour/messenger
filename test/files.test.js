import assert from "node:assert/strict";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { FileService } from "../server/files/FileService.js";
import { FileRepository } from "../server/storage/FileRepository.js";
import { JsonStore } from "../server/storage/JsonStore.js";
import {
  makeTempDir,
  postJson,
  signUp,
  startServer,
  TestSocket,
} from "./helpers.js";

const TEN_MEGABYTES = 10 * 1024 * 1024;

async function upload(url, cookie, name, body) {
  const headers = { "X-File-Name": encodeURIComponent(name) };
  if (cookie) {
    headers.Cookie = cookie;
  }
  return fetch(`${url}/api/files`, { method: "PUT", headers, body });
}

async function setUpChat(t) {
  const server = await startServer(t);
  const anna = await signUp(server.url, "Анна");
  const boris = await signUp(server.url, "Борис");
  const vera = await signUp(server.url, "Вера");

  const response = await postJson(
    `${server.url}/api/chats`,
    { peerId: boris.user.id },
    { Cookie: anna.cookie },
  );
  const { chat } = await response.json();
  const annaSocket = await TestSocket.open(t, server.url, anna.cookie);
  return { ...server, anna, boris, vera, chat, annaSocket };
}

function download(url, fileId, cookie) {
  return fetch(`${url}/api/files/${fileId}`, { headers: { Cookie: cookie } });
}

async function shareFile(annaSocket, chat, fileId) {
  annaSocket.send("message.send", {
    chatId: chat.id,
    clientId: `file-${fileId}`,
    fileId,
  });
  return (await annaSocket.next("message.sent")).message;
}

describe("sending a file", () => {
  it("reaches the other person byte for byte", async (t) => {
    const { url, anna, boris, chat, annaSocket } = await setUpChat(t);
    const borisSocket = await TestSocket.open(t, url, boris.cookie);
    const content = Buffer.from([0, 1, 2, 250, 251, 252]);

    const response = await upload(
      url,
      anna.cookie,
      "отчёт за май.pdf",
      content,
    );
    const { file } = await response.json();
    await shareFile(annaSocket, chat, file.id);
    const { message } = await borisSocket.next("message.new");
    const downloaded = await download(url, message.file.id, boris.cookie);

    assert.equal(response.status, 201);
    assert.equal(file.name, "отчёт за май.pdf");
    assert.equal(message.type, "file");
    assert.deepEqual(message.file, {
      id: file.id,
      name: "отчёт за май.pdf",
      size: 6,
    });
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), content);
  });

  it("shows the file as the last message of the chat", async (t) => {
    const { url, anna, boris, chat, annaSocket } = await setUpChat(t);
    const { file } = await (
      await upload(url, anna.cookie, "a.txt", "x")
    ).json();
    await shareFile(annaSocket, chat, file.id);

    const response = await fetch(`${url}/api/chats`, {
      headers: { Cookie: boris.cookie },
    });
    const { chats } = await response.json();

    assert.equal(chats[0].lastMessage.file.name, "a.txt");
  });

  it("accepts an empty file and a file of exactly 10 MB", async (t) => {
    const { url, anna } = await setUpChat(t);

    const empty = await upload(url, anna.cookie, "empty.txt", "");
    const full = await upload(
      url,
      anna.cookie,
      "full.bin",
      Buffer.alloc(TEN_MEGABYTES),
    );

    assert.equal(empty.status, 201);
    assert.equal((await empty.json()).file.size, 0);
    assert.equal(full.status, 201);
    assert.equal((await full.json()).file.size, TEN_MEGABYTES);
  });

  it("keeps files after a restart", async (t) => {
    const server = await setUpChat(t);
    const { file } = await (
      await upload(server.url, server.anna.cookie, "a.txt", "сохранено")
    ).json();
    server.child.kill("SIGKILL");
    await server.exited;

    const restarted = await startServer(t, server.dataDir);
    const response = await download(restarted.url, file.id, server.anna.cookie);

    assert.equal(await response.text(), "сохранено");
  });
});

describe("access to a file", () => {
  it("is refused to someone outside the chat", async (t) => {
    const { url, anna, vera, chat, annaSocket } = await setUpChat(t);
    const { file } = await (
      await upload(url, anna.cookie, "a.txt", "x")
    ).json();
    await shareFile(annaSocket, chat, file.id);

    const response = await download(url, file.id, vera.cookie);

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "file_not_found");
  });

  it("is refused to the peer until the file is sent", async (t) => {
    const { url, anna, boris } = await setUpChat(t);
    const { file } = await (
      await upload(url, anna.cookie, "a.txt", "x")
    ).json();

    const asPeer = await download(url, file.id, boris.cookie);
    const asOwner = await download(url, file.id, anna.cookie);

    assert.equal(asPeer.status, 404);
    assert.equal(asOwner.status, 200);
  });

  it("cannot be gained by attaching someone else's file", async (t) => {
    const { url, anna, vera, boris } = await setUpChat(t);
    const { file } = await (
      await upload(url, anna.cookie, "a.txt", "x")
    ).json();
    const opened = await postJson(
      `${url}/api/chats`,
      { peerId: boris.user.id },
      { Cookie: vera.cookie },
    );
    const { chat: veraChat } = await opened.json();
    const veraSocket = await TestSocket.open(t, url, vera.cookie);

    veraSocket.send("message.send", {
      chatId: veraChat.id,
      clientId: "stolen",
      fileId: file.id,
    });

    assert.equal((await veraSocket.next("error")).code, "file_not_found");
    assert.equal((await download(url, file.id, vera.cookie)).status, 404);
    assert.equal((await download(url, file.id, boris.cookie)).status, 404);
  });

  it("requires a session to upload and to download", async (t) => {
    const { url, anna } = await setUpChat(t);
    const { file } = await (
      await upload(url, anna.cookie, "a.txt", "x")
    ).json();

    assert.equal((await upload(url, null, "b.txt", "x")).status, 401);
    assert.equal((await fetch(`${url}/api/files/${file.id}`)).status, 401);
  });

  it("answers the same way for a file that does not exist", async (t) => {
    const { url, anna } = await setUpChat(t);

    const response = await download(url, "nothing", anna.cookie);

    assert.equal(response.status, 404);
  });
});

describe("serving an uploaded file", () => {
  it("never lets the browser open it as a page", async (t) => {
    const { url, anna } = await setUpChat(t);
    const { file } = await (
      await upload(url, anna.cookie, "page.html", "<script>alert(1)</script>")
    ).json();

    const response = await download(url, file.id, anna.cookie);

    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      response.headers.get("content-disposition"),
      /^attachment; filename="page\.html"/,
    );
  });

  it("encodes names so they cannot break the header", async (t) => {
    const { url, anna } = await setUpChat(t);
    const { file } = await (
      await upload(url, anna.cookie, 'отчёт "май" (1).pdf', "x")
    ).json();

    const response = await download(url, file.id, anna.cookie);
    const header = response.headers.get("content-disposition");

    assert.ok(header.includes('filename="_____ _____ (1).pdf"'));
    assert.ok(
      header.includes(
        `filename*=UTF-8''${encodeURIComponent('отчёт "май" ')}%281%29.pdf`,
      ),
    );
  });

  it("does not trust the name for anything on disk", async (t) => {
    const { url, anna, dataDir } = await setUpChat(t);

    const response = await upload(
      url,
      anna.cookie,
      "../../../etc/evil.sh",
      "x",
    );
    const { file } = await response.json();

    assert.equal(file.name, ".._.._.._etc_evil.sh");
    assert.deepEqual(await readdir(join(dataDir, "files")), [file.id]);
  });

  it("removes control characters from the name", async (t) => {
    const { url, anna } = await setUpChat(t);

    const response = await upload(
      url,
      anna.cookie,
      "a\r\nSet-Cookie: x.txt",
      "x",
    );

    assert.equal((await response.json()).file.name, "aSet-Cookie: x.txt");
  });

  it("gives a name to a file that came without one", async (t) => {
    const { url, anna } = await setUpChat(t);

    const response = await upload(url, anna.cookie, "", "x");

    assert.equal((await response.json()).file.name, "file");
  });

  it("refuses a badly encoded name", async (t) => {
    const { url, anna } = await setUpChat(t);

    const response = await fetch(`${url}/api/files`, {
      method: "PUT",
      headers: { Cookie: anna.cookie, "X-File-Name": "%E0%A4%A" },
      body: "x",
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_file_name");
  });
});

describe("upload limits", () => {
  function startRawUpload(url, cookie, contentLength) {
    const { hostname, port } = new URL(url);
    const req = request({
      hostname,
      port,
      method: "PUT",
      path: "/api/files",
      headers: {
        Cookie: cookie,
        "X-File-Name": "big.bin",
        "Content-Length": contentLength,
      },
    });
    req.on("error", () => {});
    return req;
  }

  it("refuses an oversized file from its declared size", async (t) => {
    const { url, anna, dataDir } = await setUpChat(t);
    const req = startRawUpload(url, anna.cookie, TEN_MEGABYTES + 1);

    req.flushHeaders();
    const [response] = await once(req, "response");
    t.after(() => req.destroy());

    assert.equal(response.statusCode, 413);
    assert.equal(response.headers.connection, "close");
    assert.deepEqual(await readdir(join(dataDir, "files")), []);
  });

  it("cleans up when the client leaves mid-upload", async (t) => {
    const { url, anna, dataDir, output } = await setUpChat(t);
    const req = startRawUpload(url, anna.cookie, 1000);
    const dir = join(dataDir, "files");

    req.write(Buffer.alloc(10));
    while ((await readdir(dir)).length === 0) {
      await delay(5);
    }
    req.destroy();
    while ((await readdir(dir)).length > 0) {
      await delay(5);
    }

    assert.doesNotMatch(output.stdout, /Request failed/);
  });

  it("stops a stream that outgrows the limit without declaring its size", async (t) => {
    const dir = await makeTempDir(t);
    const files = new FileRepository(
      new JsonStore(join(dir, "files.json"), { files: [] }),
    );
    await files.load();
    const service = new FileService({
      files,
      dir: join(dir, "files"),
      maxBytes: 4,
    });
    await service.load();

    await assert.rejects(
      service.saveUpload({
        uploadedBy: "ANNA0000",
        name: "a.bin",
        declaredSize: 0,
        content: Readable.from([Buffer.alloc(3), Buffer.alloc(3)]),
      }),
      { code: "file_too_large" },
    );

    assert.deepEqual(await readdir(join(dir, "files")), []);
  });
});
