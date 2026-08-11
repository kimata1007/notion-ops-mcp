#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const archiveArgument = process.argv[2];
if (!archiveArgument) throw new Error("usage: smoke-packed-package.mjs <package.tgz>");
const archive = isAbsolute(archiveArgument) ? archiveArgument : resolve(archiveArgument);
const root = await mkdtemp(join(tmpdir(), "notion-ops-installed-"));
let child;

try {
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "notion-ops-smoke", private: true }, null, 2)}\n`,
  );
  await execFileAsync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      join(root, "npm-cache"),
      archive,
    ],
    { cwd: root, timeout: 120_000 },
  );

  const packageRoot = join(root, "node_modules", "notion-ops-mcp");
  const packageMetadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const executable = join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "notion-ops-mcp.cmd" : "notion-ops-mcp",
  );
  await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);

  child = spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      NOTION_TOKEN: "",
      XDG_CONFIG_HOME: join(root, "config"),
    },
    shell: process.platform === "win32",
    stdio: "pipe",
  });
  let stdoutBuffer = "";
  let stderr = "";
  const responses = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === "number") responses.set(message.id, message);
    }
  });

  const request = (id, method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  };
  const waitFor = async (id) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const response = responses.get(id);
      if (response) return response;
      if (child.exitCode !== null) {
        throw new Error(`installed executable exited ${child.exitCode}: ${stderr}`);
      }
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 20));
    }
    throw new Error(`timed out waiting for installed JSON-RPC response ${id}: ${stderr}`);
  };

  request(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "installed-package-smoke", version: "1" },
  });
  const initialized = await waitFor(1);
  if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  request(2, "tools/list");
  const listed = await waitFor(2);
  const tools = listed.result?.tools ?? [];
  const toolNames = tools.map((tool) => tool.name);
  if (
    initialized.result?.serverInfo?.name !== packageMetadata.name ||
    initialized.result?.serverInfo?.version !== packageMetadata.version
  ) {
    throw new Error("installed MCP identity does not match its package.json");
  }
  if (
    toolNames.length !== 2 ||
    toolNames[0] !== "notion_read_document" ||
    toolNames[1] !== "notion_publish_document"
  ) {
    throw new Error(`unexpected installed tools: ${JSON.stringify(toolNames)}`);
  }
  for (const tool of tools) {
    if (Object.keys(tool.inputSchema?.properties ?? {}).length === 0) {
      throw new Error(`${tool.name} published an empty input schema`);
    }
    const outputProperties = Object.keys(tool.outputSchema?.properties ?? {});
    if (!outputProperties.includes("status") || !outputProperties.includes("summary")) {
      throw new Error(`${tool.name} published an incomplete output schema`);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      package: `${packageMetadata.name}@${packageMetadata.version}`,
      archive: basename(archive),
      tools: toolNames,
    })}\n`,
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ]);
  }
  await rm(root, { recursive: true, force: true });
}
