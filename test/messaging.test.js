import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { postJson, signUp, startServer, TestSocket } from "./helpers.js";

async function setUpChat(t) {
  const server = await startServer(t);
  const anna = await signUp(server.url, "Анна");
  const boris = await signUp(server.url, "Борис");

  const response = await postJson(
    `${server.url}/api/chats`,
    { peerId: boris.user.id },
    { Cookie: anna.cookie },
  );
  const { chat } = await response.json();
  return { server, url: server.url, anna, boris, chat };
}

function getJson(url, cookie) {
  return fetch(url, { headers: { Cookie: cookie } });
}

describe("messages between two clients", () => {
  it("delivers a message in real time", async (t) => {
    const { url, anna, boris, chat } = await setUpChat(t);
    const annaSocket = await TestSocket.open(t, url, anna.cookie);
    const borisSocket = await TestSocket.open(t, url, boris.cookie);

    annaSocket.send("message.send", {
      chatId: chat.id,
      clientId: "c1",
      text: "Привет, Борис",
    });

    const sent = await annaSocket.next("message.sent");
    const received = await borisSocket.next("message.new");
    assert.equal(sent.clientId, "c1");
    assert.equal(received.message.text, "Привет, Борис");
    assert.equal(received.message.from, anna.user.id);
    assert.equal(received.message.id, sent.message.id);
    assert.equal(received.message.clientId, undefined);

    const annaChat = await annaSocket.next("chat.updated");
    const borisChat = await borisSocket.next("chat.updated");
    assert.equal(annaChat.chat.peer.name, "Борис");
    assert.equal(annaChat.chat.unreadCount, 0);
    assert.equal(borisChat.chat.peer.name, "Анна");
    assert.equal(borisChat.chat.unreadCount, 1);
  });

  it("does not deliver a resent message twice", async (t) => {
    const { url, anna, boris, chat } = await setUpChat(t);
    const annaSocket = await TestSocket.open(t, url, anna.cookie);
    const borisSocket = await TestSocket.open(t, url, boris.cookie);
    const message = { chatId: chat.id, clientId: "c1", text: "один раз" };

    annaSocket.send("message.send", message);
    const first = await annaSocket.next("message.sent");
    annaSocket.close();

    const reconnected = await TestSocket.open(t, url, anna.cookie);
    reconnected.send("message.send", message);
    const repeat = await reconnected.next("message.sent");

    assert.equal(repeat.message.id, first.message.id);
    await borisSocket.next("message.new");
    assert.deepEqual(await borisSocket.pending("message.new"), []);
    const history = await getJson(
      `${url}/api/chats/${chat.id}/messages`,
      boris.cookie,
    );
    assert.equal((await history.json()).messages.length, 1);
  });

  it("keeps the order of messages sent in a burst", async (t) => {
    const { url, anna, chat } = await setUpChat(t);
    const socket = await TestSocket.open(t, url, anna.cookie);

    for (let index = 0; index < 20; index += 1) {
      socket.send("message.send", {
        chatId: chat.id,
        clientId: `c${index}`,
        text: String(index),
      });
    }
    for (let index = 0; index < 20; index += 1) {
      assert.equal((await socket.next("message.sent")).clientId, `c${index}`);
    }

    const response = await getJson(
      `${url}/api/chats/${chat.id}/messages`,
      anna.cookie,
    );
    const { messages } = await response.json();
    assert.deepEqual(
      messages.map(({ text }) => text),
      Array.from({ length: 20 }, (_, index) => String(index)),
    );
  });

  it("shows the message in the sender's other tab", async (t) => {
    const { url, anna, chat } = await setUpChat(t);
    const sendingTab = await TestSocket.open(t, url, anna.cookie);
    const otherTab = await TestSocket.open(t, url, anna.cookie);

    sendingTab.send("message.send", {
      chatId: chat.id,
      clientId: "c1",
      text: "из другой вкладки",
    });

    const { message } = await otherTab.next("message.new");
    assert.equal(message.text, "из другой вкладки");
    await sendingTab.next("message.sent");
    assert.deepEqual(await sendingTab.pending("message.new"), []);
  });

  it("keeps a message for someone who is offline", async (t) => {
    const { url, anna, boris, chat } = await setUpChat(t);
    const socket = await TestSocket.open(t, url, anna.cookie);

    socket.send("message.send", {
      chatId: chat.id,
      clientId: "c1",
      text: "прочитаешь потом",
    });
    await socket.next("message.sent");

    const response = await getJson(`${url}/api/chats`, boris.cookie);
    const { chats } = await response.json();
    assert.equal(chats[0].unreadCount, 1);
    assert.equal(chats[0].lastMessage.text, "прочитаешь потом");
  });

  it("lets a client catch up on what it missed", async (t) => {
    const { url, anna, boris, chat } = await setUpChat(t);
    const socket = await TestSocket.open(t, url, anna.cookie);
    const send = async (text) => {
      socket.send("message.send", {
        chatId: chat.id,
        clientId: randomUUID(),
        text,
      });
      return (await socket.next("message.sent")).message;
    };

    const seen = await send("видел");
    await send("пропустил");

    const response = await getJson(
      `${url}/api/chats/${chat.id}/messages?after=${seen.id}`,
      boris.cookie,
    );
    const { messages } = await response.json();
    assert.deepEqual(
      messages.map(({ text }) => text),
      ["пропустил"],
    );
  });

  it("does not lose an acknowledged message when the server is killed", async (t) => {
    const { server, url, anna, chat } = await setUpChat(t);
    const socket = await TestSocket.open(t, url, anna.cookie);

    socket.send("message.send", {
      chatId: chat.id,
      clientId: "c1",
      text: "уже сохранено",
    });
    await socket.next("message.sent");
    server.child.kill("SIGKILL");
    await server.exited;

    const restarted = await startServer(t, server.dataDir);
    const response = await getJson(
      `${restarted.url}/api/chats/${chat.id}/messages`,
      anna.cookie,
    );
    assert.equal((await response.json()).messages[0].text, "уже сохранено");
  });

  it("clears unread messages for all tabs of the reader", async (t) => {
    const { url, anna, boris, chat } = await setUpChat(t);
    const annaSocket = await TestSocket.open(t, url, anna.cookie);
    const borisSocket = await TestSocket.open(t, url, boris.cookie);

    annaSocket.send("message.send", {
      chatId: chat.id,
      clientId: "c1",
      text: "прочти",
    });
    const { message } = await borisSocket.next("message.new");
    await borisSocket.next("chat.updated");

    borisSocket.send("message.read", {
      chatId: chat.id,
      messageId: message.id,
    });

    assert.equal((await borisSocket.next("chat.updated")).chat.unreadCount, 0);
  });
});

