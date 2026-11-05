import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ChatService } from "../server/chat/ChatService.js";
import { ChatRepository } from "../server/storage/ChatRepository.js";
import { FileRepository } from "../server/storage/FileRepository.js";
import { JsonStore } from "../server/storage/JsonStore.js";
import { UserRepository } from "../server/storage/UserRepository.js";
import { makeTempDir } from "./helpers.js";

const ANNA = { id: "ANNA0000", name: "Анна", codeHash: "a", createdAt: 1 };
const BORIS = { id: "BRS00000", name: "Борис", codeHash: "b", createdAt: 1 };
const VERA = { id: "VERA0000", name: "Вера", codeHash: "c", createdAt: 1 };

async function createRepositories(dir, now) {
  const store = (name, initialData) =>
    new JsonStore(join(dir, `${name}.json`), initialData);
  const users = new UserRepository(store("users", { users: [] }));
  const files = new FileRepository(store("files", { files: [] }));
  const chats = new ChatRepository({
    chatStore: store("chats", { chats: [] }),
    messageStore: store("messages", { messages: [] }),
    now,
  });
  await Promise.all([users.load(), files.load(), chats.load()]);
  return { users, files, chats };
}

async function createService(t, now) {
  const dir = await makeTempDir(t);
  const repositories = await createRepositories(dir, now);
  for (const user of [ANNA, BORIS, VERA]) {
    await repositories.users.add(user);
  }
  const service = new ChatService({ ...repositories, now });
  return { service, dir, ...repositories };
}

async function openChat(service) {
  const { chat } = await service.findOrCreateChat(ANNA.id, BORIS.id);
  return chat;
}

function sendText(service, from, chatId, text, clientId = randomUUID()) {
  return service.sendMessage(from, { chatId, clientId, text });
}

describe("findOrCreateChat", () => {
  it("creates one chat for a pair, whoever opens it", async (t) => {
    const { service } = await createService(t);

    const first = await service.findOrCreateChat(ANNA.id, BORIS.id);
    const second = await service.findOrCreateChat(BORIS.id, ANNA.id);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.chat.id, second.chat.id);
    assert.equal(first.chat.peer.name, "Борис");
    assert.equal(second.chat.peer.name, "Анна");
  });

  it("finds the peer however the id was typed", async (t) => {
    const { service } = await createService(t);

    const { chat } = await service.findOrCreateChat(ANNA.id, " brs0-0000 ");

    assert.equal(chat.peer.id, BORIS.id);
  });

  it("refuses a chat with yourself", async (t) => {
    const { service } = await createService(t);

    await assert.rejects(service.findOrCreateChat(ANNA.id, ANNA.id), {
      code: "cannot_chat_with_self",
    });
  });

  it("refuses an unknown peer", async (t) => {
    const { service } = await createService(t);

    for (const peerId of ["NOBODY00", 42, undefined]) {
      await assert.rejects(service.findOrCreateChat(ANNA.id, peerId), {
        code: "user_not_found",
      });
    }
  });
});

