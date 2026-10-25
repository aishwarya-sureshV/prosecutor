import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createCliSide, createSameModel, createStdioHarness, runCase } from "../src/index.js";
import { makeRepo, sh } from "./repo.mjs";

const exec = promisify(execFile);
const fixture = (name) => join(import.meta.dirname, "fixtures", name);
const bin = join(import.meta.dirname, "..", "bin", "prosecute.mjs");
const gate = `${sh(process.execPath)} src/add.test.mjs`;
const task = "export function add(a, b) that returns a + b";

test("a one-shot CLI plays both roles", async () => {
  const repo = await makeRepo();
  try {
    const side = createCliSide({
      command: process.execPath,
      args: [fixture("fake-agent.mjs")],
      timeoutMs: 30_000,
    });
    const result = await runCase({
      ...createSameModel(side),
      cwd: repo.cwd,
      task,
      model: "cli-demo",
      gate: [gate],
    });
    assert.equal(result.status, "accepted");
    assert.equal(result.verified, true);
    assert.equal(result.sameModel, true);
    assert.match(await readFile(join(repo.cwd, "src/add.mjs"), "utf8"), /return a \+ b/);
  } finally {
    await repo.destroy();
  }
});

test("a long-lived stdio harness plays both roles in one process", async () => {
  const repo = await makeRepo();
  const harness = createStdioHarness({
    command: process.execPath,
    args: [fixture("fake-stdio.mjs")],
    cwd: repo.cwd,
    timeoutMs: 30_000,
  });
  try {
    const result = await runCase({
      executor: harness.executor,
      prosecutor: harness.prosecutor,
      cwd: repo.cwd,
      task,
      model: "stdio-demo",
      gate: [gate],
    });
    assert.equal(result.status, "accepted");
    assert.equal(result.verified, true);
    assert.equal(result.sameModel, true);
    assert.match(await readFile(join(repo.cwd, "src/add.mjs"), "utf8"), /return a \+ b/);
  } finally {
    harness.close();
    await repo.destroy();
  }
});

test("the CLI accepts a case from one command and rejects a missing task", async () => {
  const repo = await makeRepo();
  try {
    const { stdout, stderr } = await exec(process.execPath, [
      bin,
      "--cwd", repo.cwd,
      "--task", task,
      "--model", "bin-demo",
      "--cmd", process.execPath,
      "--arg", fixture("fake-agent.mjs"),
      "--gate", gate,
    ], { timeout: 30_000 });
    const result = JSON.parse(stdout);
    assert.equal(result.status, "accepted");
    assert.equal(result.verified, true);
    assert.equal(result.sameModel, true);
    assert.equal(result.model, "bin-demo");
    assert.match(stderr, /verified/);
    const help = await exec(process.execPath, [bin, "--help"]);
    assert.match(help.stdout, /--stdio/);
    const missing = await exec(process.execPath, [bin, "--cmd", "true"]).then(
      () => { throw new Error("expected exit 1"); },
      (error) => error,
    );
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--task/);
  } finally {
    await repo.destroy();
  }
});
