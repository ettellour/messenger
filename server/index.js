import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthService } from "./auth/AuthService.js";
import { Server } from "./http/Server.js";
import { JsonStore } from "./storage/JsonStore.js";
import { SessionRepository } from "./storage/SessionRepository.js";
import { UserRepository } from "./storage/UserRepository.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

function readPort() {
  const value = process.env.PORT || "3000";
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new Error(`PORT must be a number from 0 to 65535, got "${value}"`);
  }
  return port;
}

async function createServerFromEnv() {
  const dataDir = resolve(process.env.DATA_DIR || "data");
  const store = (name, initialData) =>
    new JsonStore(join(dataDir, `${name}.json`), initialData);

  const users = new UserRepository(store("users", { users: [] }));
  const sessions = new SessionRepository(store("sessions", { sessions: [] }));
  await Promise.all([users.load(), sessions.load()]);

  const auth = new AuthService({ users, sessions });
  return new Server({ auth, publicDir: PUBLIC_DIR });
}

async function main() {
  const port = readPort();
  const server = await createServerFromEnv();

  const url = await server.listen(port, process.env.HOST || "127.0.0.1");

  const shutDown = async () => {
    await server.stop();
    console.log("Messenger stopped");
  };
  process.once("SIGINT", shutDown);
  process.once("SIGTERM", shutDown);

  // Announced last: whoever waits for this line may send a signal right away.
  console.log(`Messenger is running at ${url}`);
}

try {
  await main();
} catch (error) {
  console.error(
    error.code === "EADDRINUSE"
      ? "This port is already in use. Set the PORT variable to another value."
      : error.message,
  );
  process.exitCode = 1;
}