describe("sendMessage", () => {
  it("stores the text as written and hides internal fields", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);
    const text = '<script>alert("x")</script>';

    const { message, created } = await sendText(
      service,
      ANNA.id,
      chat.id,
      text,
      "c1",
    );

    assert.equal(created, true);
    assert.equal(message.text, text);
    assert.equal(message.from, ANNA.id);
    assert.equal(message.clientId, undefined);
  });

  it("returns the first message when a clientId repeats", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);

    const first = await sendText(service, ANNA.id, chat.id, "привет", "c1");
    const repeat = await sendText(service, ANNA.id, chat.id, "привет", "c1");

    assert.equal(repeat.created, false);
    assert.equal(repeat.message.id, first.message.id);
    const { messages } = await service.getHistory(chat.id, ANNA.id, {});
    assert.equal(messages.length, 1);
  });

  it("stores one message when two copies race each other", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);

    const results = await Promise.all([
      sendText(service, ANNA.id, chat.id, "привет", "c1"),
      sendText(service, ANNA.id, chat.id, "привет", "c1"),
    ]);

    assert.equal(results.filter(({ created }) => created).length, 1);
    const { messages } = await service.getHistory(chat.id, ANNA.id, {});
    assert.equal(messages.length, 1);
  });

  it("lets each person use the same clientId", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);

    await sendText(service, ANNA.id, chat.id, "первое", "same");
    const { created } = await sendText(
      service,
      BORIS.id,
      chat.id,
      "второе",
      "same",
    );

    assert.equal(created, true);
  });

  it("gives growing ids when the clock stands still or goes back", async (t) => {
    let time = 5000;
    const { service } = await createService(t, () => time);
    const chat = await openChat(service);

    const first = await sendText(service, ANNA.id, chat.id, "1");
    const second = await sendText(service, ANNA.id, chat.id, "2");
    time = 1000;
    const third = await sendText(service, ANNA.id, chat.id, "3");

    assert.ok(second.message.id > first.message.id);
    assert.ok(third.message.id > second.message.id);
  });

  it("keeps ids growing after a restart", async (t) => {
    const now = () => 5000;
    const { service, dir } = await createService(t, now);
    const chat = await openChat(service);
    const { message } = await sendText(service, ANNA.id, chat.id, "1");

    const repositories = await createRepositories(dir, now);
    const restarted = new ChatService({ ...repositories, now });
    const next = await sendText(restarted, ANNA.id, chat.id, "2");

    assert.ok(next.message.id > message.id);
  });

  const badMessages = [
    ["an empty text", { clientId: "c1", text: "" }, "message_empty"],
    ["only spaces", { clientId: "c1", text: " \n " }, "message_empty"],
    ["no text at all", { clientId: "c1" }, "message_empty"],
    [
      "a text that is not a string",
      { clientId: "c1", text: 1 },
      "message_empty",
    ],
    [
      "a text over the limit",
      { clientId: "c1", text: "x".repeat(4001) },
      "message_too_long",
    ],
    ["no clientId", { text: "привет" }, "invalid_message"],
    ["a strange clientId", { clientId: "a b", text: "x" }, "invalid_message"],
  ];

  for (const [name, fields, code] of badMessages) {
    it(`refuses ${name}`, async (t) => {
      const { service } = await createService(t);
      const chat = await openChat(service);

      await assert.rejects(
        service.sendMessage(ANNA.id, { chatId: chat.id, ...fields }),
        { code },
      );
    });
  }

  it("accepts a text exactly at the limit", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);

    const { created } = await sendText(
      service,
      ANNA.id,
      chat.id,
      "x".repeat(4000),
      "c1",
    );

    assert.equal(created, true);
  });

  it("forgets a message it could not save, so a retry can succeed", async () => {
    let isDiskFull = true;
    const chats = new ChatRepository({
      chatStore: { load: async () => {}, data: { chats: [] } },
      messageStore: {
        load: async () => {},
        data: { messages: [] },
        save: async () => {
          if (isDiskFull) {
            throw new Error("Disk is full");
          }
        },
      },
    });
    await chats.load();
    const draft = { chatId: "chat", from: ANNA.id, clientId: "c1" };

    await assert.rejects(chats.addMessage(draft), /Disk is full/);
    assert.equal(await chats.lastMessage("chat"), null);

    isDiskFull = false;
    const { created } = await chats.addMessage(draft);

    assert.equal(created, true);
  });
});

describe("access to a chat", () => {
  it("is refused to everyone but its two members", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);
    await sendText(service, ANNA.id, chat.id, "секрет");
    const refused = { code: "chat_not_found" };

    await assert.rejects(service.getHistory(chat.id, VERA.id, {}), refused);
    await assert.rejects(service.getChat(chat.id, VERA.id), refused);
    await assert.rejects(sendText(service, VERA.id, chat.id, "я тут"), refused);
    await assert.rejects(service.markRead(VERA.id, chat.id, 1), refused);
  });

  it("gives the same answer for a chat that does not exist", async (t) => {
    const { service } = await createService(t);

    await assert.rejects(service.getHistory("nothing", ANNA.id, {}), {
      code: "chat_not_found",
    });
  });
});

