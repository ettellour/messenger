import { ApiClient, describeError } from "./api.js";
import { ChatList } from "./chat-list.js";
import { ChatView } from "./chat-view.js";
import { formatUserId } from "./format.js";
import { SocketClient } from "./socket.js";
import { copyToClipboard, showError } from "./ui.js";

const SCREENS = ["sign-in", "register", "new-code", "messenger"];
const CHAT_ROUTE = /^#\/chat\/(\w+)$/;

function byId(id) {
  return document.getElementById(id);
}

// Runs a form's action with its button disabled, and shows what went wrong.
async function submitForm(form, errorElement, action) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showError(errorElement, "");
  try {
    await action();
  } catch (error) {
    showError(errorElement, error.message);
  } finally {
    button.disabled = false;
  }
}

class App {
  #api = new ApiClient();
  #socket = new SocketClient();
  #chatList = new ChatList(this.#api);
  #chatView = new ChatView(this.#api, this.#socket);
  #newCode = null;

  constructor() {
    this.#listenToForms();
    this.#listenToSocket();
    window.addEventListener("hashchange", () => this.#openChatFromRoute());
    window.addEventListener("beforeunload", (event) => {
      if (this.#socket.hasUnconfirmedMessages) {
        event.preventDefault();
      }
    });
  }

  async start() {
    try {
      const { user } = await this.#api.getMe();
      await this.#enterMessenger(user);
    } catch {
      this.#showScreen("sign-in");
    }
  }

  #showScreen(name) {
    for (const screen of SCREENS) {
      byId(screen).hidden = screen !== name;
    }
  }

  #listenToForms() {
    const loginForm = byId("login-form");
    loginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitForm(loginForm, byId("login-error"), async () => {
        const { user } = await this.#api.login(byId("login-code").value);
        byId("login-code").value = "";
        await this.#enterMessenger(user);
      });
    });

    const registerForm = byId("register-form");
    registerForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitForm(registerForm, byId("register-error"), async () => {
        const { code } = await this.#api.register(byId("register-name").value);
        this.#showNewCode(code);
      });
    });

    byId("show-register").addEventListener("click", () => {
      this.#showScreen("register");
      byId("register-name").focus();
    });
    byId("show-login").addEventListener("click", () => {
      this.#showScreen("sign-in");
      byId("login-code").focus();
    });

    byId("copy-new-code").addEventListener("click", (event) => {
      copyToClipboard(event.target, this.#newCode, byId("new-code-value"));
    });
    byId("code-saved").addEventListener("click", () =>
      this.#signInWithNewCode(),
    );

    byId("copy-id").addEventListener("click", (event) => {
      copyToClipboard(event.target, byId("me-id").textContent, byId("me-id"));
    });
    byId("logout").addEventListener("click", () => this.#logout());

    const newChatForm = byId("new-chat-form");
    newChatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitForm(newChatForm, byId("new-chat-error"), () =>
        this.#openNewChat(),
      );
    });
  }

  #listenToSocket() {
    const socket = this.#socket;

    socket.addEventListener("connected", ({ detail }) => {
      byId("connection-banner").hidden = true;
      this.#chatView.refreshConnectionState();
      if (detail.wasReconnecting) {
        this.#chatList.load();
        this.#chatView.catchUp();
      }
    });
    socket.addEventListener("disconnected", () => {
      byId("connection-banner").hidden = false;
      this.#chatView.refreshConnectionState();
      this.#signOutIfSessionIsGone();
    });
    socket.addEventListener("session-ended", () => this.#leaveMessenger());

    socket.addEventListener("message.new", ({ detail }) => {
      this.#chatView.showMessage(detail.message);
    });
    socket.addEventListener("message.sent", ({ detail }) => {
      this.#chatView.confirmMessage(detail.clientId, detail.message);
    });
    socket.addEventListener("chat.updated", ({ detail }) => {
      this.#chatList.update(detail.chat);
    });
    socket.addEventListener("error", ({ detail }) => {
      if (detail.clientId) {
        this.#chatView.failMessage(detail.clientId, detail.code);
      }
    });
  }

  #showNewCode(code) {
    this.#newCode = code;
    byId("new-code-value").textContent = code;
    showError(byId("new-code-error"), "");
    this.#showScreen("new-code");
  }

  async #signInWithNewCode() {
    const button = byId("code-saved");
    button.disabled = true;
    showError(byId("new-code-error"), "");
    try {
      const { user } = await this.#api.login(this.#newCode);
      this.#newCode = null;
      byId("new-code-value").textContent = "";
      byId("register-name").value = "";
      await this.#enterMessenger(user);
    } catch (error) {
      showError(byId("new-code-error"), error.message);
    } finally {
      button.disabled = false;
    }
  }

  async #enterMessenger(user) {
    byId("me-name").textContent = user.name;
    byId("me-id").textContent = formatUserId(user.id);
    this.#chatList.reset(user.id);
    this.#chatView.reset(user.id);
    this.#showScreen("messenger");

    this.#socket.connect();
    await this.#chatList.load();
    this.#openChatFromRoute();
  }

  async #openNewChat() {
    const { chat } = await this.#api.openChat(byId("peer-id").value);
    byId("peer-id").value = "";
    this.#chatList.update(chat);
    location.hash = `#/chat/${chat.id}`;
  }

  #openChatFromRoute() {
    const chatId = location.hash.match(CHAT_ROUTE)?.[1] ?? null;
    const chat = chatId && this.#chatList.find(chatId);

    byId("messenger").toggleAttribute("data-chat-open", Boolean(chat));
    this.#chatList.setOpenChat(chat?.id ?? null);
    if (chat) {
      if (chat.id !== this.#chatView.openChatId) {
        this.#chatView.open(chat);
      }
    } else {
      this.#chatView.close();
    }
  }

  async #signOutIfSessionIsGone() {
    try {
      await this.#api.getMe();
    } catch (error) {
      if (error.status === 401) {
        this.#leaveMessenger();
      }
    }
  }

  async #logout() {
    try {
      await this.#api.logout();
      this.#leaveMessenger();
    } catch {
      showError(byId("new-chat-error"), describeError("network"));
    }
  }

  #leaveMessenger() {
    this.#socket.disconnect();
    this.#chatView.reset(null);
    this.#chatList.reset(null);
    byId("connection-banner").hidden = true;
    byId("messenger").removeAttribute("data-chat-open");
    history.replaceState(null, "", location.pathname);
    this.#showScreen("sign-in");
  }
}

new App().start();
