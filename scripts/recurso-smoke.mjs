#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.size === 0) {
  console.log(`Usage:
  node scripts/recurso-smoke.mjs --static
  node scripts/recurso-smoke.mjs --offline-pi
  node scripts/recurso-smoke.mjs --live

--static     Bundle the extension and pack the package.
--offline-pi Load Recurso in Pi RPC offline mode and verify commands/skills.
--live       Create one real Recurso child thread and verify Pi-history files.
`);
  process.exit(args.size === 0 ? 1 : 0);
}

let failed = false;

if (args.has("--static")) {
  run("npx", [
    "--yes",
    "esbuild",
    "extensions/recurso/index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--external:@earendil-works/pi-ai",
    "--external:@earendil-works/pi-coding-agent",
    "--external:typebox",
    "--outfile=/tmp/recurso-index.mjs",
  ]);
  run("npm", ["pack", "--pack-destination", "/tmp"]);
}

if (args.has("--offline-pi")) {
  await runPiOffline();
}

if (args.has("--live")) {
  await runLiveHistorySmoke();
}

process.exit(failed ? 1 : 0);

function run(command, commandArgs, options = {}) {
  log(`$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    failed = true;
    log(`failed: ${command} exited ${result.status}`);
  }
}

async function runPiOffline() {
  const pi = findPi();
  const input = '{"id":"state","type":"get_state"}\n{"id":"commands","type":"get_commands"}\n';
  const result = spawnSync(pi, ["-e", root, "--no-extensions", "--offline", "--mode", "rpc"], {
    cwd: root,
    input,
    encoding: "utf8",
    env: process.env,
  });

  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || "");
    log(`failed: ${pi} offline RPC exited ${result.status}`);
    return;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  assert(output.includes("recurso-status"), "offline RPC exposed recurso-status");
  assert(output.includes("recurso-dashboard"), "offline RPC exposed recurso-dashboard");
  assert(output.includes("skill:recurso"), "offline RPC exposed /skill:recurso");
}

async function runLiveHistorySmoke() {
  const pi = findPi();
  const workspace = process.cwd();
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(workspace, ".pi", "agent");
  const sessionDir = path.join(agentDir, "sessions", safeCwd(workspace));
  const before = new Set(fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir) : []);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const provider = process.env.RECURSO_TEST_PROVIDER || "openrouter";
  const model = process.env.RECURSO_TEST_MODEL || "deepseek/deepseek-v4-flash";

  const prompt = [
    "Use /skill:recurso.",
    "Start one fresh Recurso thread named History Smoke.",
    'Its task is: immediately call recurso_message_thread target parent type done with message "history smoke child done" and then stop.',
    'After it reports, reply exactly "history smoke complete". Do not write files.',
  ].join(" ");

  const child = spawn(pi, ["-e", root, "--no-extensions", "--mode", "rpc", "--provider", provider, "--model", model, "--thinking", "high"], {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let stderr = "";
  let nextId = 1;
  let childId = "";
  let complete = false;
  let modelError = "";

  const send = (command) => {
    child.stdin.write(`${JSON.stringify({ id: `smoke_${nextId++}`, ...command })}\n`);
  };

  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-6000);
  });

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event.type === "tool_execution_end" && event.toolName === "recurso_new_thread") {
        log("saw recurso_new_thread");
        const match = JSON.stringify(event).match(/th-[a-z0-9]+-[a-z0-9]+/);
        if (match) childId = match[0];
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = (event.message.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
        if (text.includes("history smoke complete")) complete = true;
        if (event.message.stopReason === "error") {
          modelError = event.message.errorMessage || "model error";
          complete = false;
        }
      }
    }
  });

  send({ type: "prompt", message: prompt, streamingBehavior: "followUp" });

  await waitFor(() => complete || Boolean(modelError), 180000);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));

  if (modelError) {
    failed = true;
    log(`live smoke model error: ${modelError}`);
    return;
  }

  if (!complete) {
    failed = true;
    log(`live smoke did not complete. stderr tail:\n${stderr}`);
    return;
  }

  const after = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir) : [];
  const added = after.filter((name) => !before.has(name));
  const matching = added.filter((name) => {
    const file = path.join(sessionDir, name);
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return false;
    }
    return raw.includes("History Smoke") || raw.includes("history smoke child done") || (childId && raw.includes(childId));
  });

  assert(matching.length >= 2, "live smoke wrote parent and child sessions into Pi history");
}

function findPi() {
  const pi = process.env.RECURSO_PI_BIN || "pi";
  const result = spawnSync(pi, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not run ${pi}. Install Pi or set RECURSO_PI_BIN.`);
  }
  return pi;
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function safeCwd(cwd) {
  return `-${cwd.replace(/\//g, "-")}--`;
}

function assert(condition, message) {
  if (condition) {
    log(`ok: ${message}`);
    return;
  }
  failed = true;
  log(`failed: ${message}`);
}

function log(message) {
  console.log(`[recurso-smoke] ${message}`);
}
