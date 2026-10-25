/**
 * Portable prosecutor / executor loop.
 *
 * Plug any coding CLI or agent in as a side. Both sides may be the same model.
 *
 *   import { runCase, createCliSide, createSameModel } from "prosecutor";
 *   const side = createCliSide({ command: "claude", args: ["-p"] });
 *   const result = await runCase({ cwd, task, ...createSameModel(side), gate: ["npm test"] });
 */
export { runCase } from "./loop.js";
export {
  createCliSide,
  createSameModel,
  createStdioHarness,
} from "./sides.js";
export { gitWorkspace, runCommand, runGate } from "./workspace.js";
export {
  CAP_CHOICES,
  DEFENSE_OPENER,
  DEFAULT_TEST_PATTERNS,
  EFFORTS,
  EXTRA_ROUNDS,
  HARD_CEILING,
  INTEGRITY_NOTE,
  MAX_ROUNDS,
  PROOF_RULE,
  REDESIGN_EFFORT,
  ROUND_CEILING,
  SCOPE_RULES,
  SIDE_EFFECT_RULE,
  VERDICT_FOLLOWUP,
  bugCounts,
  caseBrief,
  chainArea,
  chainLink,
  changeNote,
  defensePrompt,
  describeFlags,
  executorBrief,
  gateReport,
  gateSummary,
  historyBrief,
  isRepoPath,
  isTestPath,
  matchGlob,
  messageText,
  normalizeConfig,
  parseFindings,
  parseNameStatus,
  parseObjections,
  parseVerdict,
  prosecutionPrompt,
  redesignPrompt,
  reportedTestFiles,
  sessionHistory,
} from "./protocol.js";
