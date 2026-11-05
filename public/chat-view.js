import { describeError } from "./api.js";
import {
  formatDay,
  formatFileSize,
  formatTime,
  formatUserId,
  isSameDay,
} from "./format.js";
import { createElement, newClientId, showError } from "./ui.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const STICK_TO_BOTTOM_PX = 80;

export class ChatView {
  #api;
  #socket;
  #myId = null;
  #chat = null;
  #messages = new Map();
  #outgoing = new Map();
  #hasOlder = false;
  #isLoaded = false;
  #lastReadSent = 0;
  #lastShownAt = null;

  #root = document.getElementById("chat");
  #placeholder = document.getElementById("no-chat");
  #name = document.getElementById("chat-name");
  #peerId = document.getElementById("chat-peer-id");
  #scroller = document.getElementById("chat-scroll");
  #list = document.getElementById("messages");
  #loadOlder = document.getElementById("load-older");
  #status = document.getElementById("chat-status");
  #statusText = document.getElementById("chat-status-text");
  #retry = document.getElementById("chat-retry");
  #composer = document.getElementById("composer");
  #input = document.getElementById("message-input");
  #fileInput = document.getElementById("file-input");
  #composerError = document.getElementById("composer-error");

  constructor(api, socket) {
    this.#api = api;
    this.#socket = socket;

    this.#composer.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#sendText();
    });
    this.#input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.#sendText();
      }
    });
    this.#input.addEventListener("input", () => this.#fitInputToText());

    document
      .getElementById("attach-file")
      .addEventListener("click", () => this.#fileInput.click());
    this.#fileInput.addEventListener("change", () => this.#sendChosenFile());

    this.#loadOlder.addEventListener("click", () => this.#showOlderMessages());
    this.#retry.addEventListener("click", () => this.#loadHistory());
    document.addEventListener("visibilitychange", () => this.#markRead());
  }

  reset(myId) {
    this.#myId = myId;
    this.#outgoing.clear();
    this.close();
  }

  async open(chat) {
    this.#chat = chat;
    this.#lastReadSent = 0;
    this.#placeholder.hidden = true;
    this.#root.hidden = false;
    this.#name.textContent = chat.peer.name;
    this.#peerId.textContent = formatUserId(chat.peer.id);
    showError(this.#composerError, "");

    if (matchMedia("(min-width: 720px)").matches) {
      this.#input.focus();
    }
    await this.#loadHistory();
  }

  close() {
    this.#chat = null;
    this.#messages.clear();
    this.#isLoaded = false;
    this.#list.replaceChildren();
    this.#root.hidden = true;
    this.#placeholder.hidden = false;
  }

  get openChatId() {
    return this.#chat?.id ?? null;
  }

  showMessage(message) {
    if (message.chatId !== this.openChatId) {
      return;
    }
    // The history on its way may have been read before this message was written.
    if (!this.#isLoaded) {
      this.#messages.set(message.id, message);
      return;
    }
    this.#keepingBottom(() => this.#appendMessage(message));
    this.#markRead();
  }

  confirmMessage(clientId, message) {
    const outgoing = this.#outgoing.get(clientId);
    this.#outgoing.delete(clientId);
    outgoing?.element?.remove();
    this.showMessage(message);
  }

  failMessage(clientId, code) {
    const outgoing = this.#outgoing.get(clientId);
    if (!outgoing) {
      return;
    }
    outgoing.failure = describeError(code);
    this.#keepingBottom(() => this.#refreshOutgoing(outgoing));
  }

  refreshConnectionState() {
    for (const outgoing of this.#outgoing.values()) {
      this.#refreshOutgoing(outgoing);
    }
  }

  async catchUp() {
    const chatId = this.openChatId;
    if (!chatId) {
      return;
    }
    // The history may have failed to load while the connection was down.
    if (!this.#isLoaded) {
      await this.#loadHistory();
      return;
    }

    try {
      await this.#loadMissedMessages(chatId);
      this.#markRead();
    } catch {
      // Going on would leave a hole in the feed that nobody would notice.
      if (chatId === this.openChatId) {
        await this.#loadHistory();
      }
    }
  }

  async #loadMissedMessages(chatId) {
    // New messages keep arriving meanwhile, so the feed cannot serve as a cursor
    // and these have to be sorted in above them.
    let after = this.#newestMessageId();
    let hasMore = true;
    while (hasMore && chatId === this.openChatId) {
      const page = await this.#api.getMessages(chatId, { after });
      hasMore = page.hasMore;
      if (chatId === this.openChatId && page.messages.length > 0) {
        after = page.messages.at(-1).id;
        page.messages.forEach((message) =>
          this.#messages.set(message.id, message),
        );
        this.#keepingBottom(() => this.#renderAll());
      }
    }
  }

  async #loadHistory() {
    const chatId = this.openChatId;
    this.#isLoaded = false;
    this.#messages.clear();
    this.#list.replaceChildren();
    this.#loadOlder.hidden = true;
    this.#showStatus("Загружаем сообщения");

    try {
      const page = await this.#api.getMessages(chatId);
      if (chatId !== this.openChatId) {
        return;
      }
      page.messages.forEach((message) =>
        this.#messages.set(message.id, message),
      );
      this.#hasOlder = page.hasMore;
      this.#isLoaded = true;
      this.#renderAll();
      this.#scrollToBottom();
      this.#markRead();
    } catch {
      if (chatId === this.openChatId) {
        this.#showStatus("Не получилось загрузить сообщения.", {
          canRetry: true,
        });
      }
    }
  }

  async #showOlderMessages() {
    const chatId = this.openChatId;
    const oldestId = Math.min(...this.#messages.keys());
    this.#loadOlder.disabled = true;
    try {
      const page = await this.#api.getMessages(chatId, { before: oldestId });
      if (chatId !== this.openChatId) {
        return;
      }
      page.messages.forEach((message) =>
        this.#messages.set(message.id, message),
      );
      this.#hasOlder = page.hasMore;

      const distanceFromBottom =
        this.#scroller.scrollHeight - this.#scroller.scrollTop;
      this.#renderAll();
      this.#scroller.scrollTop =
        this.#scroller.scrollHeight - distanceFromBottom;
    } catch (error) {
      showError(this.#composerError, error.message);
    } finally {
      this.#loadOlder.disabled = false;
    }
  }

  #renderAll() {
    this.#list.replaceChildren();
    this.#lastShownAt = null;
    const inOrder = [...this.#messages.values()].sort((a, b) => a.id - b.id);
    for (const message of inOrder) {
      this.#insertConfirmed(message);
    }
    for (const outgoing of this.#outgoing.values()) {
      if (outgoing.chatId === this.openChatId) {
        this.#list.append(this.#refreshOutgoing(outgoing));
      }
    }
    this.#loadOlder.hidden = !this.#hasOlder;
    this.#updateEmptyState();
  }

  #appendMessage(message) {
    if (this.#messages.has(message.id)) {
      return;
    }
    this.#messages.set(message.id, message);
    this.#insertConfirmed(message);
    this.#updateEmptyState();
  }

  // Goes above anything still being sent, because those get their place in the
  // conversation only when the server confirms them.
  #insertConfirmed(message) {
    const firstOutgoing = this.#list.querySelector(".message--outgoing");
    if (
      this.#lastShownAt === null ||
      !isSameDay(this.#lastShownAt, message.sentAt)
    ) {
      this.#list.insertBefore(
        createElement("li", "day", formatDay(message.sentAt)),
        firstOutgoing,
      );
    }
    this.#list.insertBefore(this.#createMessage(message), firstOutgoing);
    this.#lastShownAt = message.sentAt;
  }

  #createMessage(message) {
    const element = this.#createBubble(message.from === this.#myId);
    element.append(
      message.type === "file"
        ? this.#createDownload(message.file)
        : createElement("p", "message-text", message.text),
    );

    const meta = createElement("p", "message-meta");
    meta.append(createElement("time", "", formatTime(message.sentAt)));
    element.append(meta);
    return element;
  }

  #createBubble(isOwn) {
    return createElement("li", isOwn ? "message message--own" : "message");
  }

  #createDownload(file) {
    const wrapper = document.createElement("div");
    const link = createElement("a", "message-file", file.name);
    link.href = `/api/files/${file.id}`;
    link.download = file.name;
    wrapper.append(
      link,
      createElement("span", "message-file-size", formatFileSize(file.size)),
    );
    return wrapper;
  }

  #sendText() {
    const text = this.#input.value;
    if (!this.#chat || text.trim() === "") {
      return;
    }
    showError(this.#composerError, "");

    const outgoing = { clientId: newClientId(), chatId: this.openChatId, text };
    this.#outgoing.set(outgoing.clientId, outgoing);
    this.#input.value = "";
    this.#fitInputToText();
    this.#showOutgoing(outgoing);
    this.#socket.sendMessage(this.#toPayload(outgoing));
  }

  #sendChosenFile() {
    const [file] = this.#fileInput.files;
    this.#fileInput.value = "";
    if (!file) {
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showError(this.#composerError, describeError("file_too_large"));
      return;
    }
    showError(this.#composerError, "");

    const outgoing = { clientId: newClientId(), chatId: this.openChatId, file };
    this.#outgoing.set(outgoing.clientId, outgoing);
    this.#showOutgoing(outgoing);
    this.#uploadAndSend(outgoing);
  }

  async #uploadAndSend(outgoing) {
    outgoing.isUploading = true;
    outgoing.failure = null;
    this.#keepingBottom(() => this.#refreshOutgoing(outgoing));
    try {
      const { file } = await this.#api.uploadFile(outgoing.file);
      outgoing.fileId = file.id;
      this.#socket.sendMessage(this.#toPayload(outgoing));
    } catch (error) {
      outgoing.failure = error.message;
    } finally {
      outgoing.isUploading = false;
      if (this.#outgoing.has(outgoing.clientId)) {
        this.#keepingBottom(() => this.#refreshOutgoing(outgoing));
      }
    }
  }

  #retryOutgoing(outgoing) {
    outgoing.failure = null;
    if (outgoing.file && !outgoing.fileId) {
      this.#uploadAndSend(outgoing);
      return;
    }
    this.#keepingBottom(() => this.#refreshOutgoing(outgoing));
    this.#socket.sendMessage(this.#toPayload(outgoing));
  }

  #discardOutgoing(outgoing) {
    this.#outgoing.delete(outgoing.clientId);
    outgoing.element.remove();
    this.#updateEmptyState();
  }

  #toPayload({ chatId, clientId, text, fileId }) {
    return fileId ? { chatId, clientId, fileId } : { chatId, clientId, text };
  }

  #showOutgoing(outgoing) {
    this.#list.append(this.#refreshOutgoing(outgoing));
    this.#updateEmptyState();
    this.#scrollToBottom();
  }

  #refreshOutgoing(outgoing) {
    const element = this.#createBubble(true);
    element.classList.add("message--outgoing");
    if (outgoing.failure) {
      element.classList.add("message--failed");
    }

    if (outgoing.file) {
      const wrapper = document.createElement("div");
      wrapper.append(
        createElement("span", "message-file", outgoing.file.name),
        createElement(
          "span",
          "message-file-size",
          formatFileSize(outgoing.file.size),
        ),
      );
      element.append(wrapper);
    } else {
      element.append(createElement("p", "message-text", outgoing.text));
    }
    element.append(this.#createOutgoingMeta(outgoing));

    outgoing.element?.replaceWith(element);
    outgoing.element = element;
    return element;
  }

  #createOutgoingMeta(outgoing) {
    const meta = createElement("div", "message-meta");
    if (!outgoing.failure) {
      const isWaitingForNetwork =
        !this.#socket.isConnected && !outgoing.isUploading;
      meta.append(
        createElement(
          "span",
          "message-status",
          isWaitingForNetwork ? "Ждёт связи" : "Отправляется",
        ),
      );
      return meta;
    }

    const retry = createElement("button", "", "Повторить");
    retry.type = "button";
    retry.addEventListener("click", () => this.#retryOutgoing(outgoing));
    const discard = createElement("button", "", "Убрать");
    discard.type = "button";
    discard.addEventListener("click", () => this.#discardOutgoing(outgoing));
    meta.append(
      createElement(
        "span",
        "message-status",
        `Не отправлено. ${outgoing.failure}`,
      ),
      retry,
      discard,
    );
    return meta;
  }

  #markRead() {
    const newestId = this.#newestMessageId();
    if (
      this.#isLoaded &&
      newestId > this.#lastReadSent &&
      document.visibilityState === "visible"
    ) {
      this.#lastReadSent = newestId;
      this.#socket.markRead(this.#chat.id, newestId);
    }
  }

  #newestMessageId() {
    return this.#messages.size > 0 ? Math.max(...this.#messages.keys()) : 0;
  }

  #updateEmptyState() {
    const isEmpty = this.#list.children.length === 0;
    if (isEmpty) {
      this.#showStatus("Здесь пока пусто. Напишите первое сообщение.");
    } else {
      this.#status.hidden = true;
    }
  }

  #showStatus(text, { canRetry = false } = {}) {
    this.#statusText.textContent = text;
    this.#retry.hidden = !canRetry;
    this.#status.hidden = false;
  }

  #fitInputToText() {
    this.#input.style.height = "auto";
    this.#input.style.height = `${this.#input.scrollHeight + 2}px`;
  }

  #keepingBottom(update) {
    const { scrollHeight, scrollTop, clientHeight } = this.#scroller;
    const isAtBottom =
      scrollHeight - scrollTop - clientHeight < STICK_TO_BOTTOM_PX;
    update();
    if (isAtBottom) {
      this.#scrollToBottom();
    }
  }

  #scrollToBottom() {
    this.#scroller.scrollTop = this.#scroller.scrollHeight;
  }
}
