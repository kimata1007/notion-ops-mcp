import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { OpsError } from "../errors.js";
import { StoredCredentialSchema, type CredentialStore, type StoredCredential } from "./types.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

export function defaultCredentialPath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const xdg = environment["XDG_CONFIG_HOME"];
  if (xdg) return join(xdg, "notion-ops-mcp", "credentials.json");
  if (platform === "win32") {
    const appData = environment["APPDATA"];
    if (!appData) throw new OpsError("failed", "APPDATA is required for credential storage");
    return join(appData, "notion-ops-mcp", "credentials.json");
  }
  if (platform === "darwin") {
    return join(
      homeDirectory,
      "Library",
      "Application Support",
      "notion-ops-mcp",
      "credentials.json",
    );
  }
  return join(homeDirectory, ".config", "notion-ops-mcp", "credentials.json");
}

async function ensureNotSymlink(path: string): Promise<void> {
  try {
    const file = await lstat(path);
    if (file.isSymbolicLink())
      throw new OpsError("failed", "credential path must not be a symlink");
  } catch (error) {
    const code =
      error !== null && typeof error === "object"
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code !== "ENOENT") throw error;
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(path = defaultCredentialPath()) {
    this.path = path;
  }

  async load(): Promise<StoredCredential | undefined> {
    try {
      await ensureNotSymlink(this.path);
      const info = await stat(this.path);
      if (!info.isFile()) throw new OpsError("failed", "credential path is not a regular file");
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        throw new OpsError("failed", "credential file permissions are not owner-only");
      }
      if (info.size > MAX_CREDENTIAL_BYTES) {
        throw new OpsError("failed", "credential file is unexpectedly large");
      }
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const credential = StoredCredentialSchema.safeParse(parsed);
      if (!credential.success) throw new OpsError("failed", "credential file is invalid");
      return credential.data;
    } catch (error) {
      const code =
        error !== null && typeof error === "object"
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw new OpsError("failed", "credential file is invalid");
      throw error;
    }
  }

  async save(credential: StoredCredential): Promise<void> {
    const validated = StoredCredentialSchema.parse(credential);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await ensureNotSymlink(directory);
    if (process.platform !== "win32") await chmod(directory, 0o700);
    await ensureNotSymlink(this.path);

    const temporaryPath = join(directory, `.credentials-${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.path);
      if (process.platform !== "win32") await chmod(this.path, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async clear(): Promise<void> {
    await ensureNotSymlink(this.path);
    await rm(this.path, { force: true });
  }
}
