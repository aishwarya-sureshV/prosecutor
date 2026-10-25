/**
 * Adversarial review with no human in the loop.
 *
 * The executor applies the task. The prosecutor may only add or edit test
 * files and must end GUILTY or ACQUITTED. A guilty report goes back to the
 * executor, which may fix code or OBJECT. Source edits by the prosecutor are
 * reverted. Test edits by the executor are rejected. An acquittal is verified
 * only when the caller's acceptance gate passes.
 *
 * Both sides are plain functions. They may be the same model.
 */
import { randomUUID } from "node:crypto";
import {
  INTEGRITY_NOTE,
  MAX_ROUNDS,
  EXTRA_ROUNDS,
  ROUND_CEILING,
  HARD_CEILING,
  REDESIGN_EFFORT,
  atLeastEffort,
  bugCounts,
  caseBrief,
  chainArea,
  chainLink,
  changeNote,
  defensePrompt,
  describeFlags,
  executorBrief,
  gateReport,
  historyBrief,
  normalizeConfig,
  parseFindings,
  parseNameStatus,
  parseVerdict,
  prosecutionPrompt,
  redesignPrompt,
  reportedTestFiles,
  sessionHistory,
  VERDICT_FOLLOWUP,
} from "./protocol.js";
import { gitWorkspace, runGate } from "./workspace.js";

const DEFAULT_PROMPTS = {
  prosecution: prosecutionPrompt,
  defense: defensePrompt,
  redesign: redesignPrompt,
  verdictFollowup: VERDICT_FOLLOWUP,
  integrity: INTEGRITY_NOTE,
};

function clamp(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.floor(n));
}

