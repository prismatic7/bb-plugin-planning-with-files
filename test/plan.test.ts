// planning-with-files tests: the plan format, the gate, the slug, and a real
// init → tick → check cycle on a temp directory.
//
// Run: node --test test/plan.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPlan, parsePlan, planDirName, renderPlan, renderStatus, slugify } from "../server.ts";

const PLAN = `# Ship the parser

Started: 2026-11-26

## Phases

- [x] 1. Read the spec
- [ ] 2. Implement parse()
- [ ] 3. Wire it into the CLI
`;

test("parsePlan reads the goal and each phase's state", () => {
  const p = parsePlan(PLAN);
  assert.equal(p.goal, "Ship the parser");
  assert.equal(p.phases.length, 3);
  assert.deepEqual(p.phases.map((x) => x.done), [true, false, false]);
  assert.equal(p.phases[1].text, "Implement parse()");
});

test("renderPlan round-trips through parsePlan", () => {
  const md = renderPlan("Do a thing", ["first", "second"], new Date("2026-11-26T10:00:00Z"));
  const p = parsePlan(md);
  assert.equal(p.goal, "Do a thing");
  assert.deepEqual(p.phases.map((x) => x.text), ["first", "second"]);
  assert.equal(p.phases.every((x) => !x.done), true);
});

test("the gate refuses while a phase is open, and names them", () => {
  const r = checkPlan(parsePlan(PLAN));
  assert.equal(r.complete, false);
  assert.equal(r.done, 1);
  assert.equal(r.total, 3);
  assert.deepEqual(r.outstanding.map((p) => p.n), [2, 3]);
  assert.match(r.verdict, /2 of 3 phase/);
});

test("the gate passes only when every phase is ticked", () => {
  const all = PLAN.replace("- [ ] 2.", "- [x] 2.").replace("- [ ] 3.", "- [x] 3.");
  const r = checkPlan(parsePlan(all));
  assert.equal(r.complete, true);
  assert.equal(r.verdict, "complete: all 3 phase(s) ticked");
});

test("a plan with no phases cannot be complete", () => {
  const r = checkPlan(parsePlan("# Goal only\n"));
  assert.equal(r.complete, false);
  assert.match(r.verdict, /no phases/);
});

test("slug and directory naming are stable and safe", () => {
  assert.equal(slugify("Ship the Parser!"), "ship-the-parser");
  assert.equal(slugify("  "), "plan");
  assert.match(planDirName("Ship the parser", new Date("2026-11-26T00:00:00Z")), /^2026-11-26-ship-the-parser$/);
});

test("renderStatus shows progress and whether findings exist", () => {
  const out = renderStatus(parsePlan(PLAN), "## 10:00\nread the spec", false);
  assert.match(out, /1\/3 phase\(s\) done/);
  assert.match(out, /findings\.md missing/);
  assert.match(out, /read the spec/);
});

test("a real plan directory round-trips on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "pwf-"));
  const planDir = join(dir, planDirName("Ship the parser", new Date("2026-11-26T00:00:00Z")));
  // Simulate what pwf_init writes (the tool itself needs a bb project context).
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, "task_plan.md"), PLAN);
  const read = parsePlan(readFileSync(join(planDir, "task_plan.md"), "utf8"));
  assert.equal(read.phases.length, 3);
  assert.equal(existsSync(join(planDir, "task_plan.md")), true);
});
