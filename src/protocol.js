/**
 * Prosecutor / executor protocol.
 *
 * Prompt text, verdict rules and parsers. This file is pure: no git, no
 * processes, no sessions. A harness can replace any prompt by passing
 * `prompts` to runCase.
 */

/** Rounds per task before the case asks the caller what to do. */
export const MAX_ROUNDS = 5;
/** "continue" buys this many more rounds (still capped by the ceiling). */
export const EXTRA_ROUNDS = 3;
/** No choice runs a case past this. Callers may raise it, up to HARD_CEILING. */
export const ROUND_CEILING = 10;
/** Absolute clamp so a bad option cannot loop without bound. */
export const HARD_CEILING = 50;
export const CAP_CHOICES = ["continue", "redesign", "accept"];
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"];
export const REDESIGN_EFFORT = "high";

export const PROOF_RULE = `Proof, not claims: whenever you report a test or typecheck result, paste the command and the runner's real output verbatim -- its final summary lines (pass/fail counts) and every failure block. A result reported without its output does not count.`;

export const VERDICT_FOLLOWUP = `Your report did not end with a verdict line I could read. Reply with exactly one line: VERDICT: GUILTY if any of your tests still fails legitimately, otherwise VERDICT: ACQUITTED.`;

const FINDINGS_RULE = `For each failing test also write one line: FINDING F<n> | requirement: "<the task words it enforces>" | test: <file:line> <test name> | command: <command that runs it>. Keep a finding's ID across rounds. Only add or edit test files: the server reverts any other file you change and voids the round.`;
const CAUSED_RULE = `On each FINDING line also add | CAUSED_BY_LAST_FIX: yes if the behavior worked before the executor's last repair and that repair broke it, otherwise | CAUSED_BY_LAST_FIX: no.`;

export const SCOPE_RULES = `What counts as a bug -- the task as written (plus any standing requirements from earlier turns) is the only spec:
- Each test must check behavior the task states, or that any reasonable reading of it requires (an input form it lists, an error case it names).
- Always in scope, even when the task never mentions them: SECURITY issues (injection, path traversal, leaked secrets, missing auth or permission checks, unsafe parsing of untrusted input) and PERFORMANCE problems a real user would hit (work that grows badly on ordinary input sizes, a call that hangs or blocks, memory that grows without bound). Test performance with a generous bound, not a tight timing.
- Unusual or edge inputs are in scope when the requirements support them -- an empty value where the task accepts values, a boundary its stated range includes.
- Not a bug: precision beyond what the task implies, pathological or absurdly large inputs, style, or your own preference about what the task "should" have said.
- But a plain input that comes back visibly wrong IS a bug, whatever the cause -- including floating-point error (a value like x.9999999 where the caller expects a whole number, or a round trip that drifts by a unit). Use ordinary inputs a user would type, not just the ones the task happens to list.
- Never contradict a test you or the executor already accepted.
- Go after obvious bugs a real user of this change would hit: a listed input that gives the wrong answer, a named error case that does not error. Skip one-in-ten-thousand corner cases that need contrived input to trigger: if you have to build an input on purpose to cause trouble (hundreds of digits, exotic unicode, values at the edge of the number range), it is not realistic.
- If every failure you can find needs a requirement you would have to assume, or input nobody would realistically pass, that is an acquittal.`;

export const SIDE_EFFECT_RULE =
  "For each fix, list what else reads or writes the state you changed (callers, other handlers, persisted or toggled values) and check each one still behaves before replying; put that list under the fix in your ruling.";

export const DEFENSE_OPENER = "The prosecutor wrote failing tests against your change.";

export const INTEGRITY_NOTE = `Your last repair edited or deleted the prosecutor's test files. Those tests are the prosecutor's: restore them exactly as they were (\`git diff\` shows what you changed), then answer the report below again -- fix the code, or raise an OBJECTION.

`;

const HISTORY_TURNS = 20;
const PROMPT_CHARS = 2000;
const REPLY_CHARS = 1500;
const CASE_PROMPT_CHARS = 1500;
const CASE_REPORT_CHARS = 6000;
const CASE_REPLY_CHARS = 3000;
const ROUND_ONE_SUMMARY = "(round 1 brief: map the risks of the change against the task, then write and run a battery of tests)";

