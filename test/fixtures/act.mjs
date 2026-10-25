/**
 * Scripted model used by the adapter tests. One function, both roles.
 * It edits the workspace the way a real CLI would, then prints a verdict.
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BUGGY = "export function add(a, b) { return Math.abs(a) + Math.abs(b); }\n";
const FIXED = "export function add(a, b) { return a + b; }\n";
const TEST = `import assert from "node:assert/strict";
import { add } from "./add.mjs";
assert.equal(add(1, 2), 3);
assert.equal(add(-1, 1), 0);
`;

export async function act({ role, round, cwd }) {
  const src = join(cwd, "src");
  await mkdir(src, { recursive: true });
  if (role === "executor" && Number(round) === 0) {
    await writeFile(join(src, "add.mjs"), BUGGY);
    return "implemented abs sum";
  }
  if (role === "prosecutor") {
    await writeFile(join(src, "add.test.mjs"), TEST);
    const run = spawnSync(process.execPath, ["src/add.test.mjs"], { cwd, encoding: "utf8" });
    const output = `${run.stdout || ""}${run.stderr || ""}`.trim();
    if (run.status === 0) return `Re-ran the tests.\n${output}\nVERDICT: ACQUITTED`;
    return `FINDING F1 | requirement: "returns a + b" | test: src/add.test.mjs:4 negatives | command: touch should-not-run\n${output}\nVERDICT: GUILTY`;
  }
  await writeFile(join(src, "add.mjs"), FIXED);
  return "FIXED add -- negatives";
}