function asHistory(value, task) {
  if (!Array.isArray(value) || !value.length) return [];
  if (value.some((item) => item && item.role)) return sessionHistory(value, task);
  return value.filter((item) => item && item.prompt).slice(-20);
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

async function callSide(side, ctx) {
  if (ctx.signal?.aborted) throw abortError();
  const result = await side(ctx);
  if (typeof result === "string") return result;
  if (result == null) return "";
  if (result.error) throw new Error(result.message || result.text || "side failed");
  return String(result.text ?? "");
}

function capReached(record, maxRounds) {
  if (record.round >= record.capAt) return true;
  const [before, last] = bugCounts(record.log).slice(-2);
  return record.round > maxRounds && last > before;
}

/**
 * @param {object} options
 * @param {string} options.task
 * @param {string} [options.cwd]
 * @param {(ctx: object) => Promise<string|{text:string}>} options.executor
 * @param {(ctx: object) => Promise<string|{text:string}>} options.prosecutor
 * @param {string[]|{commands?:any[], testPatterns?:string[]}} [options.gate]
 * @param {boolean} [options.requireGate] acquittal without a gate stops instead of accepting
 * @param {"implement"|"review"} [options.start] "review" skips the first executor turn
 * @param {string} [options.baseline] git sha (or workspace snapshot id) from before the change
 * @param {"always"|"first"} [options.brief] "first" for a side that keeps its own transcript
 * @param {string} [options.model] passed to both sides; one model is fine
 * @param {(state: object) => Promise<string>|string} [options.onCap] continue | redesign | accept | stop
 * @param {(event: object) => void} [options.onEvent]
 * @param {object} [options.workspace] custom driver; default is git
 * @param {AbortSignal} [options.signal]
 */
export async function runCase(options = {}) {
  if (!options || typeof options !== "object") throw new TypeError("options object required");
  const task = String(options.task ?? "").trim();
  if (!task) throw new TypeError("task is required");
  if (typeof options.executor !== "function") throw new TypeError("executor side must be a function");
  if (typeof options.prosecutor !== "function") throw new TypeError("prosecutor side must be a function");
  const cwd = options.cwd || process.cwd();
  const maxRounds = clamp(options.maxRounds, MAX_ROUNDS, HARD_CEILING);
  const ceiling = Math.max(maxRounds, clamp(options.ceiling, ROUND_CEILING, HARD_CEILING));
  const extraRounds = clamp(options.extraRounds, EXTRA_ROUNDS, HARD_CEILING);
  const prompts = { ...DEFAULT_PROMPTS, ...(options.prompts || {}) };
  const config = normalizeConfig({
    commands: Array.isArray(options.gate) ? options.gate : options.gate?.commands,
    testPatterns: options.testPatterns || options.gate?.testPatterns,
  });
  const history = asHistory(options.history, task);
  const brief = options.brief === "first" ? "first" : "always";
  const start = options.start === "review" ? "review" : "implement";
  const model = options.model ? String(options.model) : "";
  const ownWorkspace = !options.workspace;
  const workspace = options.workspace ?? gitWorkspace(cwd);
  const signal = options.signal;
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      /* a listener must not break the case */
    }
  };
  const name = model || "prosecutor";
  const record = {
    id: randomUUID(),
    task,
    cwd,
    model,
    sameModel: options.executor === options.prosecutor,
    status: "running",
    verified: false,
    reason: "",
    round: 0,
    capAt: maxRounds,
    ceiling,
    defense: "",
    implementation: "",
    verdict: null,
    findings: [],
    owned: [],
    flags: [],
    gate: null,
    log: [],
    chain: null,
    link: null,
  };
  let base = null;
  // Owned tests that were in the last successful round snapshot.
  // Files a voided round added are not protected against that older snapshot.
  let protectedTests = [];
  let integrityRetries = 0;
  let boundaryStrikes = 0;
  let redesignRound = null;
  let finished = null;

  const end = (status, reason) => {
    if (finished) return finished;
    record.status = status;
    record.reason = reason;
    record.verified = status === "accepted" && record.gate?.ok === true;
    record.rounds = record.round;
    emit({ type: "done", status, verified: record.verified, reason, round: record.round });
    finished = publicCase(record);
    return finished;
  };

  const ctxFor = (role, round, prompt, effort) => ({
    role,
    round,
    prompt,
    cwd,
    task,
    effort: effort || "",
    model,
    signal,
    onEvent: (event) => emit({ ...event, role, round }),
  });

  async function settleBoundary(commit, reportText) {
    const split = await workspace.prosecutorChanges(commit, config.testPatterns, signal);
    if (!split) return { ok: false, error: "could not check the prosecutor edit boundary" };
    const owned = new Set(record.owned);
    for (const change of split.tests) {
      if (change.status === "D") owned.delete(change.path);
      else owned.add(change.path);
    }
    for (const path of reportedTestFiles(reportText, config.testPatterns)) owned.add(path);
    record.owned = [...owned];
    if (!split.breach.length) return { ok: true };
    const reverted = await workspace.revertChanges(commit, split.breach);
    const files = split.breach.map((change) => `${change.status} ${change.path}`).join(", ");
    const reason = `prosecutor edited files outside the test patterns (${files}) -- ${reverted ? "reverted, round void" : "could NOT revert them"}`;
    record.flags.push({ round: record.round, side: "prosecutor", text: reason });
    emit({ type: "boundary", round: record.round, breach: split.breach, reverted });
    return { ok: false, reverted, reason };
  }

  function voided(boundary, report) {
    record.log.push({
      round: record.round,
      by: name,
      prompt: "",
      report: report || "",
      died: boundary.reason || boundary.error,
    });
    boundaryStrikes += 1;
    const fatal = (boundary.error && !boundary.reason) || boundary.reverted === false || boundaryStrikes >= 2;
    // A voided round is re-run at the same number. A fatal breach keeps the number.
    if (!fatal) record.round -= 1;
    if (boundary.error && !boundary.reason) return end("error", boundary.error);
    if (fatal) return end("stopped", boundary.reason || boundary.error || "prosecutor edit boundary");
    return null;
  }

  try {
    if (signal?.aborted) return end("stopped", "aborted");
    base = options.baseline
      ? { ok: true, commit: String(options.baseline) }
      : await workspace.snapshot("before task");
    if (!base?.ok || !base.commit) return end("error", base?.error || "could not snapshot the workspace");

    if (start === "implement") {
      emit({ type: "status", status: "implementing", round: 0 });
      const prompt = task;
      emit({ type: "turn_start", role: "executor", round: 0 });
      record.implementation = await callSide(
        options.executor,
        ctxFor("executor", 0, prompt, options.executorEffort),
      );
      emit({ type: "turn_end", role: "executor", round: 0, text: record.implementation });
    }

    while (!signal?.aborted) {
      if (record.round >= 1 && protectedTests.length && base?.commit && workspace.checkIntegrity) {
        const flags = await workspace.checkIntegrity(base.commit, protectedTests, signal);
        if (flags == null) emit({ type: "warning", message: "could not check the prosecutor's test files" });
        else if (flags.length) {
          const text = describeFlags(flags);
          record.flags.push({ round: record.round, side: "executor", text });
          emit({ type: "integrity", round: record.round, flags });
          if (integrityRetries >= 1) {
            const restored = workspace.restore ? await workspace.restore(base.commit, protectedTests) : false;
            return end("integrity", `${text}${restored ? "" : "; could not restore the test files"}`);
          }
          integrityRetries = 1;
          const last = [...record.log].reverse().find((entry) => entry.report && !entry.died);
          const note = `${prompts.integrity}${last ? prompts.defense(task, last.report) : ""}`;
          emit({ type: "turn_start", role: "executor", round: record.round });
          record.defense = await callSide(
            options.executor,
            ctxFor("executor", record.round, note, options.executorEffort),
          );
          if (last) {
            last.reply = record.defense;
            last.replyBy = model || "executor";
          }
          emit({ type: "turn_end", role: "executor", round: record.round, text: record.defense });
          continue;
        } else integrityRetries = 0;
      }

      if (record.round + 1 > ceiling) return end("stopped", "round ceiling");
      record.round += 1;
      const reviewing = record.round;
      emit({ type: "status", status: "reviewing", round: reviewing });
      const changes = base?.commit && workspace.changedSince ? await workspace.changedSince(base.commit, signal) : null;
      const patch = reviewing > 1 && base?.commit && workspace.repairPatch
        ? await workspace.repairPatch(base.commit, signal)
        : null;
      const before = await workspace.snapshot(`round ${reviewing} start`);
      if (!before?.ok || !before.commit) return end("error", before?.error || "could not snapshot the round");

      const includeBrief = brief === "always" || reviewing === 1;
      const briefText = includeBrief ? historyBrief(history) + caseBrief(record.log, reviewing) : "";
      const note = changeNote(changes, base?.commit, reviewing);
      const prompt = prompts.prosecution(task, reviewing, record.defense, briefText, note);
      const effort = options.effort || (reviewing === 1 ? "high" : "medium");
      emit({ type: "turn_start", role: "prosecutor", round: reviewing });
      let report;
      try {
        report = await callSide(options.prosecutor, ctxFor("prosecutor", reviewing, prompt, effort));
      } catch (error) {
        await settleBoundary(before.commit, "").catch(() => {});
        throw error;
      }
      emit({ type: "turn_end", role: "prosecutor", round: reviewing, text: report });

      let boundary = await settleBoundary(before.commit, report);
      if (!boundary.ok) {
        const stopped = voided(boundary, report);
        if (stopped) return stopped;
        continue;
      }

      let verdict = parseVerdict(report);
      if (!verdict && /^[\s>*_-]*FINDING\b/im.test(report)) verdict = "guilty";
      if (!verdict) {
        const follow = prompts.verdictFollowup;
        emit({ type: "turn_start", role: "prosecutor", round: reviewing });
        let again;
        try {
          again = await callSide(options.prosecutor, ctxFor("prosecutor", reviewing, follow, effort));
        } catch (error) {
          await settleBoundary(before.commit, report).catch(() => {});
          throw error;
        }
        emit({ type: "turn_end", role: "prosecutor", round: reviewing, text: again });
        report = `${report}\n\n${again}`;
        boundary = await settleBoundary(before.commit, report);
        if (!boundary.ok) {
          const stopped = voided(boundary, report);
          if (stopped) return stopped;
          continue;
        }
        verdict = parseVerdict(again);
        if (!verdict && /^[\s>*_-]*FINDING\b/im.test(report)) verdict = "guilty";
      }

      const findings = verdict === "acquitted" ? [] : parseFindings(report);
      record.log.push({
        round: reviewing,
        by: name,
        prompt,
        report,
        verdict,
        findings,
      });
      record.verdict = verdict;
      record.findings = findings;
      emit({ type: "verdict", round: reviewing, verdict, findings });

      let repairReport = null;
      if (verdict === "acquitted") {
        emit({ type: "status", status: "verifying", round: reviewing });
        const gateBefore = await workspace.snapshot("before gate");
        const gate = await runGate(cwd, config, record.owned, signal);
        record.gate = {
          ...gate,
          state: !gate.configured ? "not_configured" : gate.ok ? "verified" : "gate_failed",
          round: reviewing,
        };
        emit({ type: "gate", round: reviewing, gate: record.gate });
        if (signal?.aborted) return end("stopped", "aborted");
        if (gateBefore?.ok && workspace.changedSince) {
          const names = await workspace.changedSince(gateBefore.commit, signal);
          if (names == null) return end("error", "could not check the acceptance gate boundary");
          if (names.trim()) {
            if (workspace.revertChanges) await workspace.revertChanges(gateBefore.commit, parseNameStatus(names));
            return end("stopped", "acceptance gate changed the worktree");
          }
        }
        if (!gate.configured) {
          if (options.requireGate) return end("stopped", "no acceptance gate configured");
          return end("accepted", "acquitted; no acceptance gate configured");
        }
        if (gate.ok) return end("accepted", "acquitted; acceptance gate passed");
        if (reviewing >= ceiling) return end("stopped", "acceptance gate failed at the round ceiling");
        repairReport = gateReport(gate);
        record.log.push({ round: reviewing, by: "acceptance gate", prompt: "", report: repairReport });
      } else if (verdict !== "guilty") {
        return end("stopped", "no verdict");
      } else if (reviewing >= ceiling) {
        return end("stopped", "round ceiling");
      } else {
        repairReport = report;
        if (patch != null && workspace.testBodies) {
          const bodies = await workspace.testBodies(findings).catch(() => []);
          const link = chainLink({ round: reviewing, patch, findings, bodies, report, skip: record.owned });
          const area = chainArea(record.link, link);
          record.link = link;
          if (area) {
            const rounds = record.chain?.rounds?.at(-1) === reviewing - 1
              ? [...record.chain.rounds, reviewing]
              : [reviewing - 1, reviewing];
            record.chain = { rounds, area };
            redesignRound = reviewing;
          }
        }
      }

      if (capReached(record, maxRounds)) {
        const choice = typeof options.onCap === "function" ? await options.onCap(publicCase(record)) : "stop";
        emit({ type: "cap", round: reviewing, choice: choice || "stop" });
        if (choice === "accept") return end("accepted", "accepted at cap, not verified");
        if (choice === "continue") {
          const next = Math.min(ceiling, record.round + extraRounds);
          if (next <= record.capAt) return end("capped", "round cap");
          record.capAt = next;
        } else if (choice === "redesign") redesignRound = reviewing;
        else return end("capped", "round cap");
      }

      const after = await workspace.snapshot(`after round ${reviewing}`);
      if (!after?.ok || !after.commit) return end("error", after?.error || "could not snapshot before the repair");
      base = after;
      protectedTests = [...record.owned];
      const redesign = redesignRound === reviewing;
      const repairBody = redesign
        ? prompts.redesign(task, repairReport, record.chain)
        : prompts.defense(task, repairReport);
      const prior = brief === "first" ? "" : executorBrief(record.log.filter((entry) => entry.round !== reviewing));
      const repair = `${prior}${repairBody}`;
      const repairEffort = redesign ? atLeastEffort(options.executorEffort, REDESIGN_EFFORT) : options.executorEffort;
      emit({ type: "status", status: "repairing", round: reviewing });
      emit({ type: "turn_start", role: "executor", round: reviewing });
      record.defense = await callSide(options.executor, ctxFor("executor", reviewing, repair, repairEffort));
      const answered = [...record.log].reverse().find((entry) => entry.round === reviewing && entry.report && !entry.died);
      if (answered) {
        answered.reply = record.defense;
        answered.replyBy = model || "executor";
      }
      emit({ type: "turn_end", role: "executor", round: reviewing, text: record.defense });
      if (redesignRound === reviewing) redesignRound = null;
    }
    return end("stopped", "aborted");
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return end("stopped", "aborted");
    return end("error", String(error?.message ?? error));
  } finally {
    if (!options.keepSnapshots && ownWorkspace) await workspace.close?.().catch(() => {});
  }
}

function publicCase(record) {
  return {
    id: record.id,
    task: record.task,
    cwd: record.cwd,
    model: record.model,
    sameModel: record.sameModel,
    status: record.status,
    verified: record.verified,
    reason: record.reason,
    rounds: record.round,
    capAt: record.capAt,
    ceiling: record.ceiling,
    verdict: record.verdict,
    findings: record.findings.map((finding) => ({ ...finding })),
    owned: [...record.owned],
    flags: record.flags.map((flag) => ({ ...flag })),
    gate: record.gate,
    chain: record.chain ? { ...record.chain, rounds: [...(record.chain.rounds ?? [])] } : null,
    counts: bugCounts(record.log),
    implementation: record.implementation,
    log: record.log.map((entry) => ({ ...entry })),
  };
}
