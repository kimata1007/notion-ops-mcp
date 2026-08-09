import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const children: ChildProcessWithoutNullStreams[] = [];

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
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    request(2, "tools/list", {});
    const listed = await waitFor(2);
    const tools = (listed.result?.["tools"] as Array<{ name: string }>).map((tool) => tool.name);
    expect(tools).toEqual(["notion_read_document", "notion_publish_document"]);

    request(3, "tools/call", { name: "notion_read_document", arguments: {} });
    const called = await waitFor(3);
    expect(called.error).toBeUndefined();
    expect(called.result?.["isError"]).toBe(true);

    expect(stdoutLines.length).toBeGreaterThanOrEqual(3);
    for (const line of stdoutLines) expect(() => JSON.parse(line)).not.toThrow();
    expect(stdoutLines.join("\n")).not.toContain("server_started");
    expect(stderr).toContain("server_started");
  });
});