const clip = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)} ...[truncated]` : value;
};

export function messageText(message) {
  if (message == null) return "";
  if (typeof message === "string") return message;
  const content = message.content ?? message.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return String(content?.text ?? "");
}

/** Earlier turns, oldest first, minus this task. Defense prompts are not user turns. */
export function sessionHistory(messages, task) {
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = messageText(message);
    if (message?.role === "user" && text)
      turns.push({ prompt: text, reply: "", ours: text.startsWith(DEFENSE_OPENER) });
    else if (message?.role === "assistant" && text && turns.length) turns.at(-1).reply = text;
  }
  const real = turns.filter((turn) => !turn.ours);
  const at = real.findLastIndex((turn) => turn.prompt === String(task ?? "").trim());
  return (at >= 0 ? real.slice(0, at) : real.slice(0, -1)).slice(-HISTORY_TURNS);
}

export function historyBrief(turns) {
  if (!turns?.length) return "";
  const body = turns
    .map(
      (turn, i) =>
        `### Turn ${i + 1}\nUser: ${clip(turn.prompt, PROMPT_CHARS)}\nExecutor: ${clip(turn.reply, REPLY_CHARS) || "(no reply)"}`,
    )
    .join("\n\n");
  return `You are joining this session mid-way. Earlier turns, oldest first -- the user's words, then the executor's final reply:

${body}

How to use this: the user's words are standing requirements, and a later turn overrides an earlier one. The executor's replies are claims about what it did, not requirements -- a decision counts only if the user stated or accepted it. Before testing, write yourself a short "Standing requirements" list from these turns. A change that breaks one of them is a bug (a regression), judged by the same rules as the task.

`;
}

export function changeNote(changes, commit, round) {
  if (changes == null || !commit) return "";
  const when = round > 1 ? "since your last round" : "in this turn";
  if (!String(changes).trim()) return round > 1 ? `The executor changed no files ${when}.\n\n` : "";
  const lines = String(changes).split("\n");
  const shown = lines.slice(0, 80).join("\n");
  const more = lines.length > 80 ? `\n...and ${lines.length - 80} more` : "";
  return `Files the executor changed ${when} (M modified, A added, D deleted):

${shown}${more}

Start from these -- \`git diff ${commit} -- <file>\` for a modified file, the whole file for an added one -- so you don't spend time rediscovering them. Read anything else in the repository you need.

`;
}

export function caseBrief(log, round) {
  if (!log?.length) return "";
  const body = log
    .map(
      (entry) =>
        `### Round ${entry.round} (${entry.by})${entry.died ? ` -- died: ${clip(entry.died, 300)}` : ""}\nPrompt:\n${entry.round === 1 ? ROUND_ONE_SUMMARY : clip(entry.prompt, CASE_PROMPT_CHARS)}\n\nReport${entry.died ? " (partial)" : ""}:\n${clip(entry.report || "(none)", CASE_REPORT_CHARS)}${entry.reply ? `\n\nExecutor's reply:\n${clip(entry.reply, CASE_REPLY_CHARS)}` : ""}`,
    )
    .join("\n\n");
  return `You are taking over as the PROSECUTOR of a case already in progress -- this is round ${round}. Earlier rounds were run by other prosecutor models; their prompts and reports are YOUR history now:
- every test file they wrote is YOUR test: re-run it, do not rewrite it;
- OBJECTION rulings already made stand;
- a round marked "died" stopped mid-way and may have left test files behind -- finish or reuse them;
- do not start the case over with a new risk map.

${body}

`;
}

/** Case record for an executor that does not already remember earlier rounds. */
export function executorBrief(log) {
  const done = (log ?? []).filter((entry) => !entry.died && entry.report);
  if (!done.length) return "";
  const body = done
    .map(
      (entry) =>
        `### Round ${entry.round} -- prosecutor (${entry.by}) reported:\n${clip(entry.report, CASE_REPORT_CHARS)}${entry.reply ? `\n\nExecutor (${entry.replyBy || "executor"}) answered:\n${clip(entry.reply, CASE_REPLY_CHARS)}` : ""}`,
    )
    .join("\n\n");
  return `Prosecutor-mode case record so far (earlier rounds, possibly answered by other executor models -- treat their fixes and OBJECTIONs as yours):

${body}

---

`;
}

