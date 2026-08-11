import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { SERVER_INSTRUCTIONS } from "../src/server.js";
import packageMetadata from "../package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const children: ChildProcessWithoutNullStreams[] = [];
const temporaryRoots: string[] = [];

beforeAll(async () => {
  await execFileAsync(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.build.json",
  ]);
}, 30_000);

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }),
  );
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

describe("stdio transport", () => {
  it("handles initialize, tools/list, and a tool call with JSON-RPC-only stdout", async () => {
    const child = spawn(process.execPath, ["dist/cli.js"], {
      cwd: process.cwd(),
      env: { ...process.env, NOTION_TOKEN: "" },
      stdio: "pipe",
    });
    children.push(child);
    const responses = new Map<number, JsonRpcResponse>();
    const stdoutLines: string[] = [];
    let stdoutBuffer = "";
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        stdoutLines.push(line);
        const message = JSON.parse(line) as JsonRpcResponse;
        if (typeof message.id === "number") responses.set(message.id, message);
      }
    });

    const request = (id: number, method: string, params: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    const waitFor = async (id: number): Promise<JsonRpcResponse> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const response = responses.get(id);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for JSON-RPC response ${id}`);
    };

    request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "1.0.0" },
    });
    const initialized = await waitFor(1);
    expect(initialized.error).toBeUndefined();
    expect(initialized.result?.["instructions"]).toBe(SERVER_INSTRUCTIONS);
    expect(initialized.result?.["serverInfo"]).toMatchObject({
      name: packageMetadata.name,
      version: packageMetadata.version,
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    request(2, "tools/list", {});
    const listed = await waitFor(2);
    const tools = listed.result?.["tools"] as Array<{
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
      outputSchema?: { properties?: Record<string, unknown> };
    }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "notion_read_document",
      "notion_publish_document",
    ]);
    expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["source", "sources"]),
    );
    expect(Object.keys(tools[1]?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["target", "operation", "operations", "markdown", "pages"]),
    );
    for (const tool of tools) {
      expect(Object.keys(tool.outputSchema?.properties ?? {})).toEqual(
        expect.arrayContaining(["status", "summary"]),
      );
    }

    request(3, "tools/call", { name: "notion_read_document", arguments: {} });
    const called = await waitFor(3);
    expect(called.error).toBeUndefined();
    expect(called.result?.["isError"]).toBe(true);

    expect(stdoutLines.length).toBeGreaterThanOrEqual(3);
    for (const line of stdoutLines) expect(() => JSON.parse(line)).not.toThrow();
    expect(stdoutLines.join("\n")).not.toContain("server_started");
    expect(stderr).toContain("server_started");
  });

  it("starts the CLI from the packed npm tarball with public input schemas", async () => {
    const root = await mkdtemp(join(tmpdir(), "notion-ops-package-"));
    temporaryRoots.push(root);
    await execFileAsync(
      "npm",
      ["pack", "--silent", "--pack-destination", root, "--cache", join(root, "npm-cache")],
      { cwd: process.cwd() },
    );
    const archive = (await readdir(root)).find((name) => name.endsWith(".tgz"));
    if (!archive) throw new Error("npm pack did not produce a tarball");
    await execFileAsync("tar", ["-xzf", join(root, archive), "-C", root]);
    const packageRoot = join(root, "package");
    await symlink(join(process.cwd(), "node_modules"), join(packageRoot, "node_modules"), "dir");

    const child = spawn(process.execPath, [join(packageRoot, "dist", "cli.js")], {
      cwd: packageRoot,
      env: {
        ...process.env,
        NOTION_TOKEN: "",
        XDG_CONFIG_HOME: join(root, "config"),
      },
      stdio: "pipe",
    });
    children.push(child);
    const responses = new Map<number, JsonRpcResponse>();
    let stdoutBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const message = JSON.parse(line) as JsonRpcResponse;
        if (typeof message.id === "number") responses.set(message.id, message);
      }
    });

    const request = (id: number, method: string, params: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    };
    const waitFor = async (id: number): Promise<JsonRpcResponse> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const response = responses.get(id);
        if (response) return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for packed JSON-RPC response ${id}`);
    };

    request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "packed-stdio-test", version: "1.0.0" },
    });
    await expect(waitFor(1)).resolves.toMatchObject({
      id: 1,
      result: {
        instructions: SERVER_INSTRUCTIONS,
        serverInfo: { name: packageMetadata.name, version: packageMetadata.version },
      },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    request(2, "tools/list", {});
    const listed = await waitFor(2);
    const tools = listed.result?.["tools"] as Array<{
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
    }>;

    expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["source", "sources"]),
    );
    expect(Object.keys(tools[1]?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["target", "operation", "operations", "markdown", "pages"]),
    );
  });
});
