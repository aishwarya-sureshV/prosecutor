import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createSameModel, gitWorkspace, runCase } from "../src/index.js";
import { act } from "./fixtures/act.mjs";
import { makeRepo, sh } from "./repo.mjs";

const gate = [`${sh(process.execPath)} src/add.test.mjs`];

async function exists(path) {
  return access(path).then(() => true, () => false);
}

test("the same model implements, fails prosecution, fixes, and passes the gate", async () => {
  const repo = await makeRepo();
  try {
    const roles = [];
    const side = async (ctx) => {
      roles.push(`${ctx.role}:${ctx.round}`);
      assert.equal(ctx.model, "demo");
      return act(ctx);
    };
    const result = await runCase({
      ...createSameModel(side),
      cwd: repo.cwd,
      task: "export function add(a, b) that returns a + b",
      model: "demo",
      gate,
    });
    assert.equal(result.status, "accepted");
    assert.equal(result.verified, true);
    assert.equal(result.sameModel, true);
    assert.equal(result.rounds, 2);
    assert.equal(result.verdict, "acquitted");
    assert.deepEqual(roles, ["executor:0", "prosecutor:1", "executor:1", "prosecutor:2"]);
    assert.match(await readFile(join(repo.cwd, "src/add.mjs"), "utf8"), /return a \+ b/);
    assert.equal(await exists(join(repo.cwd, "should-not-run")), false);
    const refs = repo.git("show-ref");
    assert.doesNotMatch(refs, /prosecutor-mode/);
    const guilty = result.log.find((entry) => entry.verdict === "guilty");
    assert.equal(guilty.findings[0].command, "touch should-not-run");
  } finally {
    await repo.destroy();
  }
});