export function prosecutionPrompt(task, round, defense, brief = "", changes = "") {
  if (round > 1)
    return `${brief}Round ${round}. The task as written is still:

"""
${task}
"""

The executor answered your failing tests:

"""
${defense || "(no reply text)"}
"""

${changes}1. Re-run your own test files. You wrote them, so there is usually no need to re-read them. Typecheck and the rest of the suite are the executor's job, and its reply must paste their real output; re-run any of them whenever that output is missing, shows a failure, or you have reason to doubt it. A test that now passes is settled.
2. For each test the executor raised an OBJECTION to, weigh it against the task text alone: if the objection holds, delete that test and never re-file it or a variant of it; if it does not hold, keep the test and say which words of the task require it.
3. Hunt again, starting from the files listed above: write new tests for realistic risks you have not covered yet -- especially behavior the executor's fixes could have broken. Same rules as before:

${SCOPE_RULES}

List EVERY test that still fails legitimately (the task words it enforces, the test as file:line plus its name, its failure output).

${FINDINGS_RULE} ${CAUSED_RULE}

${PROOF_RULE}

End with VERDICT: GUILTY if any stands, otherwise VERDICT: ACQUITTED.`;
  return `You are the PROSECUTOR in an adversarial code review. Another agent just changed this repository to do this task:

"""
${task}
"""

${brief}${changes}Your job is to break that change as thoroughly as you can. Read the change (start from the file list above when there is one; otherwise git diff, git status and any new untracked files) and anything else in the repository you need.

Then, BEFORE writing any test, write a risk map: for every requirement in the task (and every standing requirement), list each realistic way it could break --
- a listed input or action giving the wrong result, or a named error case not handled;
- a dependency failing (network, CLI, disk, a fetch or save that errors or times out);
- timing: two actions racing, replies arriving out of order, a stale value shown as fresh;
- repetition: doing it twice, cancel then retry, undo then redo;
- state left behind, and interactions with behavior that already existed.
Only then write a battery of automated tests in the project's existing test setup covering every realistic item on the map -- one test per distinct risk, no near-duplicates. Do not stop at the first failure. Run them all.

${SCOPE_RULES}

Rules:
- Only add or edit test files. Never touch the code under test.
- A test must fail because the change is wrong, not because the test is broken.
- Show the risk map in your report, marking each item tested -> passed or failed (or skipped, with why).
- ${PROOF_RULE}
- ${FINDINGS_RULE}
- If any test fails legitimately: list EVERY failing test -- the words of the task it enforces, the test as file:line plus its name, and its failure output -- plus the command to run them, then end with the line: VERDICT: GUILTY
- If every test passes, end with the line: VERDICT: ACQUITTED`;
}

export function defensePrompt(task, report) {
  return `${DEFENSE_OPENER} Your task was:

"""
${task}
"""

The prosecutor's report:

${report}

Each failing test is given as file:line, so you can go straight to it instead of reading the whole test file; read anything else in the repository you need. The failure output is already in the report, so there is no need to re-run the tests before fixing.

Before touching any code, rule on each failing test separately: does it check something the task as written requires? A test is OUT of scope if it demands behavior the task never stated (extra precision, absurd or contrived inputs, a preference), or contradicts a test already accepted.

- In scope: fix the code so the test passes and keep the rest of the suite green. Do not edit or delete the test. Fix every in-scope test in this turn.
- Out of scope: do NOT change the code to satisfy it -- bending the code to an unstated requirement is scope creep, not diligence. Leave the test file alone (the prosecutor owns it) and write a line "OBJECTION: <test name> -- <the task text showing why it is out of scope>".

${SIDE_EFFECT_RULE}

After fixing, run once: the prosecutor's test files, the tests for the files you touched, and the typecheck. ${PROOF_RULE} The prosecutor relies on this output instead of re-running them.

End with a ruling list: each failing test's name, then FIXED or OBJECTION. Push back whenever a test is out of scope; agreeing just to end the review is a failure.`;
}

