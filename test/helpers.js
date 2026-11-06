import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ENTRY_POINT = fileURLToPath(
  new URL("../server/index.js", import.meta.url),
);

export async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "messenger-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function startProcess(t, env) {
  const child = spawn(process.execPath, [ENTRY_POINT], {
    // TRUST_PROXY exported in the shell would change what the tests expect.
    env: { ...process.env, HOST: "127.0.0.1", TRUST_PROXY: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));

  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output.stderr += chunk;
  });

  // Subscribed right after spawn so that a fast exit cannot be missed.
  const exited = once(child, "close");
  return { child, output, exited };
}

export async function startServer(t, env = {}) {
  const dataDir = env.DATA_DIR ?? (await makeTempDir(t));
  const server = startProcess(t, { PORT: "0", ...env, DATA_DIR: dataDir });

  while (!/http:\/\/\S+/.test(server.output.stdout)) {
    if (server.child.exitCode !== null) {
      throw new Error(`Server exited early: ${server.output.stderr}`);
    }
    await once(server.child.stdout, "data");
  }
  const url = server.output.stdout.match(/http:\/\/\S+/)[0];
  return { ...server, url, dataDir };
}

export function maskedFrame(firstByte, payload) {
  const mask = [1, 2, 3, 4];
  const body = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));

  let lengthBytes;
  if (payload.length < 126) {
    lengthBytes = [0x80 | payload.length];
  } else if (payload.length < 65536) {
    lengthBytes = [0x80 | 126, payload.length >> 8, payload.length & 0xff];
  } else {
    const longLength = Buffer.alloc(8);
    longLength.writeBigUInt64BE(BigInt(payload.length));
    lengthBytes = [0x80 | 127, ...longLength];
  }
  return Buffer.concat([
    Buffer.from([firstByte, ...lengthBytes, ...mask]),
    body,
  ]);
}

export function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export async function registerUser(baseUrl, name) {
  const response = await postJson(`${baseUrl}/api/register`, { name });
  return response.json();
}

// A real WebSocket client that lets a test wait for the next event of a type.
export class TestSocket {
  #socket;
  #events = [];
  #waiters = [];

  static async open(t, baseUrl, cookie) {
    const socket = new TestSocket(baseUrl, cookie);
    t.after(() => socket.close());
    await once(socket.#socket, "open");
    return socket;
  }

  constructor(baseUrl, cookie) {
    this.#socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
      headers: { Cookie: cookie, Origin: baseUrl },
    });
    this.#socket.addEventListener("message", ({ data }) => {
      this.#events.push(JSON.parse(data));
      this.#wakeWaiters();
    });
  }

  send(type, payload) {
    this.#socket.send(JSON.stringify({ type, payload }));
  }

  next(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No "${type}" event arrived`)),
        3000,
      );
      this.#waiters.push({ type, resolve, timer });
      this.#wakeWaiters();
    });
  }

  // Waits for the server to answer a later request, then lists unclaimed events.
  async pending(type) {
    await delay(50);
    return this.#events.filter((event) => event.type === type);
  }

  closed() {
    return once(this.#socket, "close").then(([event]) => event.code);
  }

  close() {
    this.#socket.close();
  }

  #wakeWaiters() {
    for (const waiter of [...this.#waiters]) {
      const index = this.#events.findIndex((e) => e.type === waiter.type);
      if (index !== -1) {
        const [event] = this.#events.splice(index, 1);
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(event.payload);
      }
    }
  }
}

// Registers and signs in, returning what a browser would hold afterwards.
export async function signUp(baseUrl, name) {
  const { user, code } = await registerUser(baseUrl, name);
  const response = await postJson(`${baseUrl}/api/login`, { code });
  const cookie = response.headers.get("set-cookie").split(";")[0];
  return { user, code, cookie };
}
