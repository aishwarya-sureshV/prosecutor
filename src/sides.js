/**
 * Harness adapters. A side is `(ctx) => Promise<string | { text, error?, message? }>`.
 * `ctx` is { role, round, prompt, cwd, task, effort, model, signal, onEvent }.
 * The same function may be both sides: branch on ctx.role and keep two transcripts.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const TAIL = 200_000;

function killTree(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function turnEnv(ctx, extra) {
  return {
    ...process.env,
    ...extra,
    PROSECUTOR_ROLE: ctx.role,
    PROSECUTOR_ROUND: String(ctx.round),
    PROSECUTOR_CWD: ctx.cwd,
    PROSECUTOR_EFFORT: ctx.effort || "",
    PROSECUTOR_MODEL: ctx.model || "",
  };
}

function turnBody(ctx, promptVia) {
  if (promptVia === "json") {
    return JSON.stringify({
      type: "turn",
      role: ctx.role,
      round: ctx.round,
      prompt: ctx.prompt,
      cwd: ctx.cwd,
      task: ctx.task,
      effort: ctx.effort || "",
      model: ctx.model || "",
    });
  }
  return ctx.prompt;
}

function fillArgs(args, ctx) {
  return args.map((arg) =>
    String(arg)
      .replaceAll("{prompt}", ctx.prompt)
      .replaceAll("{role}", ctx.role)
      .replaceAll("{model}", ctx.model || "")
      .replaceAll("{cwd}", ctx.cwd)
      .replaceAll("{round}", String(ctx.round)),
  );
}

const replyOf = (message) =>
  typeof message?.text === "string" ? message.text : typeof message?.result === "string" ? message.result : null;

function readReply(stdout, promptVia) {
  const text = String(stdout ?? "");
  if (promptVia !== "json") {
    // `claude -p --output-format json` prints a single {"type":"result","result":"..."} object.
    try {
      const message = JSON.parse(text);
      if (message?.type === "result" && typeof message.result === "string") return message.result;
    } catch {
      /* plain text */
    }
    return text;
  }
  const line = text.trim().split("\n").findLast((item) => item.trim().startsWith("{"));
  if (!line) return text;
  try {
    const message = JSON.parse(line);
    if (message.type === "error") {
      const error = new Error(message.message || "harness error");
      error.side = true;
      throw error;
    }
    if (message.type === "result" || replyOf(message) != null) return replyOf(message) ?? "";
  } catch (error) {
    if (error?.side) throw error;
  }
  return text;
}

