import { randomBytes } from "node:crypto";
import { normalizeIdentifier } from "../auth/identifiers.js";
import { ServiceError } from "../errors.js";

const HISTORY_PAGE_SIZE = 50;
const CATCH_UP_PAGE_SIZE = 200;
const MAX_TEXT_LENGTH = 4000;
const CLIENT_ID_PATTERN = /^[\w-]{1,64}$/;

export class ChatService {
  #chats;
  #users;
  #files;
  #now;

  constructor({ chats, users, files, now = Date.now }) {
    this.#chats = chats;
    this.#users = users;
    this.#files = files;
    this.#now = now;
  }

  async findOrCreateChat(userId, rawPeerId) {
    const peerId =
      typeof rawPeerId === "string" ? normalizeIdentifier(rawPeerId) : "";
    if (peerId === userId) {
      throw new ServiceError("cannot_chat_with_self", "This is your own id");
    }
    if (!(await this.#users.findById(peerId))) {
      throw new ServiceError("user_not_found", "No user with this id");
    }

    const existing = await this.#chats.findChatBetween(userId, peerId);
    if (existing) {
      if (existing.createdBy !== userId && !existing.openedByPeer) {
        await this.#chats.markOpenedByPeer(existing);
      }
      return {
        chat: await this.#describeChat(existing, userId),
        created: false,
      };
    }

    const chat = {
      id: randomBytes(8).toString("hex"),
      members: [userId, peerId],
      createdBy: userId,
      lastRead: {},
      createdAt: this.#now(),
    };
    await this.#chats.addChat(chat);
    return { chat: await this.#describeChat(chat, userId), created: true };
  }

  async listChats(userId) {
    const views = [];
    for (const chat of await this.#chats.listChatsOf(userId)) {
      // A chat someone opened but never wrote in is not the peer's business yet,
      // unless the peer opened it as well.
      const isVisible =
        chat.createdBy === userId ||
        chat.openedByPeer ||
        (await this.#chats.lastMessage(chat.id));
      if (isVisible) {
        views.push(await this.#describeChat(chat, userId));
      }
    }
    return views.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getChat(chatId, userId) {
    const chat = await this.#requireMembership(chatId, userId);
    return this.#describeChat(chat, userId);
  }

  async getHistory(chatId, userId, { before, after }) {
    await this.#requireMembership(chatId, userId);
    const { messages, hasMore } =
      after === undefined
        ? await this.#chats.messagesBefore(chatId, before, HISTORY_PAGE_SIZE)
        : await this.#chats.messagesAfter(chatId, after, CATCH_UP_PAGE_SIZE);
    return {
      messages: await Promise.all(
        messages.map((m) => this.#describeMessage(m)),
      ),
      hasMore,
    };
  }

  async sendMessage(userId, { chatId, clientId, text, fileId }) {
    const chat = await this.#requireMembership(chatId, userId);
    if (typeof clientId !== "string" || !CLIENT_ID_PATTERN.test(clientId)) {
      throw new ServiceError(
        "invalid_message",
        "Message has no valid clientId",
      );
    }

    const content =
      fileId === undefined
        ? this.#buildTextContent(text)
        : await this.#buildFileContent(userId, fileId);
    const { message, created } = await this.#chats.addMessage({
      chatId: chat.id,
      from: userId,
      clientId,
      ...content,
    });

    return {
      message: await this.#describeMessage(message),
      created,
      memberIds: chat.members,
    };
  }

  async markRead(userId, chatId, messageId) {
    const chat = await this.#requireMembership(chatId, userId);
    if (!Number.isSafeInteger(messageId)) {
      throw new ServiceError("invalid_message", "Message id must be a number");
    }

    const lastMessage = await this.#chats.lastMessage(chat.id);
    const newest = Math.min(messageId, lastMessage?.id ?? 0);
    if (newest > (chat.lastRead[userId] ?? 0)) {
      await this.#chats.setLastRead(chat, userId, newest);
    }
    return this.#describeChat(chat, userId);
  }

  async #requireMembership(chatId, userId) {
    const chat = await this.#chats.findChat(chatId);
    // The same answer for a foreign chat and a missing one: ids stay unconfirmed.
    if (!chat?.members.includes(userId)) {
      throw new ServiceError("chat_not_found", "Chat not found");
    }
    return chat;
  }

  #buildTextContent(text) {
    if (typeof text !== "string" || text.trim() === "") {
      throw new ServiceError("message_empty", "Message is empty");
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new ServiceError(
        "message_too_long",
        `Message is longer than ${MAX_TEXT_LENGTH} characters`,
      );
    }
    return { type: "text", text };
  }

  // Attaching only your own uploads matters: the right to download follows the
  // message, so a guessed fileId must not open someone else's file.
  async #buildFileContent(userId, fileId) {
    const file = await this.#files.findById(fileId);
    if (file?.uploadedBy !== userId) {
      throw new ServiceError("file_not_found", "File not found");
    }
    return { type: "file", fileId: file.id };
  }

  async #describeChat(chat, userId) {
    const peer = await this.#users.findById(
      chat.members.find((memberId) => memberId !== userId),
    );
    const lastMessage = await this.#chats.lastMessage(chat.id);
    return {
      id: chat.id,
      peer: { id: peer.id, name: peer.name },
      lastMessage: lastMessage
        ? await this.#describeMessage(lastMessage)
        : null,
      unreadCount: await this.#chats.countUnread(chat, userId),
      updatedAt: lastMessage?.sentAt ?? chat.createdAt,
    };
  }

  async #describeMessage(message) {
    const { id, chatId, from, type, text, fileId, sentAt } = message;
    if (type === "text") {
      return { id, chatId, from, type, text, sentAt };
    }
    const file = await this.#files.findById(fileId);
    return {
      id,
      chatId,
      from,
      type,
      file: { id: file.id, name: file.name, size: file.size },
      sentAt,
    };
  }
}
