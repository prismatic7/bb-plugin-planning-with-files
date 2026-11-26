---
name: planning-with-files
description: >
  Keep a plan on disk instead of in your head: task_plan.md, findings.md and
  progress.md under .planning/. Use for any task with more than a couple of
  steps, and whenever a task may outlive the context window — after a
  compaction the files are still there and the plan is not.
---

# Planning with files

The plan is a file, not a thought. Three files live under
`.planning/<date>-<slug>/` in the project:

| File | What goes in it |
|---|---|
| `task_plan.md` | The goal in one sentence, then phases as `- [ ] 1. …` boxes. |
| `findings.md` | Facts the work established — one bullet each, with the evidence. No narration. |
| `progress.md` | Append-only log: one entry per phase finished or discovery made. |

## The loop

1. `pwf_init(goal, phases)` — write the plan before starting. Phases must have
   observable completion ("parse() handles empty input", not "work on the
   parser").
2. Do one phase. When its evidence exists, tick it: `pwf_check(tick: n, note: …)`.
   A tick is a claim that the evidence exists — do not tick a phase because time
   passed.
3. Record what you learned in `findings.md` as you go. That file is the one
   worth keeping when the work is done.
4. `pwf_status` when you come back to the task, and after any compaction.
5. `pwf_check` before reporting the task complete. It refuses "done" while a box
   is empty, and names what is still open.

## Why files

BB's compaction summarises the conversation; a summary keeps the gist and loses
the evidence. The plan files do not get summarised — they are read back
verbatim. That is the whole argument for this skill: the plan survives what the
transcript does not.

## What this does not do

Upstream `planning-with-files` also injects the plan into every model request,
reminds after writes, and holds a session open until the plan reports complete.
Those are OpenCode hook surfaces: BB gives a plugin no per-turn hook, so here
the discipline is the agent calling the tools — which is why the ordering above
matters.