export function redesignPrompt(task, report, chain = null) {
  const where = chain?.area ? ` (${chain.area})` : "";
  const history = chain?.rounds?.length
    ? `Rounds ${chain.rounds.join(", ")} each failed in the same logic${where}, and each failure was caused by the previous round's fix.`
    : `The user stopped the patch loop on this area${where} and asked for a redesign.`;
  return `${DEFENSE_OPENER} Patches here aren't converging. ${history} Do NOT patch the failing test this time. Your task was:

"""
${task}
"""

The prosecutor's report:

${report}

Redesign this part instead:
1. List the state involved: every variable, counter, cache, ref, prop, stored or remembered value this logic reads or writes, and who writes each one.
2. Rewrite it around ONE source of truth. Everything else is derived from it when needed, not stored next to it.
3. Delete the bookkeeping the earlier patches added (counters, remembered choices, last-sent copies, sync flags) -- this part of the diff should remove more than it adds.
4. Then run ALL of the prosecutor's test files, not just the failing one, plus the tests for the files you touched and the typecheck. ${PROOF_RULE}

A failing test that is out of scope still gets an "OBJECTION: <test name> -- <task text>" line; leave the prosecutor's test files alone. End with the state list, then a ruling list: each failing test's name, then FIXED or OBJECTION.`;
}

/** Last verdict line wins. "guilty", "acquitted", or null when the line is missing. */
export function parseVerdict(text) {
  const matches = [
    ...String(text ?? "").matchAll(/VERDICT\**\s*[:=\-–—]?\s*\**\s*(NOT[ -]GUILTY|GUILTY|ACQUITTED)\b/gi),
  ];
  const last = matches.at(-1)?.[1]?.toLowerCase();
  if (last === "guilty") return "guilty";
  return last ? "acquitted" : null;
}

export function parseFindings(report) {
  const text = String(report ?? "");
  const findings = [];
  for (const [, id, rest] of text.matchAll(/^[\s>*_-]*FINDING\W*\s*([A-Za-z]*\d+|[A-Za-z][\w-]*)\s*[:|-]?\s*(.*)$/gim)) {
    const finding = { id: id.toUpperCase() };
    for (const part of rest.split("|")) {
      const field = part.match(/^\s*\**\s*(requirement|test|command)\s*\**\s*[:=]\s*(.+?)\s*$/i);
      if (field) finding[field[1].toLowerCase()] = field[2].replace(/^["“]|["”]$/g, "");
      const caused = part.match(/caused[\s_-]*by[\s_-]*last[\s_-]*fix\W*\s*(yes|no|y|n|true|false)\b/i);
      if (caused) finding.causedByLastFix = /^[yt]/i.test(caused[1]);
    }
    if (finding.test || finding.requirement) findings.push(finding);
  }
  if (findings.length) return findings;
  const refs = [...new Set([...text.matchAll(/([\w./@-]+\.[A-Za-z]+:\d+)/g)].map((match) => match[1]))];
  return refs.map((test, index) => ({ id: `F${index + 1}`, test }));
}

export function parseObjections(reply) {
  return [...String(reply ?? "").matchAll(/OBJECTION\W*\s*(.+?)\s+(?:--|—|–)\s+(.+)$/gim)].map(
    ([, target, reason]) => ({ target: target.trim(), reason: reason.trim() }),
  );
}

export function bugCounts(log) {
  const counts = new Map();
  for (const entry of log ?? [])
    if (!entry.died && entry.by !== "acceptance gate" && entry.findings)
      counts.set(entry.round, entry.findings.length);
  return [...counts.values()];
}

export const DEFAULT_TEST_PATTERNS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "test/**",
  "tests/**",
  "**/test/**",
  "**/tests/**",
];

const DEFAULT_TIMEOUT_SEC = 300;

