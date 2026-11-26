// bb-plugin-planning-with-files — a plan that survives compaction.
//
// Port of OthmanAdi/planning-with-files (MIT) for BB. Upstream's value is that
// the plan is a file, not a thought: three of them, on disk, so a long task
// keeps its state when the context is summarised away.
//
//   task_plan.md  goal + phases, each ticked as it completes
//   findings.md   what the work established (facts, not narration)
//   progress.md   append-only log, one entry per phase or discovery
//
// What did NOT come across: upstream's per-turn injection, write reminders,
// compaction flush and session-idle continuation gate. Those are OpenCode hook
// surfaces BB does not expose, so the discipline is carried by the skill and
// three tools the agent calls instead of by hooks it cannot have.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const PLAN_TASK = "task_plan.md";
export const PLAN_FINDINGS = "findings.md";
export const PLAN_PROGRESS = "progress.md";

// ─── Pure helpers ─────────────────────────────────────────────────────

export interface Phase {
  n: number;
  text: string;
  done: boolean;
}

export interface Plan {
  goal: string;
  phases: Phase[];
}

/** Slug a goal into a directory name. */
export function slugify(goal: string, max = 48): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "plan";
}

/** `.planning/2026-11-26-<slug>` */
export function planDirName(goal: string, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  return `${stamp}-${slugify(goal)}`;
}

/** Parse a task_plan.md: `# goal` then `- [ ] 1. text` / `- [x] 2. text`. */
export function parsePlan(markdown: string): Plan {
  const goal = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? "(no goal recorded)";
  const phases: Phase[] = [];
  const re = /^-\s+\[( |x|X)\]\s*(?:(\d+)[.)]\s*)?(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    phases.push({
      n: m[2] ? Number(m[2]) : phases.length + 1,
      text: m[3].trim(),
      done: m[1].toLowerCase() === "x",
    });
  }
  return { goal, phases };
}

/** Render a fresh plan file. */
export function renderPlan(goal: string, phases: string[], date = new Date()): string {
  const lines = [
    `# ${goal}`,
    "",
    `Started: ${date.toISOString()}`,
    "",
    "## Phases",
    "",
    ...phases.map((p, i) => `- [ ] ${i + 1}. ${p}`),
    "",
    "Tick a phase only when its evidence exists. `pwf_check` refuses completion while any box is empty.",
    "",
  ];
  return lines.join("\n");
}

export interface CheckResult {
  complete: boolean;
  total: number;
  done: number;
  outstanding: Phase[];
  verdict: string;
}

/** The completion gate: are all phases ticked? */
export function checkPlan(plan: Plan): CheckResult {
  const outstanding = plan.phases.filter((p) => !p.done);
  const done = plan.phases.length - outstanding.length;
  if (!plan.phases.length) {
    return { complete: false, total: 0, done: 0, outstanding: [], verdict: "the plan records no phases — nothing to complete" };
  }
  if (outstanding.length) {
    return {
      complete: false,
      total: plan.phases.length,
      done,
      outstanding,
      verdict: `not complete: ${outstanding.length} of ${plan.phases.length} phase(s) still open`,
    };
  }
  return { complete: true, total: plan.phases.length, done, outstanding: [], verdict: `complete: all ${plan.phases.length} phase(s) ticked` };
}

/** One-screen status: goal, phases, and the tail of progress.md. */
export function renderStatus(plan: Plan, progressTail: string, findingsPresent: boolean): string {
  const rows = plan.phases.map((p) => `${p.done ? "[x]" : "[ ]"} ${p.n}. ${p.text}`);
  const done = plan.phases.filter((p) => p.done).length;
  return [
    `plan: ${plan.goal}`,
    `${done}/${plan.phases.length} phase(s) done · findings.md ${findingsPresent ? "present" : "missing"}`,
    "",
    ...rows,
    "",
    "recent progress:",
    progressTail.trim() ? progressTail.trim() : "(nothing logged yet)",
  ].join("\n");
}

