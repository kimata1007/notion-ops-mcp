import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultCredentialPath, FileCredentialStore } from "../../src/auth/file-store.js";
import { credential } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("FileCredentialStore", () => {
  it("writes atomically with owner-only directory and file permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "notion-ops-auth-"));
    temporaryDirectories.push(root);
    const path = join(root, "nested", "credentials.json");
    const store = new FileCredentialStore(path);

    await store.save(credential());

    expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual(credential());
  });

  it("rejects credentials readable by another user and symlink targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "notion-ops-auth-"));
    temporaryDirectories.push(root);
    const path = join(root, "credentials.json");
    const store = new FileCredentialStore(path);
    await store.save(credential());
    await chmod(path, 0o644);
    await expect(store.load()).rejects.toThrow(/owner-only/);

    await rm(path);
    await mkdir(join(root, "target"));
    await symlink(join(root, "target"), path);
    await expect(store.load()).rejects.toThrow(/symlink/);
  });

  it("uses the documented OS configuration directories", () => {
    expect(defaultCredentialPath("darwin", {}, "/Users/alice")).toBe(
      "/Users/alice/Library/Application Support/notion-ops-mcp/credentials.json",
    );
    expect(defaultCredentialPath("linux", { XDG_CONFIG_HOME: "/config" }, "/home/alice")).toBe(
      "/config/notion-ops-mcp/credentials.json",
    );
    expect(defaultCredentialPath("win32", { APPDATA: "C:\\Users\\alice\\AppData" }, "unused")).toBe(
      "C:\\Users\\alice\\AppData/notion-ops-mcp/credentials.json",
    );
  });
});
