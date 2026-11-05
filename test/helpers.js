import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    env: { ...process.env, HOST: "127.0.0.1", ...env },
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

export async function startServer(t, dataDir) {
  const directory = dataDir ?? (await makeTempDir(t));
  const server = startProcess(t, { PORT: "0", DATA_DIR: directory });

  while (!/http:\/\/\S+/.test(server.output.stdout)) {
    if (server.child.exitCode !== null) {
      throw new Error(`Server exited early: ${server.output.stderr}`);
    }
    await once(server.child.stdout, "data");
  }
  const url = server.output.stdout.match(/http:\/\/\S+/)[0];
  return { ...server, url, dataDir: directory };
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

// Registers and signs in, returning what a browser would hold afterwards.
export async function signUp(baseUrl, name) {
  const { user, code } = await registerUser(baseUrl, name);
  const response = await postJson(`${baseUrl}/api/login`, { code });
  const cookie = response.headers.get("set-cookie").split(";")[0];
  return { user, code, cookie };
}