// ─── Plugin ───────────────────────────────────────────────────────────

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-planning-with-files loaded");

  const settings = bb.settings.define({
    planRoot: {
      type: "string" as const,
      label: "Plan root",
      default: ".planning",
      description: "Directory (under the project) that holds plan folders.",
    },
  });
  let { planRoot } = await settings.get();
  settings.onChange((next) => {
    planRoot = next.planRoot;
  });

  async function activePlanDir(threadId: string, projectId: string): Promise<string | null> {
    const root = join(await threadCwd(bb, threadId, projectId), planRoot);
    if (!existsSync(root)) return null;
    const dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const d of dirs) {
      const candidate = join(root, d);
      if (existsSync(join(candidate, PLAN_TASK))) return candidate;
    }
    return null;
  }

  function resolveTarget(dir: string, name: string): string {
    return isAbsolute(name) ? name : resolve(dir, name);
  }

  bb.agents.registerTool({
    name: "pwf_init",
    description:
      "Start a file-based plan. Writes task_plan.md, findings.md and progress.md into .planning/<date>-<slug>/ " +
      "so the plan survives compaction. Give the goal and the phases you expect; tick phases as they finish " +
      "and call pwf_check before declaring the work done. Use it for any task with more than a couple of steps.",
    parameters: z.object({
      goal: z.string().min(3).max(200).describe("One sentence: what finished looks like."),
      phases: z.array(z.string().min(1).max(300)).min(1).max(20).describe("Ordered phases, each with an observable completion."),
    }),
    async execute({ goal, phases }, { threadId, projectId }) {
      const base = await threadCwd(bb, threadId, projectId);
      const dir = join(base, planRoot, planDirName(goal));
      await mkdir(dir, { recursive: true });
      const now = new Date();
      await writeFile(join(dir, PLAN_TASK), renderPlan(goal, phases, now), "utf8");
      if (!existsSync(join(dir, PLAN_FINDINGS))) {
        await writeFile(join(dir, PLAN_FINDINGS), `# Findings — ${goal}\n\nFacts established by the work, one bullet each. No narration.\n`, "utf8");
      }
      if (!existsSync(join(dir, PLAN_PROGRESS))) {
        await writeFile(join(dir, PLAN_PROGRESS), `# Progress — ${goal}\n\n## ${now.toISOString().slice(0, 16).replace("T", " ")}\nPlan created with ${phases.length} phase(s).\n`, "utf8");
      }
      return `plan created: ${dir}\n\n${renderPlan(goal, phases, now)}\nNext: work the first phase, then tick it in ${join(dir, PLAN_TASK)} and append to ${join(dir, PLAN_PROGRESS)}.`;
    },
  });

  bb.agents.registerTool({
    name: "pwf_status",
    description:
      "Read the active plan: goal, every phase with its state, and the tail of progress.md. Call it at the start " +
      "of a session, after a compaction, or whenever you need to know where the work actually stands.",
    parameters: z.object({}),
    async execute(_args, { threadId, projectId }) {
      const dir = await activePlanDir(threadId, projectId);
      if (!dir) return "pwf_status: no plan found. Start one with pwf_init.";
      const plan = parsePlan(await readFile(join(dir, PLAN_TASK), "utf8"));
      const progress = existsSync(join(dir, PLAN_PROGRESS)) ? await readFile(join(dir, PLAN_PROGRESS), "utf8") : "";
      const tail = progress.trim().split("\n").slice(-12).join("\n");
      return renderStatus(plan, tail, existsSync(join(dir, PLAN_FINDINGS)));
    },
  });

  bb.agents.registerTool({
    name: "pwf_check",
    description:
      "The completion gate. Refuses 'done' while any phase in task_plan.md is unticked, and names the phases still " +
      "open. Optionally tick a phase in the same call (tick: <n>) — that is a claim that its evidence exists. " +
      "Call it before you report a task finished.",
    parameters: z.object({
      tick: z.number().int().min(1).optional().describe("Phase number to mark complete before checking."),
      note: z.string().max(500).optional().describe("What was done, appended to progress.md when ticking."),
    }),
    async execute({ tick, note }, { threadId, projectId }) {
      const dir = await activePlanDir(threadId, projectId);
      if (!dir) return "pwf_check: no plan found. Start one with pwf_init.";
      const taskPath = join(dir, PLAN_TASK);
      let markdown = await readFile(taskPath, "utf8");

      if (tick !== undefined) {
        const plan = parsePlan(markdown);
        const phase = plan.phases.find((p) => p.n === tick);
        if (!phase) return `pwf_check: phase ${tick} does not exist (plan has ${plan.phases.length}).`;
        markdown = markdown.replace(
          new RegExp(`^-\\s+\\[( |x|X)\\]\\s*(?:${tick}[.)]\\s*)?`, "m"),
          `- [x] ${tick}. `,
        );
        await writeFile(taskPath, markdown, "utf8");
        if (existsSync(join(dir, PLAN_PROGRESS))) {
          const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
          await appendFile(join(dir, PLAN_PROGRESS), `\n## ${stamp} — phase ${tick} complete\n${note ? note + "\n" : ""}`, "utf8");
        }
      }

      const result = checkPlan(parsePlan(markdown));
      const lines = [result.verdict];
      if (result.outstanding.length) {
        lines.push("", "still open:");
        for (const p of result.outstanding) lines.push(`  [ ] ${p.n}. ${p.text}`);
        lines.push("", "Tick each one as its evidence lands, then call pwf_check again.");
      } else if (result.complete) {
        lines.push("", "Report the result, and keep findings.md as the record of what was established.");
      }
      return lines.join("\n");
    },
  });

  bb.onDispose(() => {
    bb.log.info("bb-plugin-planning-with-files disposed");
  });
}
/** The directory this thread actually works in: its environment's path, not
 *  the project root. A worktree or an attached workspace is a different
 *  directory from the project, and resolving paths against the project puts
 *  files in the wrong tree. */
export async function threadCwd(bb: BbPluginApi, threadId: string, projectId: string): Promise<string> {
  const asPath = (v: any): string | null =>
    v && typeof v === "object" && typeof v.path === "string" && v.path.trim() ? v.path : null;
  try {
    const t: any = await bb.sdk.threads.get({ threadId } as any);
    const thread = t?.thread ?? t;
    const envId = thread?.environmentId;
    if (envId) {
      const e: any = await bb.sdk.environments.get({ environmentId: envId } as any);
      const p = asPath(e?.environment ?? e);
      if (p) return p;
    }
  } catch {
    // fall through to the project
  }
  try {
    const p: any = await bb.sdk.projects.get({ projectId } as any);
    const sources = (p?.project ?? p)?.sources ?? [];
    const src = Array.isArray(sources) ? sources.find((s: any) => s.type === "local_path") : null;
    if (src?.path) return src.path;
  } catch {
    // fall through to the server cwd
  }
  return process.cwd();
}
