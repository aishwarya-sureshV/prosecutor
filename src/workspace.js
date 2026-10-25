/**
 * Git workspace driver. Snapshots go to a private index and
 * refs/prosecutor-mode/*, never the user's index or branch history.
 * Replace this object to run the loop on a non-git workspace.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { isRepoPath, isTestPath, parseNameStatus, weakening } from "./protocol.js";

const execFileAsync = promisify(execFile);
const OUTPUT_CHARS = 6000;

export async function git(cwd, args, env, signal) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      signal,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { ok: true, out: String(stdout).trim() };
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) throw error;
    return { ok: false, out: "", error: String(error?.stderr || error?.message || error).trim() };
  }
}

/** @param {string} cwd repository root */
export function gitWorkspace(cwd) {
  const root = resolve(cwd);
  const refs = [];
  let queue = Promise.resolve();
  const lock = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
  };

  async function withIndex(fn) {
    return lock(async () => {
      const dir = await mkdtemp(join(tmpdir(), "prosecutor-index-"));
      const env = {
        GIT_INDEX_FILE: join(dir, "index"),
        GIT_AUTHOR_NAME: "prosecutor-mode",
        GIT_AUTHOR_EMAIL: "prosecutor-mode@localhost",
        GIT_COMMITTER_NAME: "prosecutor-mode",
        GIT_COMMITTER_EMAIL: "prosecutor-mode@localhost",
      };
      try {
        return await fn(env);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  async function diff(commit, pathspecs, extra, signal) {
    if (!commit) return null;
    return withIndex(async (env) => {
      const staged = await git(root, ["add", "-A"], env, signal);
      if (!staged.ok) return null;
      const args = ["diff", "--cached", "--no-renames", ...extra, commit];
      if (pathspecs.length) args.push("--", ...pathspecs);
      const result = await git(root, args, env, signal);
      return result.ok ? result.out : null;
    });
  }

  return {
    cwd: root,
    async snapshot(label) {
      return withIndex(async (env) => {
        const staged = await git(root, ["add", "-A"], env);
        if (!staged.ok) return { ok: false, error: staged.error || "git add failed" };
        const tree = await git(root, ["write-tree"], env);
        if (!tree.ok) return { ok: false, error: tree.error || "git write-tree failed" };
        const head = await git(root, ["rev-parse", "HEAD"]);
        const message = String(label || "snapshot").replace(/\s+/g, " ").slice(0, 120);
        const args = ["commit-tree", tree.out];
        if (head.ok) args.push("-p", head.out);
        args.push("-m", `prosecutor-mode: ${message}`);
        const commit = await git(root, args, env);
        if (!commit.ok) return { ok: false, error: commit.error || "git commit-tree failed" };
        const ref = `refs/prosecutor-mode/${commit.out}`;
        const updated = await git(root, ["update-ref", ref, commit.out]);
        if (updated.ok) refs.push(ref);
        return { ok: true, commit: commit.out, ref };
      });
    },
    changedSince(commit, signal) {
      return diff(commit, [], ["--name-status"], signal);
    },
    repairPatch(commit, signal) {
      return diff(commit, [], ["-U0"], signal);
    },
    async prosecutorChanges(commit, patterns, signal) {
      const status = await diff(commit, [], ["--name-status"], signal);
      if (status == null) return null;
      const tests = [];
      const breach = [];
      for (const change of parseNameStatus(status))
        (isTestPath(change.path, patterns) ? tests : breach).push(change);
      return { tests, breach };
    },
    async revertChanges(commit, changes) {
      const list = (changes ?? []).filter((change) => isRepoPath(change.path));
      const restore = list.filter((change) => change.status !== "A").map((change) => change.path);
      if (restore.length) {
        const done = await git(root, ["restore", `--source=${commit}`, "--worktree", "--", ...restore]);
        if (!done.ok) return false;
      }
      for (const change of list.filter((item) => item.status === "A"))
        await rm(join(root, change.path), { force: true, recursive: true });
      return true;
    },
    async restore(commit, paths) {
      const safe = (paths ?? []).filter(isRepoPath);
      if (!commit || !safe.length) return true;
      const done = await git(root, ["restore", `--source=${commit}`, "--worktree", "--", ...safe]);
      return done.ok;
    },
    async checkIntegrity(commit, owned, signal) {
      const safe = (owned ?? []).filter(isRepoPath);
      if (!commit || !safe.length) return [];
      const status = await diff(commit, safe, ["--name-status"], signal);
      if (status == null) return null;
      const flags = [];
      for (const change of parseNameStatus(status)) {
        if (change.status === "D") {
          flags.push({ path: change.path, kind: "deleted" });
          continue;
        }
        const patch = (await diff(commit, [change.path], [], signal)) ?? "";
        flags.push({ path: change.path, kind: "edited", ...weakening(patch) });
      }
      return flags;
    },
    async testBodies(findings) {
      const bodies = [];
      for (const finding of findings ?? []) {
        const ref = String(finding?.test ?? "").match(/([\w./@-]+\.[A-Za-z]+):(\d+)/);
        if (!ref || !isRepoPath(ref[1])) continue;
        const lines = await readFile(join(root, ref[1]), "utf8").then((text) => text.split("\n"), () => []);
        const start = Math.max(0, Number(ref[2]) - 1);
        let end = Math.min(lines.length, start + 40);
        for (let i = start + 1; i < end; i += 1)
          if (/^\s*(test|it|describe)(\.\w+)?\s*\(/.test(lines[i])) end = i;
        bodies.push(lines.slice(start, end).join("\n"));
      }
      return bodies;
    },
    async close() {
      const pending = refs.splice(0);
      await Promise.all(pending.map((ref) => git(root, ["update-ref", "-d", ref])));
    },
  };
}

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

export function runCommand(command, cwd, timeoutSec, signal) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let child;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        detached: true,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ command, ok: false, exitCode: null, timedOut: false, ms: 0, output: String(error?.message ?? error) });
      return;
    }
    const keep = (chunk) => {
      output = (output + chunk).slice(-OUTPUT_CHARS * 2);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSec * 1000);
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    const done = (exitCode, extra = "") => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({
        command,
        ok: !timedOut && !signal?.aborted && exitCode === 0,
        exitCode,
        timedOut,
        ms: Date.now() - started,
        output: (output + extra).slice(-OUTPUT_CHARS),
      });
    };
    child.on("error", (error) => done(null, `\n${error.message}`));
    child.on("close", (code) => done(code));
  });
}

/**
 * User-configured commands only. A model finding's `command` field is never run.
 * `{file}` expands once per prosecutor-owned test path.
 */
export async function runGate(cwd, config, owned = [], signal) {
  const files = (owned ?? []).filter((path) => isRepoPath(path) && !isAbsolute(path));
  if (!config?.commands?.length) return { configured: false, ok: false, results: [] };
  const here = resolve(cwd);
  const results = [];
  for (const { run, timeoutSec } of config.commands) {
    if (signal?.aborted) break;
    const expanded = run.includes("{file}")
      ? files.map((path) => run.replaceAll("{file}", shellQuote(relative(here, join(here, path)) || ".")))
      : [run];
    if (!expanded.length)
      results.push({ command: run, ok: false, exitCode: null, timedOut: false, ms: 0, output: "No prosecutor test files to run it on." });
    for (const command of expanded) {
      if (signal?.aborted) break;
      results.push(await runCommand(command, here, timeoutSec, signal));
    }
  }
  return { configured: true, ok: !signal?.aborted && results.every((result) => result.ok), results, at: Date.now() };
}
