function pairKey(firstUserId, secondUserId) {
  return [firstUserId, secondUserId].sort().join(":");
}

function clientKey({ chatId, from, clientId }) {
  return `${chatId}:${from}:${clientId}`;
}

export class ChatRepository {
  #chatStore;
  #messageStore;
  #now;
  #chatsById = new Map();
  #chatsByPair = new Map();
  #chatsByUser = new Map();
  #messagesByChat = new Map();
  #messagesByClientKey = new Map();
  #chatIdsByFile = new Map();
  #lastMessageId = 0;

  constructor({ chatStore, messageStore, now = Date.now }) {
    this.#chatStore = chatStore;
    this.#messageStore = messageStore;
    this.#now = now;
  }

  async load() {
    await Promise.all([this.#chatStore.load(), this.#messageStore.load()]);
    for (const chat of this.#chatStore.data.chats) {
      this.#indexChat(chat);
    }
    for (const message of this.#messageStore.data.messages) {
      this.#indexMessage(message);
    }
  }

  async addChat(chat) {
    this.#chatStore.data.chats.push(chat);
    this.#indexChat(chat);
    await this.#chatStore.save();
  }

  async findChat(id) {
    return this.#chatsById.get(id) ?? null;
  }

  async findChatBetween(firstUserId, secondUserId) {
    return this.#chatsByPair.get(pairKey(firstUserId, secondUserId)) ?? null;
  }

  async listChatsOf(userId) {
    return [...(this.#chatsByUser.get(userId) ?? [])];
  }

  // The duplicate check and the insert share one synchronous step, so two copies
  // of a message racing each other still produce a single stored message.
  async addMessage(draft) {
    const existing = this.#messagesByClientKey.get(clientKey(draft));
    if (existing) {
      await this.#messageStore.save();
      return { message: existing, created: false };
    }

    const message = {
      id: this.#nextMessageId(),
      ...draft,
      sentAt: this.#now(),
    };
    this.#messageStore.data.messages.push(message);
    this.#indexMessage(message);

    try {
      await this.#messageStore.save();
    } catch (error) {
      // Nobody will be told about this message, so a retry must be able to
      // create it again rather than find a copy that was never announced.
      this.#forgetMessage(message);
      throw error;
    }
    return { message, created: true };
  }

  async messagesBefore(chatId, beforeId, limit) {
    const messages = this.#messagesOf(chatId);
    const end =
      beforeId === undefined
        ? messages.length
        : messages.findLastIndex(({ id }) => id < beforeId) + 1;
    const start = Math.max(0, end - limit);
    return { messages: messages.slice(start, end), hasMore: start > 0 };
  }

  async messagesAfter(chatId, afterId, limit) {
    const messages = this.#messagesOf(chatId);
    const firstNewer = messages.findIndex(({ id }) => id > afterId);
    if (firstNewer === -1) {
      return { messages: [], hasMore: false };
    }
    const end = firstNewer + limit;
    return {
      messages: messages.slice(firstNewer, end),
      hasMore: end < messages.length,
    };
  }

  async lastMessage(chatId) {
    return this.#messagesOf(chatId).at(-1) ?? null;
  }

  async countUnread(chat, userId) {
    const lastRead = chat.lastRead[userId] ?? 0;
    const messages = this.#messagesOf(chat.id);

    let unread = 0;
    for (
      let i = messages.length - 1;
      i >= 0 && messages[i].id > lastRead;
      i--
    ) {
      if (messages[i].from !== userId) {
        unread += 1;
      }
    }
    return unread;
  }

  async setLastRead(chat, userId, messageId) {
    chat.lastRead[userId] = messageId;
    await this.#chatStore.save();
  }

  async isFileSharedWith(fileId, userId) {
    for (const chatId of this.#chatIdsByFile.get(fileId) ?? []) {
      if (this.#chatsById.get(chatId).members.includes(userId)) {
        return true;
      }
    }
    return false;
  }

  // Stays monotonic when the clock jumps back or a millisecond holds several messages.
  #nextMessageId() {
    this.#lastMessageId = Math.max(this.#now() * 1000, this.#lastMessageId + 1);
    return this.#lastMessageId;
  }

  #messagesOf(chatId) {
    return this.#messagesByChat.get(chatId) ?? [];
  }

  #indexChat(chat) {
    this.#chatsById.set(chat.id, chat);
    this.#chatsByPair.set(pairKey(...chat.members), chat);
    for (const userId of chat.members) {
      const chats = this.#chatsByUser.get(userId) ?? [];
      chats.push(chat);
      this.#chatsByUser.set(userId, chats);
    }
  }

  #indexMessage(message) {
    this.#lastMessageId = Math.max(this.#lastMessageId, message.id);

    const messages = this.#messagesByChat.get(message.chatId) ?? [];
    messages.push(message);
    this.#messagesByChat.set(message.chatId, messages);
    this.#messagesByClientKey.set(clientKey(message), message);

    if (message.fileId) {
      const chatIds = this.#chatIdsByFile.get(message.fileId) ?? new Set();
      chatIds.add(message.chatId);
      this.#chatIdsByFile.set(message.fileId, chatIds);
    }
  }

  #forgetMessage(message) {
    const store = this.#messageStore.data;
    store.messages = store.messages.filter(({ id }) => id !== message.id);
    this.#messagesByChat.set(
      message.chatId,
      this.#messagesOf(message.chatId).filter(({ id }) => id !== message.id),
    );
    this.#messagesByClientKey.delete(clientKey(message));
    this.#chatIdsByFile.get(message.fileId)?.delete(message.chatId);
  }
}
