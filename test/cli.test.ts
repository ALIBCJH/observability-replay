import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { VERSION } from "../src/server.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("the version in the code matches package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
  assert.equal(VERSION, pkg.version);
  assert.equal((await run("node", [cli, "--version"])).stdout.trim(), pkg.version);
});

test("help lists the subcommands and an unknown one is refused", async () => {
  const help = (await run("node", [cli, "--help"])).stdout;
  assert.match(help, /observability-replay live/);
  assert.match(help, /benchmark observe/);
  await assert.rejects(run("node", [cli, "nonsense"]), (e: { code?: number }) => e.code === 2);
});

/** Start the command, send one MCP initialize, and return the first reply line. */
function initialize(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [file], { env: { ...process.env, OBS_BACKEND: "demo" }, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("no reply from the server"));
    }, 10_000);
    child.stdout.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      child.kill();
      resolve(chunk.toString().split("\n")[0]!);
    });
    child.on("error", reject);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`,
    );
  });
}

test("with no arguments the command is the MCP server, also when started through a link", async () => {
  assert.match(await initialize(cli), /"serverInfo":\{"name":"observability-replay"/);
  // npm installs a package's command as a symbolic link.
  const link = join(await mkdtemp(join(tmpdir(), "obs-cli-")), "observability-replay");
  await symlink(cli, link);
  assert.match(await initialize(link), /"serverInfo":\{"name":"observability-replay"/);
  const server = join(await mkdtemp(join(tmpdir(), "obs-srv-")), "server-link");
  await symlink(fileURLToPath(new URL("../dist/server.js", import.meta.url)), server);
  assert.match(await initialize(server), /"serverInfo":\{"name":"observability-replay"/);
});