function runProcess({ command, args, cwd, env, stdin, timeoutMs, signal, onEvent, promptVia }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child.exitCode == null && child.signalCode == null) killTree(child);
      if (error) reject(error);
      else resolve(text);
    };
    const onAbort = () => finish(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const timer = setTimeout(() => finish(new Error(`side timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-TAIL);
    });
    child.stderr.on("data", (chunk) => {
      const piece = chunk.toString("utf8");
      stderr = (stderr + piece).slice(-TAIL);
      onEvent?.({ type: "stderr", text: piece });
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        finish(new Error(stderr.trim() || `side exited ${code}`));
        return;
      }
      try {
        finish(null, readReply(stdout.trim() ? stdout : stderr, promptVia));
      } catch (error) {
        finish(error);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/**
 * One process per turn. Works with any CLI that reads a prompt on stdin
 * (or from `{prompt}` in argv) and prints its reply on stdout.
 * The process cwd is the workspace, so the CLI can edit files.
 */
export function createCliSide({
  command,
  args = [],
  promptVia = "stdin",
  env = {},
  timeoutMs = 20 * 60_000,
} = {}) {
  if (!command || typeof command !== "string") throw new TypeError("createCliSide requires a command");
  if (promptVia !== "stdin" && promptVia !== "json") throw new TypeError('promptVia must be "stdin" or "json"');
  return function cliSide(ctx) {
    return runProcess({
      command,
      args: fillArgs(args, ctx),
      cwd: ctx.cwd,
      env: turnEnv(ctx, env),
      stdin: turnBody(ctx, promptVia),
      timeoutMs,
      signal: ctx.signal,
      onEvent: ctx.onEvent,
      promptVia,
    });
  };
}

/**
 * One long-lived process for both roles. Speak one JSON object per line.
 * Request: { type:"turn", id, role, round, prompt, cwd, task, effort, model }
 * Events:  { type:"delta", id, text } optional
 * Done:    { type:"result", id, text } or { type:"error", id, message }
 * Logs belong on stderr. Non-JSON stdout lines are ignored.
 */
export function createStdioHarness({ command, args = [], env = {}, cwd, timeoutMs = 20 * 60_000 } = {}) {
  if (!command || typeof command !== "string") throw new TypeError("createStdioHarness requires a command");
  let child = null;
  const waiters = new Map();
  let seq = 0;
  let chain = Promise.resolve();

  function failAll(message) {
    for (const [id, waiter] of waiters) {
      waiters.delete(id);
      waiter.settle({ type: "error", message });
    }
  }

  function onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = waiters.get(message.id);
    if (!waiter) return;
    if (message.type === "delta") waiter.onEvent?.({ type: "delta", text: String(message.text ?? "") });
    if (message.type === "result" || message.type === "error") {
      waiters.delete(message.id);
      waiter.settle(message);
    }
  }

  function ensure(startCwd) {
    if (child && child.exitCode == null && child.signalCode == null) return child;
    const proc = spawn(command, args, {
      cwd: cwd || startCwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    let buffer = "";
    let stderr = "";
    const decoder = new StringDecoder("utf8");
    const fail = (message) => {
      if (child !== proc) return;
      child = null;
      failAll(stderr.trim() ? `${message}: ${stderr.trim()}` : message);
    };
    proc.stdout.on("data", (chunk) => {
      if (child !== proc) return;
      buffer += decoder.write(chunk);
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    });
    proc.stderr.on("data", (chunk) => {
      const piece = chunk.toString("utf8");
      stderr = (stderr + piece).slice(-TAIL);
      for (const waiter of waiters.values()) waiter.onEvent?.({ type: "stderr", text: piece });
    });
    proc.on("error", () => fail("harness failed to start"));
    proc.on("close", () => fail("harness exited"));
    proc.stdin.on("error", () => {});
    return proc;
  }

  // A turn that timed out or was aborted may still be editing files: kill it so the next turn starts clean.
  function restart(message) {
    const current = child;
    child = null;
    failAll(message);
    killTree(current);
  }

  function turn(ctx) {
    const run = chain.then(() => oneTurn(ctx));
    chain = run.then(() => {}, () => {});
    return run;
  }

  function oneTurn(ctx) {
    if (ctx.signal?.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const id = String(++seq);
    const proc = ensure(ctx.cwd);
    const payload = {
      type: "turn",
      id,
      role: ctx.role,
      round: ctx.round,
      prompt: ctx.prompt,
      cwd: ctx.cwd,
      task: ctx.task,
      effort: ctx.effort || "",
      model: ctx.model || "",
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        ctx.signal?.removeEventListener("abort", onAbort);
        restart("harness restarted after a timed-out turn");
        reject(new Error(`stdio turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        waiters.delete(id);
        restart("harness restarted after an aborted turn");
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      waiters.set(id, {
        onEvent: ctx.onEvent,
        settle: (message) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener("abort", onAbort);
          if (message.type === "error") reject(new Error(message.message || "harness error"));
          else resolve({ text: String(message.text ?? "") });
        },
      });
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  return {
    executor: turn,
    prosecutor: turn,
    close() {
      restart("harness closed");
    },
  };
}

/** One complete() plays both roles. Keep separate transcripts inside complete, keyed by ctx.role. */
export function createSameModel(complete) {
  if (typeof complete !== "function") throw new TypeError("createSameModel requires a function");
  const side = (ctx) => complete(ctx);
  return { executor: side, prosecutor: side, sameModel: true };
}
