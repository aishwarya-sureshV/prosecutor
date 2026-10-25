#!/usr/bin/env node
/**
 * Run a prosecutor/executor case against any coding CLI.
 *
 * One --cmd plays both roles (the same model is fine). Two commands split
 * the roles. --stdio keeps one process open and speaks JSON lines.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCliSide, createStdioHarness, runCase } from "../src/index.js";

const HELP = `prosecute — adversarial review for any coding CLI

The executor applies the task. The prosecutor may only write tests and must
end with VERDICT: GUILTY or VERDICT: ACQUITTED. Guilty reports go back to the
executor. The diff is verified when your acceptance gate passes.

Both roles can be the same model. Each turn is a separate context unless you
use --stdio, which keeps one process and two roles.

Usage
  prosecute --task "..." --cmd <bin> [--arg <a>]... [options]
  prosecute --task "..." --executor-cmd <bin> --prosecutor-cmd <bin> [options]
  prosecute --stdio --cmd <bin> --task "..."

Options
  --cwd <dir>              workspace (default: the current directory)
  --task <text>            task text
  --task-file <path>       task text from a file
  --cmd <bin>              command for both roles
  --arg <a>                repeatable argument for --cmd
  --executor-cmd <bin>     executor command (defaults to --cmd)
  --executor-arg <a>       repeatable argument for the executor
  --prosecutor-cmd <bin>   prosecutor command (defaults to the executor command)
  --prosecutor-arg <a>     repeatable argument for the prosecutor
  --stdio                  one long-lived process, JSON-line turns
  --prompt-via stdin|json  how a one-shot CLI receives the turn (default stdin)
  --model <id>             passed through to the harness; not required
  --gate <command>         repeatable acceptance command, run by this process
  --require-gate           an acquittal without a gate is not accepted
  --max-rounds <n>         guilty rounds before pause (default 5, max 50)
  --ceiling <n>            hard stop (default 10)
  --brief always|first     first = the harness keeps its own transcript
  --full                   print the round log as well as the summary
  --help

The reply is stdout. If stdout is empty, stderr is the reply.
Environment for every one-shot turn: PROSECUTOR_ROLE, PROSECUTOR_ROUND,
PROSECUTOR_CWD, PROSECUTOR_EFFORT, PROSECUTOR_MODEL.
Placeholders in --arg: {prompt} {role} {model} {cwd} {round}.
Prefer stdin for the prompt. A finding's command field is never executed.

Stdio process, one JSON object per line:
  <- {"type":"turn","id":"1","role":"executor","round":0,"prompt":"...","cwd":"..."}
  -> {"type":"result","id":"1","text":"..."}
  Logs go to stderr. {"type":"error","id":"1","message":"..."} fails the turn.

Exit 0 when status is accepted. Check "verified" before trusting the diff.
`;

function parseArgs(argv) {
  const out = {
    args: [],
    executorArgs: [],
    prosecutorArgs: [],
    gate: [],
    promptVia: "stdin",
    brief: "always",
    full: false,
    stdio: false,
    requireGate: false,
  };
  // Pass-through args (--arg and friends) are often flags themselves: --dangerously-skip-permissions.
  const take = (i, passThrough = false) => {
    const value = argv[i + 1];
    if (value == null || (!passThrough && value.startsWith("--"))) throw new Error(`missing value after ${argv[i]}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--full") out.full = true;
    else if (arg === "--stdio") out.stdio = true;
    else if (arg === "--require-gate") out.requireGate = true;
    else if (arg === "--cwd") out.cwd = take(i), i += 1;
    else if (arg === "--task") out.task = take(i), i += 1;
    else if (arg === "--task-file") out.taskFile = take(i), i += 1;
    else if (arg === "--cmd") out.cmd = take(i), i += 1;
    else if (arg === "--arg") out.args.push(take(i, true)), i += 1;
    else if (arg === "--executor-cmd") out.executorCmd = take(i), i += 1;
    else if (arg === "--executor-arg") out.executorArgs.push(take(i, true)), i += 1;
    else if (arg === "--prosecutor-cmd") out.prosecutorCmd = take(i), i += 1;
    else if (arg === "--prosecutor-arg") out.prosecutorArgs.push(take(i, true)), i += 1;
    else if (arg === "--prompt-via") out.promptVia = take(i), i += 1;
    else if (arg === "--model") out.model = take(i), i += 1;
    else if (arg === "--gate") out.gate.push(take(i)), i += 1;
    else if (arg === "--max-rounds") out.maxRounds = take(i), i += 1;
    else if (arg === "--ceiling") out.ceiling = take(i), i += 1;
    else if (arg === "--brief") out.brief = take(i), i += 1;
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

function summary(result, full) {
  const gate = result.gate
    ? {
        configured: result.gate.configured,
        ok: result.gate.ok,
        state: result.gate.state,
        results: (result.gate.results ?? []).map(({ command, ok, exitCode, timedOut }) => ({ command, ok, exitCode, timedOut })),
      }
    : null;
  const body = {
    status: result.status,
    verified: result.verified,
    reason: result.reason,
    rounds: result.rounds,
    verdict: result.verdict,
    model: result.model,
    sameModel: result.sameModel,
    findings: result.findings,
    owned: result.owned,
    flags: result.flags,
    counts: result.counts,
    gate,
  };
  if (full) {
    body.implementation = result.implementation;
    body.chain = result.chain;
    body.log = result.log;
  }
  return body;
}

const args = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const task = args.taskFile ? await readFile(args.taskFile, "utf8") : args.task;
if (!task?.trim()) {
  console.error("pass --task or --task-file");
  process.exit(1);
}
if (args.promptVia !== "stdin" && args.promptVia !== "json") {
  console.error('--prompt-via must be "stdin" or "json"');
  process.exit(1);
}

const cwd = resolve(args.cwd || process.cwd());
const executorCmd = args.executorCmd || args.cmd;
const prosecutorCmd = args.prosecutorCmd || executorCmd;
if (!executorCmd || !prosecutorCmd) {
  console.error("pass --cmd, or both --executor-cmd and --prosecutor-cmd");
  process.exit(1);
}
const executorArgs = args.executorCmd ? args.executorArgs : args.args;
const prosecutorArgs = args.prosecutorCmd ? args.prosecutorArgs : args.executorCmd ? args.executorArgs : args.args;

const ac = new AbortController();
const onSig = () => ac.abort();
process.on("SIGINT", onSig);
process.on("SIGTERM", onSig);

let harness = null;
let executor;
let prosecutor;
if (args.stdio) {
  const command = args.cmd || executorCmd;
  const stdioArgs = args.cmd ? args.args : executorArgs;
  if (args.prosecutorCmd && (args.prosecutorCmd !== command || prosecutorArgs.join("\0") !== stdioArgs.join("\0"))) {
    console.error("--stdio uses one process; omit a second command or make it the same");
    process.exit(1);
  }
  harness = createStdioHarness({ command, args: stdioArgs, cwd });
  executor = harness.executor;
  prosecutor = harness.prosecutor;
} else {
  const shared = !args.prosecutorCmd && !args.executorCmd;
  executor = createCliSide({ command: executorCmd, args: shared ? args.args : executorArgs, promptVia: args.promptVia });
  const same =
    prosecutorCmd === executorCmd &&
    (shared || prosecutorArgs.join("\0") === (shared ? args.args : executorArgs).join("\0"));
  prosecutor = same
    ? executor
    : createCliSide({ command: prosecutorCmd, args: prosecutorArgs, promptVia: args.promptVia });
}

let code = 1;
try {
  const result = await runCase({
    cwd,
    task,
    executor,
    prosecutor,
    model: args.model,
    gate: args.gate,
    requireGate: args.requireGate,
    maxRounds: args.maxRounds,
    ceiling: args.ceiling,
    brief: args.brief,
    signal: ac.signal,
    onEvent(event) {
      if (event.type === "status") console.error(`${event.status}${event.round != null ? ` (round ${event.round})` : ""}`);
      else if (event.type === "verdict") console.error(`round ${event.round}: ${event.verdict || "no verdict"}`);
      else if (event.type === "done") console.error(`${event.status}${event.verified ? " verified" : ""}: ${event.reason}`);
    },
  });
  process.stdout.write(`${JSON.stringify(summary(result, args.full), null, 2)}\n`);
  code = result.status === "accepted" ? 0 : 2;
} catch (error) {
  console.error(String(error?.message ?? error));
  code = 1;
} finally {
  // process.exit does not run finally, so close before exiting below.
  harness?.close?.();
}
process.exit(code);
