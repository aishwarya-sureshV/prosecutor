# prosecutor

Adversarial review loop for any coding CLI, LLM, or agent. The executor applies a task. The prosecutor tries to break that change by writing tests. A guilty report goes back to the executor. The diff is verified when **your** acceptance commands pass.

Both roles can be the same model. Give each role its own transcript. This package does that for you: one-shot CLIs get a fresh process per turn, and a stdio harness gets `role` on every turn so it can keep two sessions.

## Contract

A **side** is a function:

```js
async function side(ctx) {
  // ctx.role     "executor" | "prosecutor"
  // ctx.round    0 is the implementation; 1+ are review rounds
  // ctx.prompt   what this role should do
  // ctx.cwd      workspace it may edit
  // ctx.task     the original task
  // ctx.model    optional id you passed in
  // ctx.effort   "high" on the first prosecution, "medium" after, unless you pin it
  // ctx.signal   abort
  return "final reply text"; // or { text }
}
```

The prosecutor reply must end with `VERDICT: GUILTY` or `VERDICT: ACQUITTED`. Guilty reports should include one line per failure:

```
FINDING F1 | requirement: "the task words" | test: file:line name | command: <how to run it>
```

That `command` is recorded and **never executed**. Only `gate` commands run, and you supply those.

The prosecutor may only add or edit test files (`**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `test/**`, `tests/**`, and the same under any directory). Any other edit inside the repo is reverted and the round is void. That includes gitignored files such as `.env` or `dist/`, but not ignored `node_modules/` directories or anything outside the repo; run the prosecutor in a sandbox if those matter. A second breach stops the case. The executor may not edit or delete those tests. If it does, it gets one chance to put them back; then the loop restores them and stops.

An acquittal is `verified: true` only after every gate command exits 0 and leaves the tree unchanged. With no gate, the case is `accepted` and `verified: false`. Pass `requireGate: true` to refuse that.

## CLI

From a git checkout (Node 22, `git` on `PATH`). macOS and Linux only: sides and gate commands run under `/bin/sh` in their own process group.

```bash
node bin/prosecute.mjs \
  --cwd "$PWD" \
  --task "reject an empty password in login()" \
  --cmd claude \
  --arg -p \
  --arg --dangerously-skip-permissions \
  --gate "npm test" \
  --require-gate
```

`--cmd` is both roles, so one model is enough. Split them when you want two:

```bash
node bin/prosecute.mjs \
  --task-file task.md \
  --executor-cmd claude --executor-arg -p \
  --prosecutor-cmd codex --prosecutor-arg exec --prosecutor-arg --sandbox --prosecutor-arg workspace-write \
  --gate "npm test"
```

Stdout is a JSON summary. Exit 0 means `status` is `accepted`. Read `verified` before you trust the diff. `--full` adds the round log.

The one-shot process's cwd is the workspace. The prompt is on stdin. These environment variables are set too: `PROSECUTOR_ROLE`, `PROSECUTOR_ROUND`, `PROSECUTOR_CWD`, `PROSECUTOR_EFFORT`, `PROSECUTOR_MODEL`. `{prompt}`, `{role}`, `{model}`, `{cwd}`, and `{round}` work inside `--arg`. Prefer stdin for the prompt; argv has a size limit.

`--prompt-via json` writes one turn object to stdin instead of the raw prompt. The reply is read from the last JSON line's `text`, or its `result` (`claude -p --output-format json` works). `--stdio` keeps a single process open for both roles.

One-shot turns start cold: every round re-sends the case brief, so prompt cost grows with each round. Use `--stdio` or `brief: "first"` with a harness that keeps its own transcript.

| CLI | Args | Prompt |
| --- | --- | --- |
| Claude Code | `--cmd claude --arg -p --arg --dangerously-skip-permissions` | stdin |
| Codex | `--cmd codex --arg exec --arg --sandbox --arg workspace-write` | stdin |
| Grok | `--cmd grok --arg -p --arg '{prompt}'` | argv only |
| opencode | `--cmd opencode --arg run --arg '{prompt}'` | argv only |

## Library

```js
import { runCase, createCliSide, createSameModel, createStdioHarness } from "./src/index.js";

const side = createCliSide({ command: "claude", args: ["-p", "--dangerously-skip-permissions"] });
const result = await runCase({
  cwd: process.cwd(),
  task: "reject an empty password in login()",
  model: "claude-sonnet",
  ...createSameModel(side),
  gate: ["npm test"],
  requireGate: true,
  onEvent(event) {},
});
```

`createSameModel` passes one function as both sides. A long-lived agent uses `createStdioHarness` the same way: one process, `executor` and `prosecutor` bound to it.

### Stdio harness

One JSON object per line. Logs go to stderr.

```js
import readline from "node:readline";

const sessions = { executor: [], prosecutor: [] };
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const turn = JSON.parse(line);
  sessions[turn.role].push(turn);
  const text = await yourModel(sessions[turn.role]); // your CLI, SDK, or HTTP API
  process.stdout.write(JSON.stringify({ type: "result", id: turn.id, text }) + "\n");
}
```

Turn request: `{ type:"turn", id, role, round, prompt, cwd, task, effort, model }`.

Optional deltas: `{ type:"delta", id, text }`. Failure: `{ type:"error", id, message }`.

`yourModel` is the extension point. It can call Claude, Codex, Grok, a local model, or an in-process function. Key its transcript by `role` so the prosecutor does not see the executor's scratchpad.

### Other extension points

- `prompts` replaces `prosecution`, `defense`, `redesign`, `verdictFollowup`, or `integrity`.
- `testPatterns` changes which paths the prosecutor may edit.
- `workspace` replaces git. Required methods: `snapshot(label) -> { ok, commit }`, `changedSince(commit) -> name-status text`, `prosecutorChanges(commit, patterns) -> { tests, breach }`, `revertChanges(commit, changes)`, `checkIntegrity(commit, paths)`, `restore(commit, paths)`. `repairPatch` and `testBodies` enable the fix-chain redesign.
- `onCap(state)` returns `continue`, `redesign`, `accept`, or `stop` when the round cap hits (default 5, hard stop at the ceiling, default 10).
- `onEvent` is how a UI shows status without this package knowing about one.
- `start: "review"` plus `baseline: "<git sha>"` prosecutes a change that is already in the tree.
- `brief: "first"` skips the growing case brief after round 1, for a harness that keeps its own transcript.
- `history` is prior `{ prompt, reply }` turns, or `{ role, content }` messages.

`gate` is a list of shell strings, or `{ commands: [{ run, timeoutSec }], testPatterns }`. `{file}` runs once per prosecutor-owned test. Gate commands are yours. They are not taken from the model.

## What a case returns

`status` is `accepted`, `capped`, `stopped`, `integrity`, or `error`.

`verified` is true only when the gate passed. `accepted` with `verified: false` means the prosecutor gave up and no gate ran, or you accepted at the cap. `capped` means the round limit hit while tests were still failing. `integrity` means the executor would not leave the prosecutor's tests alone. `stopped` means no verdict, a repeated edit-boundary breach, a gate that edited the tree, or an abort.

The loop is in-process. It does not resume a case after this process exits. The JSON result is safe to store and show.

## Tests

```bash
npm test
```

The tests use a scripted model that edits a temporary git repo. They do not call a hosted model.
