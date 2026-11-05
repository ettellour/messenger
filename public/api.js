const ERROR_TEXT = {
  network: "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.",
  invalid_code: "Такого кода нет. Проверьте, не пропущен ли символ.",
  invalid_name: "Напишите имя, до 40 символов.",
  rate_limited: "Слишком много попыток. Подождите минуту и попробуйте снова.",
  user_not_found: "Человека с таким ID нет. Проверьте, всё ли скопировано.",
  cannot_chat_with_self: "Это ваш собственный ID.",
  chat_not_found: "Этот чат недоступен.",
  file_too_large: "Файл больше 10 МБ, такой отправить нельзя.",
  file_not_found: "Файл не найден.",
  message_too_long: "Сообщение слишком длинное, можно до 4000 символов.",
  message_empty: "Сообщение пустое.",
};
const UNKNOWN_ERROR_TEXT = "Что-то пошло не так. Попробуйте ещё раз.";
const REQUEST_TIMEOUT_MS = 15_000;

export function describeError(code) {
  return ERROR_TEXT[code] ?? UNKNOWN_ERROR_TEXT;
}

export class ApiError extends Error {
  constructor(code, status) {
    super(describeError(code));
    this.code = code;
    this.status = status;
  }
}

export class ApiClient {
  register(name) {
    return this.#sendJson("POST", "/api/register", { name });
  }

  login(code) {
    return this.#sendJson("POST", "/api/login", { code });
  }

  logout() {
    return this.#request("/api/logout", { method: "POST" });
  }

  getMe() {
    return this.#request("/api/me");
  }

  listChats() {
    return this.#request("/api/chats");
  }

  openChat(peerId) {
    return this.#sendJson("POST", "/api/chats", { peerId });
  }

  getMessages(chatId, cursor = {}) {
    const query = new URLSearchParams(cursor).toString();
    return this.#request(`/api/chats/${chatId}/messages?${query}`);
  }

  uploadFile(file) {
    return this.#request("/api/files", {
      method: "PUT",
      headers: { "X-File-Name": encodeURIComponent(file.name) },
      body: file,
      // A large file on a slow line may rightly take much longer.
      signal: null,
    });
  }

  #sendJson(method, path, body) {
    return this.#request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async #request(path, options) {
    let response;
    try {
      // Over a dead connection the browser would wait for minutes, and requests
      // left hanging also use up the few connections it allows for one server.
      response = await fetch(path, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...options,
      });
    } catch {
      throw new ApiError("network");
    }

    if (response.status === 204) {
      return null;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(body?.error?.code, response.status);
    }
    return body;
  }
}
