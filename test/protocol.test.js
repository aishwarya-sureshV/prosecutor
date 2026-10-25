import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chainArea,
  chainLink,
  matchGlob,
  parseFindings,
  parseVerdict,
} from "../src/protocol.js";

test("parseVerdict uses the last line and treats not-guilty as acquitted", () => {
  assert.equal(parseVerdict("VERDICT: GUILTY\nVERDICT: ACQUITTED"), "acquitted");
  assert.equal(parseVerdict("Verdict - **Not guilty**"), "acquitted");
  assert.equal(parseVerdict("no line"), null);
  assert.equal(parseVerdict("VERDICT: GUILTY"), "guilty");
});

test("parseFindings keeps the command as data and does not require a verdict", () => {
  const [finding] = parseFindings(
    'FINDING F1 | requirement: "returns a + b" | test: src/add.test.mjs:4 negatives | command: touch should-not-run',
  );
  assert.equal(finding.id, "F1");
  assert.equal(finding.command, "touch should-not-run");
  assert.equal(finding.test, "src/add.test.mjs:4 negatives");
});

test("test globs match the default layouts", () => {
  const cases = [
    ["src/add.test.js", "**/*.test.*", true],
    ["src/add.spec.ts", "**/*.spec.*", true],
    ["__tests__/a.js", "**/__tests__/**", true],
    ["src/__tests__/a.js", "**/__tests__/**", true],
    ["test/a.js", "test/**", true],
    ["src/test/a.js", "test/**", false],
    ["src/test/a.js", "**/test/**", true],
    ["tests/a.js", "tests/**", true],
    ["src/add.js", "**/*.test.*", false],
    ["src/add.test.mjs", "**/*.test.*", true],
  ];
  for (const [file, pattern, expected] of cases)
    assert.equal(matchGlob(file, pattern), expected, `${file} vs ${pattern}`);
});

test("two linked rounds over the same test file are a chain", () => {
  const first = chainLink({
    round: 2,
    patch: "+++ b/src/add.mjs\n@@ function add\n+export function add(a, b) { return a + b }",
    findings: [{ id: "F1", test: "src/add.test.mjs:4 negatives", requirement: "returns a + b", causedByLastFix: true }],
    bodies: ["assert.equal(add(-1, 1), 0)"],
  });
  const second = chainLink({
    round: 3,
    patch: "+++ b/src/add.mjs\n@@ function add\n+export function add(a, b) { return a + b }",
    findings: [{ id: "F1", test: "src/add.test.mjs:4 negatives", causedByLastFix: true }],
  });
  assert.ok(first);
  assert.match(chainArea(first, second), /add\.test\.mjs/);
  assert.equal(chainArea(first, { ...second, round: 5 }), null);
});
