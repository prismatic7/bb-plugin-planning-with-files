# bb-plugin-planning-with-files

A plan that lives on disk, so a long task keeps its state when the context is
summarised away.

Three files under `.planning/<date>-<slug>/`:

| File | Contents |
|---|---|
| `task_plan.md` | Goal + phases as `- [ ] n. …` boxes |
| `findings.md` | Facts the work established |
| `progress.md` | Append-only log |

## Tools

- **`pwf_init(goal, phases)`** — create the plan (idempotent files).
- **`pwf_status()`** — goal, every phase's state, and the tail of progress.
- **`pwf_check(tick?, note?)`** — the completion gate: refuses "done" while a
  box is empty and names what is open; `tick` marks a phase complete and logs
  the note to progress.md.

## Skill

`skills/planning-with-files/SKILL.md` carries the discipline: phases with
observable completion, findings as evidence, ticks only when the evidence
exists.

## What is not ported

Upstream `planning-with-files` also injects the plan per turn, reminds after
writes, flushes it across compaction, and holds a session open until the plan
reports complete. Those are OpenCode hook surfaces; BB gives a plugin no
per-turn hook, so this port keeps the files and the gate and says so.

## Install

```sh
npm install
npm run bundle
bb plugin install . --yes
bb plugin reload planning-with-files
```

## Development

```sh
npm run build      # tsc typecheck
npm test           # plan format, gate, slugs, on-disk round trip
npm run bundle     # bb plugin build
```
