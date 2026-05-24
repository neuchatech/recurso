#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(`Usage:
  node scripts/session-cache-report.mjs [options]

Options:
  --session-dir <dir>   Pi session directory to scan. Defaults to the current
                        workspace's normal Pi session directory.
  --cwd <dir>           Workspace cwd used to infer Pi's default session folder.
                        Default: current directory.
  --json                Print JSON instead of a table.
  --help, -h            Show this help.

The report reads Pi JSONL session files and sums assistant message usage fields:
input, output, cacheRead, cacheWrite, totalTokens, and cost.total.
`);
  process.exit(0);
}

const cwd = path.resolve(options.cwd || process.cwd());
const sessionDir = options.sessionDir
  ? path.resolve(options.sessionDir)
  : path.join(os.homedir(), ".pi", "agent", "sessions", safePiCwd(cwd));

if (!fs.existsSync(sessionDir)) {
  fail(`Session directory does not exist: ${sessionDir}`);
}

const files = fs
  .readdirSync(sessionDir)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => path.join(sessionDir, name))
  .sort();

const sessions = files.map(readSessionUsage).filter((session) => session.messages > 0);
const totals = sumUsage(sessions.map((session) => session.usage));
const result = {
  sessionDir,
  sessionCount: sessions.length,
  totals,
  sessions,
};

if (options.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printTable(result);
}

function readSessionUsage(file) {
  const session = {
    file,
    name: path.basename(file),
    provider: undefined,
    model: undefined,
    responseModel: undefined,
    messages: 0,
    usage: emptyUsage(),
  };

  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const message = entry?.message;
    if (!message || message.role !== "assistant" || !message.usage) continue;

    session.messages += 1;
    session.provider ||= message.provider;
    session.model ||= message.model;
    session.responseModel ||= message.responseModel;
    addUsage(session.usage, message.usage);
  }

  return session;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costTotal: 0,
  };
}

function addUsage(target, usage) {
  target.input += number(usage.input);
  target.output += number(usage.output);
  target.cacheRead += number(usage.cacheRead);
  target.cacheWrite += number(usage.cacheWrite);
  target.totalTokens += number(usage.totalTokens);
  target.costTotal += number(usage.costTotal ?? usage.cost?.total);
}

function sumUsage(usages) {
  const total = emptyUsage();
  for (const usage of usages) addUsage(total, usage);
  return total;
}

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function printTable(result) {
  console.log(`Session dir: ${result.sessionDir}`);
  console.log(
    `Totals: input=${result.totals.input} output=${result.totals.output} cacheRead=${result.totals.cacheRead} cacheWrite=${result.totals.cacheWrite} totalTokens=${result.totals.totalTokens} cost=$${result.totals.costTotal.toFixed(6)}`,
  );
  console.log("");

  const rows = result.sessions.map((session) => [
    session.messages,
    session.usage.input,
    session.usage.output,
    session.usage.cacheRead,
    session.usage.cacheWrite,
    `$${session.usage.costTotal.toFixed(6)}`,
    truncate(session.responseModel || session.model || "", 28),
    session.name,
  ]);

  printRows([
    ["turns", "input", "output", "cacheRead", "cacheWrite", "cost", "model", "session"],
    ...rows,
  ]);
}

function printRows(rows) {
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => String(row[index]).length)),
  );
  rows.forEach((row, rowIndex) => {
    const line = row
      .map((cell, index) => String(cell).padEnd(widths[index]))
      .join("  ");
    console.log(line);
    if (rowIndex === 0) {
      console.log(widths.map((width) => "-".repeat(width)).join("  "));
    }
  });
}

function truncate(value, max) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function safePiCwd(cwd) {
  return `--${cwd.split(path.sep).filter(Boolean).join("-")}--`;
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--session-dir") parsed.sessionDir = args[++i];
    else if (arg === "--cwd") parsed.cwd = args[++i];
    else fail(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function fail(message) {
  console.error(`session-cache-report: ${message}`);
  process.exit(1);
}
