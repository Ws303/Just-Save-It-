# Just-Save-It: delivery

<!-- 6W handoff. project just-save-it. blueprint 0.1.1. state sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36. generated 2026-11-13T08:58:36.403Z. schema 0.1. rubric 0.2. -->

Milestones, capacity, the ordered task checklist and how each task is verified.

| Project | Blueprint | State hash | Generated | Schema | Rubric |
| --- | --- | --- | --- | --- | --- |
| `just-save-it` | 0.1.1 | `sha256:6a36af609b89c6582649d396ae783ca842ebb1931fc9fd7b0c9872d3f5e5ab36` | 2026-11-13T08:58:36.403Z | 0.1 | 0.2 |

## Capacity and dates

Human operator directing full-cycle AI engineering \(Claudy + deterministic test gates\) in a dedicated sprint today \(backend\) and tomorrow \(UI integration\).

Aggressive 2-day sprint \(Day 1 = Backend Part 1 -\> Part 2 -\> Part 3 with offline SQL + Pytest gates; Day 2 = Live UI & Cloud integration\). Tight schedule carries multi-client UI compression risk \(RISK-004\) without buffer.

## Cut line

Clear sequential cut line: Part 1 DB+Auth -\> Part 2 Unfurl -\> Part 3 Reminders must pass tests independently before next part starts; Day-2 real test verifies Primary Web UI + API end-to-end first, then Mobile Expo reminder sync, deferring Browser Extension polish if Day-2 runs late.

## Tasks

- [ ] <a id="task-001"></a>**TASK-001** Investigate Thailand PDPA notice, user delete-all-data cascade flow, Supabase/Gemini/Groq DPA & retention rules, and oEmbed/robots ToS \(Owner: Founder, Before: Public Beta\). Milestone: . Verify: . Links: [RISK-003](RISKS-AND-ASSUMPTIONS.md#risk-003).
- [ ] <a id="task-002"></a>**TASK-002** Verify live Supabase Free/Pro and Gemini/Groq API pricing pages with access date to replace provisional unit-economics estimates \(Owner: Founder, Before: Paid Tier Launch\). Milestone: . Verify: . Links: [RISK-002](RISKS-AND-ASSUMPTIONS.md#risk-002), [DEC-005](DECISIONS.md#dec-005).
- [ ] <a id="task-003"></a>**TASK-003** Run sequential Backend Sprint today \(Part 1 DB+Auth+Multi-lang -\> Part 2 Unfurl -\> Part 3 Reminders, full Pytest gates\) then Primary Web UI integration tomorrow \(Owner: Claudy + Founder, Before: Day 2 E2E\). Milestone: . Verify: . Links: [DEC-004](DECISIONS.md#dec-004), [RISK-004](RISKS-AND-ASSUMPTIONS.md#risk-004).