test("a prosecutor that edits source is reverted, and a second breach stops the case", async () => {
  const repo = await makeRepo();
  try {
    let calls = 0;
    const result = await runCase({
      cwd: repo.cwd,
      task: "leave the tree alone",
      executor: async () => "implemented",
      prosecutor: async () => {
        calls += 1;
        await writeFile(join(repo.cwd, `evil${calls}.js`), "nope\n");
        return "VERDICT: GUILTY";
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.status, "stopped");
    assert.match(result.reason, /reverted/);
    assert.equal(await exists(join(repo.cwd, "evil1.js")), false);
    assert.equal(await exists(join(repo.cwd, "evil2.js")), false);
    assert.equal(result.sameModel, false);
  } finally {
    await repo.destroy();
  }
});

test("an executor that deletes the prosecutor's tests is stopped and the tests come back", async () => {
  const repo = await makeRepo();
  try {
    const testPath = join(repo.cwd, "src/add.test.mjs");
    const result = await runCase({
      cwd: repo.cwd,
      task: "add a function",
      maxRounds: 4,
      executor: async (ctx) => {
        if (ctx.round === 0) {
          await mkdir(join(repo.cwd, "src"), { recursive: true });
          await writeFile(join(repo.cwd, "src/add.mjs"), "export const add = (a, b) => a + b;\n");
          return "implemented";
        }
        await rm(testPath, { force: true });
        return "deleted the test";
      },
      prosecutor: async () => {
        await mkdir(join(repo.cwd, "src"), { recursive: true });
        await writeFile(testPath, "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n");
        return 'FINDING F1 | requirement: "add a function" | test: src/add.test.mjs:2 keeps one | command: true\nVERDICT: GUILTY';
      },
    });
    assert.equal(result.status, "integrity");
    assert.match(result.reason, /deleted/);
    assert.equal(await exists(testPath), true);
  } finally {
    await repo.destroy();
  }
});

test("round cap stops before another repair", async () => {
  const repo = await makeRepo();
  try {
    let executorRounds = [];
    const result = await runCase({
      cwd: repo.cwd,
      task: "anything",
      maxRounds: 1,
      executor: async (ctx) => {
        executorRounds.push(ctx.round);
        return "implemented";
      },
      prosecutor: async () =>
        'FINDING F1 | requirement: "anything" | test: src/add.test.mjs:1 t | command: true\nVERDICT: GUILTY',
    });
    assert.equal(result.status, "capped");
    assert.deepEqual(executorRounds, [0]);
    assert.equal(result.rounds, 1);
  } finally {
    await repo.destroy();
  }
});

test("onCap continue lets the same model finish the fix", async () => {
  const repo = await makeRepo();
  try {
    const result = await runCase({
      ...createSameModel(act),
      cwd: repo.cwd,
      task: "export function add(a, b) that returns a + b",
      model: "demo",
      maxRounds: 1,
      gate,
      onCap: () => "continue",
    });
    assert.equal(result.status, "accepted");
    assert.equal(result.verified, true);
    assert.ok(result.rounds >= 2);
  } finally {
    await repo.destroy();
  }
});

test("a custom workspace can acquit without git", async () => {
  const labels = [];
  const workspace = {
    async snapshot(label) {
      labels.push(label);
      return { ok: true, commit: `snap-${labels.length}` };
    },
    async changedSince() {
      return "";
    },
    async prosecutorChanges() {
      return { tests: [], breach: [] };
    },
    async checkIntegrity() {
      return [];
    },
  };
  const side = async (ctx) => (ctx.role === "prosecutor" ? "VERDICT: ACQUITTED" : "done");
  const result = await runCase({
    task: "do nothing",
    cwd: "/not/a/repo",
    ...createSameModel(side),
    workspace,
  });
  assert.equal(result.status, "accepted");
  assert.equal(result.verified, false);
  assert.match(result.reason, /no acceptance gate/);
  assert.ok(labels.length >= 2);
});

test("an acceptance gate that edits the tree is reverted and does not verify", async () => {
  const repo = await makeRepo();
  try {
    const result = await runCase({
      cwd: repo.cwd,
      task: "do nothing",
      executor: async () => "implemented",
      prosecutor: async () => "VERDICT: ACQUITTED",
      gate: ["echo pwned >> README.md"],
    });
    assert.equal(result.status, "stopped");
    assert.match(result.reason, /acceptance gate changed the worktree/);
    assert.equal(result.verified, false);
    assert.equal(await readFile(join(repo.cwd, "README.md"), "utf8"), "case\n");
  } finally {
    await repo.destroy();
  }
});

test("requireGate refuses an acquittal when no commands were configured", async () => {
  const repo = await makeRepo();
  try {
    const result = await runCase({
      cwd: repo.cwd,
      task: "do nothing",
      requireGate: true,
      executor: async () => "implemented",
      prosecutor: async () => "VERDICT: ACQUITTED",
    });
    assert.equal(result.status, "stopped");
    assert.match(result.reason, /no acceptance gate/);
    assert.equal(repo.git("status", "--porcelain").trim(), "");
  } finally {
    await repo.destroy();
  }
});


test("a prosecutor that edits gitignored files is reverted", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo.cwd, ".gitignore"), ".env\ndist/\n");
    repo.git("add", ".gitignore");
    repo.git("commit", "-m", "ignore");
    await writeFile(join(repo.cwd, ".env"), "SECRET=1\n");
    let calls = 0;
    const result = await runCase({
      cwd: repo.cwd,
      task: "leave the tree alone",
      executor: async () => "implemented",
      prosecutor: async () => {
        calls += 1;
        await writeFile(join(repo.cwd, ".env"), "SECRET=hacked\n");
        await mkdir(join(repo.cwd, "dist"), { recursive: true });
        await writeFile(join(repo.cwd, `dist/evil${calls}.js`), "nope\n");
        return "VERDICT: GUILTY";
      },
    });
    assert.equal(result.status, "stopped");
    assert.match(result.reason, /\.env/);
    assert.equal(await readFile(join(repo.cwd, ".env"), "utf8"), "SECRET=1\n");
    assert.equal(await exists(join(repo.cwd, "dist/evil1.js")), false);
    assert.equal(await exists(join(repo.cwd, "dist/evil2.js")), false);
  } finally {
    await repo.destroy();
  }
});

test("snapshots leave the user's real index alone", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo.cwd, "staged.txt"), "staged\n");
    repo.git("add", "staged.txt");
    await writeFile(join(repo.cwd, "loose.txt"), "loose\n");
    const index = await readFile(join(repo.cwd, ".git/index"));
    const workspace = gitWorkspace(repo.cwd);
    const snap = await workspace.snapshot("test");
    await writeFile(join(repo.cwd, "loose.txt"), "changed\n");
    assert.match(await workspace.changedSince(snap.commit), /M\tloose\.txt/);
    assert.deepEqual(await readFile(join(repo.cwd, ".git/index")), index);
    assert.equal(repo.git("diff", "--cached", "--name-only").trim(), "staged.txt");
    await workspace.close();
  } finally {
    await repo.destroy();
  }
});