export function normalizeConfig(raw) {
  const strings = (value, max, len) =>
    (Array.isArray(value) ? value : [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item && item.length <= len)
      .slice(0, max);
  const commands = (Array.isArray(raw?.commands) ? raw.commands : [])
    .map((item) => (typeof item === "string" ? { run: item } : item))
    .map((item) => ({
      run: String(item?.run ?? "").trim(),
      timeoutSec: Math.min(3600, Math.max(1, Math.round(Number(item?.timeoutSec) || DEFAULT_TIMEOUT_SEC))),
    }))
    .filter((item) => item.run && item.run.length <= 500)
    .slice(0, 10);
  const patterns = strings(raw?.testPatterns, 50, 200);
  return { testPatterns: patterns.length ? patterns : DEFAULT_TEST_PATTERNS, commands };
}

/** `*` is one path segment. `**` is any number of segments, including zero. */
export function matchGlob(file, pattern) {
  const segs = String(file ?? "").replaceAll("\\", "/").split("/").filter(Boolean);
  const parts = String(pattern ?? "").split("/");
  const walk = (si, pi) => {
    if (pi === parts.length) return si === segs.length;
    const part = parts[pi];
    if (part === "") return walk(si, pi + 1);
    if (part === "**") {
      if (pi === parts.length - 1) return true;
      for (let k = si; k <= segs.length; k += 1) if (walk(k, pi + 1)) return true;
      return false;
    }
    if (si >= segs.length) return false;
    if (!matchPart(part, segs[si])) return false;
    return walk(si + 1, pi + 1);
  };
  return walk(0, 0);
}

function matchPart(part, seg) {
  const body = part
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`).test(seg);
}

export const isTestPath = (file, patterns = DEFAULT_TEST_PATTERNS) =>
  patterns.some((pattern) => matchGlob(file, pattern));

export const isRepoPath = (file) =>
  Boolean(file) && !file.startsWith("/") && !file.split("/").includes("..") && !file.includes("\\");

export function unquoteGitPath(file) {
  const path = String(file ?? "").replaceAll("\\", "/");
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path);
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}

export function parseNameStatus(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.match(/^([AMDT])\t(.+)$/))
    .filter(Boolean)
    .map(([, status, path]) => ({ status, path: unquoteGitPath(path) }))
    .filter((change) => isRepoPath(change.path));
}

export function reportedTestFiles(report, patterns) {
  const found = new Set();
  for (const [, path] of String(report ?? "").matchAll(/([\w./@-]+\.[A-Za-z]+):\d+/g)) {
    const clean = path.replace(/^\.\//, "");
    if (isRepoPath(clean) && isTestPath(clean, patterns)) found.add(clean);
  }
  return [...found];
}

const CHECK_LINE = /\b(assert\w*|expect|should)\b|\b(test|it|describe)\s*\(|^\s*def test_|t\.(Error|Fatal)/;
const DISABLE_LINE = /\.(skip|only|todo)\b|\b(xit|xtest|xdescribe)\s*\(|\bskip\s*:\s*true|@pytest\.mark\.(skip|xfail)|\bt\.Skip\(|#\[ignore\]/;

export function weakening(patch) {
  let removedChecks = 0;
  let disabled = 0;
  for (const line of String(patch ?? "").split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-") && CHECK_LINE.test(line.slice(1))) removedChecks += 1;
    if (line.startsWith("+") && DISABLE_LINE.test(line.slice(1))) disabled += 1;
  }
  return { removedChecks, disabled };
}

export const describeFlags = (flags) =>
  (flags ?? [])
    .map((flag) =>
      flag.kind === "deleted"
        ? `${flag.path} deleted`
        : `${flag.path} edited${flag.removedChecks ? `, ${flag.removedChecks} check line(s) removed` : ""}${flag.disabled ? `, ${flag.disabled} skip/only/todo added` : ""}`,
    )
    .join("; ");

export const gateSummary = (gate) =>
  (gate?.results ?? [])
    .map((result) => `${result.ok ? "pass" : result.timedOut ? "TIMED OUT" : `FAIL (exit ${result.exitCode})`}: ${result.command}`)
    .join("\n");

export function gateReport(gate) {
  const failed = (gate?.results ?? []).filter((result) => !result.ok);
  return `The server ran the workspace's acceptance gate after the prosecutor acquitted, and it did not pass:

${failed
  .map(
    (result) =>
      `$ ${result.command}\n${result.timedOut ? "(timed out -- killed)\n" : `(exit ${result.exitCode})\n`}${String(result.output ?? "").trim()}`,
  )
  .join("\n\n")}

Fix the code so these commands pass.`;
}

const STOP = new Set(
  ("const let var function return async await import export from default class extends new this true false null undefined " +
    "typeof instanceof else while break continue switch case throw catch finally void yield delete static super " +
    "test describe expect assert equal strictEqual deepEqual deepStrictEqual notEqual toBe toEqual toHaveBeenCalled ok " +
    "beforeEach afterEach before after should then length push string number boolean object Promise resolve reject " +
    "console error JSON Object Array Math Date String Number Boolean require module exports node").split(" "),
);

export function codeSymbols(text, strict = false) {
  const found = new Set();
  for (const [word] of String(text ?? "").matchAll(/[A-Za-z_$][\w$]{3,}/g)) {
    if (STOP.has(word)) continue;
    if (strict && !/[a-z][A-Z]|_|\$/.test(word)) continue;
    found.add(word);
  }
  return found;
}

const DECLARE = /\b(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
const DESTRUCTURE = /\b(?:const|let|var)\s*[[{]([^\]}=]*)[\]}]/g;
const WRITE = /([A-Za-z_$][\w$]*)\s*(?:\+\+|--|[-+*/|&?]?=(?![=>]))/g;
const METHOD = /^\s*(?:async\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;

export function declaredSymbols(line) {
  const names = [];
  for (const regex of [DECLARE, WRITE]) for (const match of String(line).matchAll(regex)) names.push(match[1]);
  for (const [, list] of String(line).matchAll(DESTRUCTURE)) names.push(list);
  const method = String(line).match(METHOD);
  if (method && !/^(if|for|while|switch|catch|function)$/.test(method[1])) names.push(method[1]);
  return codeSymbols(names.join(" "));
}

export function patchSymbols(patch, skip = []) {
  const found = new Set();
  let file = "";
  for (const line of String(patch ?? "").split("\n")) {
    const header = line.match(/^\+\+\+ (?:b\/)?(.*)$/);
    if (header) {
      file = header[1];
      continue;
    }
    if (skip.includes(file) || line.startsWith("---")) continue;
    const hunk = line.match(/^@@[^@]*@@(.*)$/);
    const text = hunk ? hunk[1] : /^[+-]/.test(line) ? line.slice(1) : "";
    for (const word of declaredSymbols(text)) found.add(word);
  }
  return found;
}

export function chainLink({ round, patch, findings, bodies = [], report = "", skip = [], small = 3 }) {
  if (!findings?.length || findings.length > small) return null;
  const tagged = findings.some((finding) => finding.causedByLastFix === true);
  const changed = patchSymbols(patch, skip);
  const used = codeSymbols(bodies.join("\n"));
  for (const finding of findings)
    for (const word of codeSymbols(`${finding.test ?? ""} ${finding.requirement ?? ""}`, true)) used.add(word);
  for (const word of codeSymbols(report, true)) used.add(word);
  const symbols = [...changed].filter((word) => used.has(word)).sort();
  if (!tagged && !symbols.length) return null;
  const testPathOf = (finding) => String(finding?.test ?? "").match(/([\w./@-]+\.[A-Za-z]+):(\d+)/);
  const files = [...new Set(findings.map((finding) => testPathOf(finding)?.[1]).filter(Boolean))].sort();
  return { round, symbols, files, tagged };
}

export function chainArea(previous, link) {
  if (!previous || !link || previous.round !== link.round - 1) return null;
  const symbols = link.symbols.filter((word) => previous.symbols.includes(word));
  const files = link.files.filter((path) => previous.files.includes(path));
  if (!symbols.length && !files.length) return null;
  return [files.join(", "), symbols.slice(0, 6).join(", ")].filter(Boolean).join(" · ");
}

export function atLeastEffort(current, floor) {
  if (!current) return floor;
  const from = EFFORTS.indexOf(current);
  const to = EFFORTS.indexOf(floor);
  if (from < 0 || to < 0) return current;
  return from >= to ? current : floor;
}