describe("history", () => {
  async function createChatWithMessages(t, count) {
    const { service } = await createService(t);
    const chat = await openChat(service);
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      const { message } = await sendText(
        service,
        ANNA.id,
        chat.id,
        `m${index}`,
      );
      ids.push(message.id);
    }
    return { service, chat, ids };
  }

  it("returns the latest 50 oldest first, then pages back", async (t) => {
    const { service, chat, ids } = await createChatWithMessages(t, 60);

    const page = await service.getHistory(chat.id, BORIS.id, {});
    const older = await service.getHistory(chat.id, BORIS.id, {
      before: page.messages[0].id,
    });

    assert.deepEqual(
      page.messages.map(({ id }) => id),
      ids.slice(10),
    );
    assert.equal(page.hasMore, true);
    assert.deepEqual(
      older.messages.map(({ id }) => id),
      ids.slice(0, 10),
    );
    assert.equal(older.hasMore, false);
  });

  it("returns only what is newer than a cursor", async (t) => {
    const { service, chat, ids } = await createChatWithMessages(t, 5);

    const { messages, hasMore } = await service.getHistory(chat.id, BORIS.id, {
      after: ids[2],
    });

    assert.deepEqual(
      messages.map(({ id }) => id),
      ids.slice(3),
    );
    assert.equal(hasMore, false);
  });

  it("returns nothing newer than the last message", async (t) => {
    const { service, chat, ids } = await createChatWithMessages(t, 2);

    const { messages } = await service.getHistory(chat.id, BORIS.id, {
      after: ids[1],
    });

    assert.deepEqual(messages, []);
  });
});

describe("chat list", () => {
  it("shows an empty chat only to the one who opened it", async (t) => {
    const { service } = await createService(t);
    await openChat(service);

    assert.equal((await service.listChats(ANNA.id)).length, 1);
    assert.equal((await service.listChats(BORIS.id)).length, 0);
  });

  it("shows the chat to the peer after the first message", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);

    await sendText(service, ANNA.id, chat.id, "привет");

    const [view] = await service.listChats(BORIS.id);
    assert.equal(view.peer.name, "Анна");
    assert.equal(view.lastMessage.text, "привет");
    assert.equal(view.unreadCount, 1);
  });

  it("puts the most recent conversation first", async (t) => {
    let time = 1000;
    const { service } = await createService(t, () => time);
    const withBoris = await service.findOrCreateChat(ANNA.id, BORIS.id);
    const withVera = await service.findOrCreateChat(ANNA.id, VERA.id);

    time = 2000;
    await sendText(service, ANNA.id, withVera.chat.id, "сначала");
    time = 3000;
    await sendText(service, ANNA.id, withBoris.chat.id, "потом");

    const peers = (await service.listChats(ANNA.id)).map((c) => c.peer.name);
    assert.deepEqual(peers, ["Борис", "Вера"]);
  });

  it("is empty for someone without chats", async (t) => {
    const { service } = await createService(t);

    assert.deepEqual(await service.listChats(VERA.id), []);
  });
});

describe("markRead", () => {
  it("counts only the other person's messages as unread", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);

    await sendText(service, ANNA.id, chat.id, "раз");
    await sendText(service, ANNA.id, chat.id, "два");
    await sendText(service, BORIS.id, chat.id, "три");

    assert.equal((await service.getChat(chat.id, ANNA.id)).unreadCount, 1);
    assert.equal((await service.getChat(chat.id, BORIS.id)).unreadCount, 2);
  });

  it("clears the counter up to the given message", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);
    const first = await sendText(service, ANNA.id, chat.id, "раз");
    await sendText(service, ANNA.id, chat.id, "два");

    const view = await service.markRead(BORIS.id, chat.id, first.message.id);

    assert.equal(view.unreadCount, 1);
  });

  it("never moves back", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);
    const first = await sendText(service, ANNA.id, chat.id, "раз");
    const second = await sendText(service, ANNA.id, chat.id, "два");

    await service.markRead(BORIS.id, chat.id, second.message.id);
    const view = await service.markRead(BORIS.id, chat.id, first.message.id);

    assert.equal(view.unreadCount, 0);
  });

  it("cannot be moved past the newest message", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);
    const { message } = await sendText(service, ANNA.id, chat.id, "раз");

    await service.markRead(BORIS.id, chat.id, message.id + 1_000_000);
    await sendText(service, ANNA.id, chat.id, "два");

    assert.equal((await service.getChat(chat.id, BORIS.id)).unreadCount, 1);
  });

  it("refuses an id that is not a number", async (t) => {
    const { service } = await createService(t);
    const chat = await openChat(service);

    await assert.rejects(service.markRead(BORIS.id, chat.id, "1"), {
      code: "invalid_message",
    });
  });
});