describe("errors over the socket", () => {
  it("reports a refused message with its clientId", async (t) => {
    const { url, anna, chat } = await setUpChat(t);
    const socket = await TestSocket.open(t, url, anna.cookie);

    socket.send("message.send", { chatId: chat.id, clientId: "c1", text: " " });

    const error = await socket.next("error");
    assert.equal(error.code, "message_empty");
    assert.equal(error.clientId, "c1");
  });

  it("refuses to send into someone else's chat", async (t) => {
    const { url, boris, chat } = await setUpChat(t);
    const vera = await signUp(url, "Вера");
    const borisSocket = await TestSocket.open(t, url, boris.cookie);
    const veraSocket = await TestSocket.open(t, url, vera.cookie);

    veraSocket.send("message.send", {
      chatId: chat.id,
      clientId: "c1",
      text: "подслушиваю",
    });

    assert.equal((await veraSocket.next("error")).code, "chat_not_found");
    assert.deepEqual(await borisSocket.pending("message.new"), []);
  });

  it("refuses to mark someone else's chat as read", async (t) => {
    const { url, chat } = await setUpChat(t);
    const vera = await signUp(url, "Вера");
    const socket = await TestSocket.open(t, url, vera.cookie);

    socket.send("message.read", { chatId: chat.id, messageId: 1 });

    assert.equal((await socket.next("error")).code, "chat_not_found");
  });

  it("closes the socket on sign out", async (t) => {
    const { url, anna } = await setUpChat(t);
    const socket = await TestSocket.open(t, url, anna.cookie);

    const closed = socket.closed();
    await postJson(`${url}/api/logout`, {}, { Cookie: anna.cookie });

    assert.equal(await closed, 1008);
  });

  it("says goodbye and exits cleanly when the server stops", async (t) => {
    const { server, url, anna } = await setUpChat(t);
    const socket = await TestSocket.open(t, url, anna.cookie);

    const closed = socket.closed();
    server.child.kill("SIGTERM");

    assert.equal(await closed, 1001);
    const [exitCode] = await server.exited;
    assert.equal(exitCode, 0);
  });
});

describe("chats over HTTP", () => {
  it("opens the same chat again with status 200", async (t) => {
    const { url, anna, boris, chat } = await setUpChat(t);

    const response = await postJson(
      `${url}/api/chats`,
      { peerId: boris.user.id },
      { Cookie: anna.cookie },
    );

    assert.equal(response.status, 200);
    assert.equal((await response.json()).chat.id, chat.id);
  });

  it("answers 404 to an unknown peer", async (t) => {
    const { url, anna } = await setUpChat(t);

    const response = await postJson(
      `${url}/api/chats`,
      { peerId: "NOBODY00" },
      { Cookie: anna.cookie },
    );

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "user_not_found");
  });

  it("hides someone else's chat history behind a 404", async (t) => {
    const { url, chat } = await setUpChat(t);
    const vera = await signUp(url, "Вера");

    const response = await getJson(
      `${url}/api/chats/${chat.id}/messages`,
      vera.cookie,
    );

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "chat_not_found");
  });

  it("requires a session", async (t) => {
    const { url, chat } = await setUpChat(t);

    const responses = await Promise.all([
      fetch(`${url}/api/chats`),
      postJson(`${url}/api/chats`, { peerId: "X" }),
      fetch(`${url}/api/chats/${chat.id}/messages`),
    ]);

    for (const response of responses) {
      assert.equal(response.status, 401);
    }
  });

  it("refuses a cursor that is not a message id", async (t) => {
    const { url, anna, chat } = await setUpChat(t);

    const response = await getJson(
      `${url}/api/chats/${chat.id}/messages?before=abc`,
      anna.cookie,
    );

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_cursor");
  });
});
