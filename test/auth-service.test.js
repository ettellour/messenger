import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AuthService,
  SESSION_LIFETIME_MS,
} from "../server/auth/AuthService.js";
import { JsonStore } from "../server/storage/JsonStore.js";
import { SessionRepository } from "../server/storage/SessionRepository.js";
import { UserRepository } from "../server/storage/UserRepository.js";
import { makeTempDir } from "./helpers.js";

async function createAuth(t, now) {
  const dir = await makeTempDir(t);
  const users = new UserRepository(
    new JsonStore(join(dir, "users.json"), { users: [] }),
  );
  const sessions = new SessionRepository(
    new JsonStore(join(dir, "sessions.json"), { sessions: [] }),
  );
  await Promise.all([users.load(), sessions.load()]);
  return { auth: new AuthService({ users, sessions, now }), dir };
}

describe("AuthService", () => {
  it("issues a readable 16 character code", async (t) => {
    const { auth } = await createAuth(t);

    const { code } = await auth.register("Анна");

    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  });

  it("signs in with the code however it was typed", async (t) => {
    const { auth } = await createAuth(t);
    const { user, code } = await auth.register("Анна");

    const typedVariants = [
      code,
      code.toLowerCase(),
      code.replaceAll("-", " "),
      code.replaceAll("-", "").replaceAll("0", "O").replaceAll("1", "l"),
    ];

    for (const typed of typedVariants) {
      const session = await auth.login(typed);
      assert.equal(session.user.id, user.id);
    }
  });

  it("does not store the code or the session token in plain text", async (t) => {
    const { auth, dir } = await createAuth(t);
    const { code } = await auth.register("Анна");
    const { token } = await auth.login(code);

    const stored =
      (await readFile(join(dir, "users.json"), "utf8")) +
      (await readFile(join(dir, "sessions.json"), "utf8"));

    assert.ok(!stored.includes(code.replaceAll("-", "")));
    assert.ok(!stored.includes(token));
  });

  for (const wrongCode of ["", "short", "0000-0000-0000-0000", 42, null]) {
    it(`rejects the code ${JSON.stringify(wrongCode)}`, async (t) => {
      const { auth } = await createAuth(t);
      await auth.register("Анна");

      await assert.rejects(auth.login(wrongCode), { code: "invalid_code" });
    });
  }

  for (const badName of ["", "   ", "x".repeat(41), 42, undefined]) {
    it(`rejects the name ${JSON.stringify(badName)}`, async (t) => {
      const { auth } = await createAuth(t);

      await assert.rejects(auth.register(badName), { code: "invalid_name" });
    });
  }

  it("collapses extra spaces in the name", async (t) => {
    const { auth } = await createAuth(t);

    const { user } = await auth.register("  Анна   Петрова ");

    assert.equal(user.name, "Анна Петрова");
  });

  it("forgets the session after logout", async (t) => {
    const { auth } = await createAuth(t);
    const { code } = await auth.register("Анна");
    const { token } = await auth.login(code);
    assert.ok(await auth.findSession(token));

    await auth.logout(token);

    assert.equal(await auth.findSession(token), null);
  });

  it("expires a session after its lifetime", async (t) => {
    let time = 1000;
    const { auth } = await createAuth(t, () => time);
    const { code } = await auth.register("Анна");
    const { token } = await auth.login(code);

    time += SESSION_LIFETIME_MS - 1;
    assert.ok(await auth.findSession(token));

    time += 1;
    assert.equal(await auth.findSession(token), null);
  });

  it("ignores a missing session token", async (t) => {
    const { auth } = await createAuth(t);

    assert.equal(await auth.findSession(null), null);
  });
});
