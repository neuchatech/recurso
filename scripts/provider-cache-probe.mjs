#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(`Usage:
  node scripts/provider-cache-probe.mjs --provider <provider> --model <model> [options]

Options:
  --provider <name>       Pi provider name.
  --model <id>            Pi model id.
  --thinking <level>      Pi thinking level. Default: high.
  --corpus-lines <n>      Stable corpus size. Default: 260.
  --workdir <dir>         Pi cwd. Default: current directory.
  --label <text>          Stable run label. Default: random per run.
  --settle-ms <n>         Wait after seed/fork requests for async cache construction.
  --order <name>          Continuation order: fork-first, parent-first, or idle-fork-parent-first.
                          Default: fork-first.
  --keep                  Keep raw probe JSONL files and print their directory.

The probe creates an isolated session dir, seeds a parent session, runs one forked
continuation and one same-parent continuation in the requested order, then reports
assistant usage.
`);
  process.exit(0);
}

if (!options.provider || !options.model) {
  fail("Missing --provider or --model. Use --help for usage.");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "recurso-provider-cache-"));
const sessionDir = path.join(root, "sessions");
fs.mkdirSync(sessionDir, { recursive: true });

const pi = process.env.RECURSO_PI_BIN || "pi";
const workdir = options.workdir ? path.resolve(options.workdir) : process.cwd();
const thinking = options.thinking || "high";
const corpusLines = Number(options.corpusLines || 260);
const settleMs = Number(options.settleMs || 0);
const order = options.order || "fork-first";
if (!["fork-first", "parent-first", "idle-fork-parent-first"].includes(order)) {
  fail(`Invalid --order ${order}. Expected fork-first, parent-first, or idle-fork-parent-first.`);
}
const runLabel = options.label || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const systemPrompt = `Stable system prompt for Recurso provider cache probe. Provider=${options.provider}; Model=${options.model}; Run=${runLabel}.`;

const corpus = Array.from({ length: corpusLines }, (_, index) => {
  const n = String(index + 1).padStart(3, "0");
  return `RECURSO-CACHE-ANCHOR-${runLabel}-${n}: A stable cache-probe sentence about orchestration, forked threads, and preserved context.`;
}).join("\n");

const seedPrompt = `Stable cache corpus. Reply with exactly PARENT-SEED.\n\n${corpus}`;
const forkPrompt = "Using the stable corpus, reply with exactly FORK-FIRST.";
const parentPrompt = "Using the stable corpus, reply with exactly PARENT-SECOND.";

const common = [
  "--mode",
  "json",
  "--print",
  "--no-tools",
  "--session-dir",
  sessionDir,
  "--provider",
  options.provider,
  "--model",
  `${options.model}:${thinking}`,
  "--system-prompt",
  systemPrompt,
];

const seedOut = path.join(root, "parent-seed.jsonl");
const forkOut = path.join(root, "fork-first.jsonl");
const parentOut = path.join(root, "parent-second.jsonl");

runPi([...common, seedPrompt], seedOut, workdir);
const parentSession = latestSession(sessionDir);
sleep(settleMs);

let forkSession;

if (order === "fork-first") {
  runPi([...common, "--fork", parentSession, forkPrompt], forkOut, workdir);
  forkSession = latestSession(sessionDir);
  sleep(settleMs);

  runPi([...common, "--session", parentSession, parentPrompt], parentOut, workdir);
} else if (order === "parent-first") {
  runPi([...common, "--session", parentSession, parentPrompt], parentOut, workdir);
  sleep(settleMs);

  runPi([...common, "--fork", parentSession, forkPrompt], forkOut, workdir);
  forkSession = latestSession(sessionDir);
} else {
  forkSession = createIdleForkSession(parentSession, sessionDir);
  runPi([...common, "--session", parentSession, parentPrompt], parentOut, workdir);
  sleep(settleMs);

  runPi([...common, "--session", forkSession, forkPrompt], forkOut, workdir);
}

const result = {
  provider: options.provider,
  model: options.model,
  thinking,
  settleMs,
  order,
  runLabel,
  workdir,
  rawDir: options.keep ? root : undefined,
  parentSession,
  forkSession,
  parentSeed: readAssistantResult(seedOut),
  forkFirst: readAssistantResult(forkOut),
  parentSecond: readAssistantResult(parentOut),
};

console.log(JSON.stringify(result, null, 2));

if (!options.keep) {
  fs.rmSync(root, { recursive: true, force: true });
}

function runPi(args, outfile, cwd) {
  const result = spawnSync(pi, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
    env: process.env,
  });
  fs.writeFileSync(outfile, result.stdout || "", "utf8");
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    fail(`${pi} exited ${result.status}`);
  }
}

function latestSession(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  if (!files.length) fail(`No session files in ${dir}`);
  return path.join(dir, files[files.length - 1]);
}

function createIdleForkSession(sourceSessionFile, targetSessionDir) {
  const raw = fs.readFileSync(sourceSessionFile, "utf8");
  const lines = raw.trim().split(/\n/).filter(Boolean);
  if (!lines.length) fail(`Cannot fork empty session ${sourceSessionFile}`);

  const entries = lines.map((line) => JSON.parse(line));
  if (entries[0]?.type !== "session") fail(`First entry in ${sourceSessionFile} is not a session header`);

  const timestamp = new Date().toISOString();
  const sessionId = `recurso-probe-${crypto.randomUUID()}`;
  entries[0] = {
    ...entries[0],
    id: sessionId,
    timestamp,
    parentSession: sourceSessionFile,
  };

  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const forkSessionFile = path.join(targetSessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  fs.writeFileSync(forkSessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return forkSessionFile;
}

function readAssistantResult(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\n/).filter(Boolean);
  let message;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "turn_end" && event.message?.usage) {
        message = event.message;
      }
    } catch {
      // Ignore non-JSON noise.
    }
  }
  if (!message) return { error: "No assistant turn_end found" };
  return {
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    stopReason: message.stopReason,
    usage: message.usage,
    text: (message.content || []).filter((part) => part.type === "text").map((part) => part.text).join(""),
    errorMessage: message.errorMessage,
  };
}

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--keep") parsed.keep = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      parsed[key] = args[++i];
    }
  }
  return parsed;
}

function fail(message) {
  console.error(`provider-cache-probe: ${message}`);
  process.exit(1);
}
