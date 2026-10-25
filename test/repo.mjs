import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeRepo() {
  const cwd = await mkdtemp(join(tmpdir(), "prosecutor-case-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "prosecutor@localhost");
  git("config", "user.name", "prosecutor");
  await writeFile(join(cwd, "README.md"), "case\n");
  git("add", "README.md");
  git("commit", "-m", "init");
  return {
    cwd,
    git,
    destroy: () => rm(cwd, { recursive: true, force: true }),
  };
}

export const sh = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;
