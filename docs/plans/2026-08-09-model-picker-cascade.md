# Model Picker Cascade — Provider → Subprovider → Model → Effort (Addendum 2)

> **For agentic workers:** Read the Global Constraints in `docs/plans/2026-08-09-project-profiles.md` FIRST — they apply unchanged (branch `feat/project-profiles`, DCO `git commit -s`, stage only exact feature paths, never `git add -A`, never push, no optional `?:` params, `cn()` for classNames, never bare `tsc` — typecheck via `bunx nx run traycer-clients-gui-app:compile`, export `PATH="$HOME/.bun/bin:$PATH"` if subshells can't find bun). Read repo-root `AGENTS.md` + `clients/gui-app/AGENTS.md` before coding.

**Goal:** Restructure the harness model picker (`clients/gui-app/src/components/home/pickers/harness-model-picker*.tsx|ts`) from "provider rail + flat model list with section headers + reasoning footer" into a 4-level drill-down cascade: **Provider → Subprovider → Model → Effort**.

**User-visible behavior (acceptance criteria):**

1. **Rail (unchanged):** provider icons on the left, exactly as today. Browsing a rail entry drills into level 1.
2. **Level 1 — Subprovider:** shown ONLY when the browsed rail entry's models carry 2+ distinct `providerGroupId`s (e.g. Oh My Pi → "ClinePass", "Command Code"). Each row: group label + model count (+ `capacityLabel` when present). If the entry has 0–1 groups, or the rail entry is already profile-scoped (`activeProfileId !== null` for a split harness), SKIP this level — go straight to models.
3. **Level 2 — Models:** the models of the chosen subprovider, rendered like today's model rows (same `HarnessModelPickerItem`, same selected/active states) but WITHOUT group section headers (the level above already names the group).
4. **Level 3 — Effort:** shown ONLY when the chosen model has `supportedReasoningEfforts.length > 0`. Rows: each effort option (label + description), with the model's `defaultReasoningEffort` (or the current composer setting when it matches this model) pre-highlighted so Enter confirms instantly. Choosing an effort applies model+effort and closes the picker. Models with no efforts complete at level 2 (today's behavior).
5. **Search bypass:** typing any query flattens everything into today's global fuzzy-filtered list across ALL groups (current `filterModelRows` behavior). Selecting a search result for a model WITH efforts still drills to level 3 (consistent); without efforts, completes immediately.
6. **Navigation back:** a level header row shows the path (e.g. `‹ Oh My Pi / ClinePass` on level 2, `‹ … / Kimi K3` on level 3). Clicking it, pressing `ArrowLeft`, or `Escape`/`Backspace` with an EMPTY query goes up one level. Level 1 → back means returning to subprovider list when it exists, otherwise no-op (rail focus rules unchanged). Never trap the user.
7. **Current selection stays visible:** the row matching the current composer selection shows its check/active styling at whatever level it lives; reopening the picker lands on the level of the current selection (model level inside its subprovider), exactly where the user left off.
8. **Reasoning footer:** keep the existing `ModelSettingsFooter` behavior for the SELECTED model as-is (it is how users change effort without re-picking a model). The level-3 drill sets effort at selection time through the SAME settings pipeline the footer uses — do not create a second effort-write path.

## Files to read BEFORE writing code

- `harness-model-picker.tsx` (main orchestration), `harness-model-picker-state.ts` (reducer — add cascade state here), `harness-model-picker-panel.tsx`, `harness-model-picker-list.tsx`, `harness-model-picker-item.tsx`, `harness-model-picker-keyboard.ts`
- `clients/gui-app/src/components/home/data/harness-model-search.ts` — `HarnessModelRow.providerGroupId/providerGroupLabel`, `sectionModelRowsByProviderRank`, `filterModelRows`, `buildHarnessModelRows`
- `harness-model-picker-footers.tsx` + how the reasoning footer applies effort (the pipeline level 3 must reuse)
- `landing-options.ts` for `ModelOption` (`supportedReasoningEfforts`, `defaultReasoningEffort`)
- Existing picker tests under `components/home/pickers/__tests__/` — mirror their harness

## Implementation guidance

- **State (`harness-model-picker-state.ts`):** extend the reducer with `level: "subproviders" | "models" | "efforts"`, `activeGroupId: string | null`, `pendingEffortModel: HarnessModelRow | null`. Transitions: browse rail entry → resolve initial level (skip rules above); select subprovider → models; select model → efforts or complete; select effort → complete; back → up. Query non-empty forces `models` level display semantics (flat global results) WITHOUT destroying the saved level — clearing the query returns to the saved level.
- **Subprovider derivation:** pure helper in `harness-model-search.ts`, e.g. `buildSubproviderEntries(rows): ReadonlyArray<{ providerGroupId: string; providerGroupLabel: string; modelCount: number; capacityLabel: string | null }>` (order = first-seen group order, which the builder already rank-orders). Unit-test it.
- **Lists:** levels 1 and 3 are short — simple non-virtualized lists with the same row chrome (hover/active/selected, leader-key badges where the keyboard map already provides them). Reuse item styling from `harness-model-picker-item.tsx`; do not fork it — extract/compose.
- **Level 2** reuses the existing Virtuoso list; pass rows already filtered to the active group and suppress section headers for this level (flat list).
- **Keyboard (`harness-model-picker-keyboard.ts`):** add ArrowLeft = level up (when query empty); keep every existing binding working. Leader-digit behavior only needs to work on the models level (as today) — do not add leader keys to new levels unless trivially consistent.
- **Completion path:** model+effort selection must flow through the same apply pipeline today's row-select + reasoning footer use (trace `onSelect` in `harness-model-picker.tsx` and the footer's reasoning apply). One write path for effort.
- **a11y:** keep `role="listbox"`/option semantics per level; the level header is a button with an accessible name like "Back to subproviders".

## Tests

- State machine: level transitions incl. skip rules (0/1 group, profile-scoped rail entry), query-enter/query-clear restore, back navigation, reopen-at-current-selection.
- `buildSubproviderEntries`: grouping, counts, order, capacity label.
- Component: drill rail→subprovider→model→effort completes with the right payload; model without efforts completes at level 2; search select drills to effort when applicable; ArrowLeft/Escape-empty go up.
- Update any existing picker tests that assumed the flat-with-headers default.

## Verification (paste outputs in final report)

1. `bunx nx run traycer-clients-gui-app:compile`
2. `cd clients/gui-app && bunx vitest run src/components/home/pickers src/components/home/data`
3. `cd clients/gui-app && bunx vitest run` (full; the only acceptable failures are the 3 pre-existing `new-conversation-submit-gate` ones from the unrelated dirty working tree)
4. `git status -sb` proof unrelated dirty files untouched.

**Final report:** commits, files, verification outputs, deviations.
