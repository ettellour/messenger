import { formatChatTime } from "./format.js";
import { createElement } from "./ui.js";

function describeLastMessage(message, myId) {
  if (!message) {
    return "Сообщений пока нет";
  }
  const content =
    message.type === "file" ? `Файл: ${message.file.name}` : message.text;
  return message.from === myId ? `Вы: ${content}` : content;
}

export class ChatList {
  #api;
  #myId = null;
  #chats = new Map();
  #hasLoaded = false;
  #openChatId = null;
  #list = document.getElementById("chat-list");
  #status = document.getElementById("chat-list-status");
  #statusText = document.getElementById("chat-list-status-text");
  #retry = document.getElementById("chat-list-retry");

  constructor(api) {
    this.#api = api;
    this.#retry.addEventListener("click", () => this.load());
  }

  reset(myId) {
    this.#myId = myId;
    this.#chats.clear();
    this.#hasLoaded = false;
    this.#openChatId = null;
    this.#list.replaceChildren();
  }

  async load() {
    if (!this.#hasLoaded) {
      this.#showStatus("Загружаем чаты");
    }
    try {
      const { chats } = await this.#api.listChats();
      this.#chats = new Map(chats.map((chat) => [chat.id, chat]));
      this.#hasLoaded = true;
      this.#render();
    } catch {
      this.#showStatus("Не получилось загрузить чаты.", { canRetry: true });
    }
  }

  find(chatId) {
    return this.#chats.get(chatId) ?? null;
  }

  update(chat) {
    this.#chats.set(chat.id, chat);
    this.#render();
  }

  setOpenChat(chatId) {
    this.#openChatId = chatId;
    this.#render();
  }

  #showStatus(text, { canRetry = false } = {}) {
    this.#statusText.textContent = text;
    this.#retry.hidden = !canRetry;
    this.#status.hidden = false;
  }

  #render() {
    if (this.#chats.size === 0) {
      this.#showStatus(
        "Чатов пока нет. Попросите у собеседника его ID и введите его выше.",
      );
    } else {
      this.#status.hidden = true;
    }

    const newestFirst = [...this.#chats.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    this.#list.replaceChildren(
      ...newestFirst.map((chat) => this.#createRow(chat)),
    );
  }

  #createRow(chat) {
    const row = createElement("a", "chat-row");
    row.href = `#/chat/${chat.id}`;
    if (chat.id === this.#openChatId) {
      row.setAttribute("aria-current", "true");
    }

    row.append(
      createElement("span", "chat-row-name", chat.peer.name),
      createElement("span", "chat-row-time", formatChatTime(chat.updatedAt)),
      createElement(
        "span",
        "chat-row-preview",
        describeLastMessage(chat.lastMessage, this.#myId),
      ),
    );
    if (chat.unreadCount > 0) {
      const unread = createElement("span", "chat-row-unread", chat.unreadCount);
      unread.setAttribute("aria-label", `Непрочитанных: ${chat.unreadCount}`);
      row.append(unread);
    }

    const item = document.createElement("li");
    item.append(row);
    return item;
  }
}
