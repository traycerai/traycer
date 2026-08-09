# Project Profiles — Per-Profile Tab Workspaces (Addendum)

> **For agentic workers:** Execute task-by-task. Read the Global Constraints in `docs/plans/2026-08-09-project-profiles.md` FIRST — they all apply here unchanged (branch `feat/project-profiles`, DCO `git commit -s`, stage only exact feature paths, never `git add -A`, never push, no optional `?:` params, `cn()` for classNames, never bare `tsc` — typecheck via `bunx nx run traycer-clients-gui-app:compile`). Read repo-root `AGENTS.md` + `clients/gui-app/AGENTS.md` before coding.

**Goal:** Each project profile owns its ENTIRE tab strip. Switching profiles swaps the visible tab set completely — zero tab sharing between profiles. "Everything on screen belongs to the active profile."

**Context (already shipped on this branch):** project profiles (registry store `stores/profiles/project-profiles-store.ts`, active store `stores/profiles/active-project-profile-store.ts`), membership logic (`lib/profiles/profile-membership.ts`), history filtering, composer lock, header switcher, accent bar, auto-switch bridge, launch landing, and a **display-level** tab filter in `stores/tabs/use-header-tabs.ts` (D2: foreign epic tabs hidden, fail-open on unknown). That filter stays as a safety net; this addendum replaces the user-visible behavior with true per-profile tab workspaces.

**Current behavior (wrong for the user):** switching profiles keeps the same tabs on screen — non-epic tabs and fail-open epic tabs leak across profiles.

---

## Behavior spec (acceptance criteria)

1. Every profile id owns a tab-strip snapshot; the special bucket `"all-projects"` owns the strip for `activeProfileId === null`.
2. On profile switch A→B: the current strip is saved under bucket A, then bucket B's snapshot is restored (or a fresh empty strip if B has none). After the switch, NOTHING from A's strip is visible.
3. The active bucket is written through continuously (debounced) while the app runs — a crash must not lose more than the debounce window of tab changes.
4. Deleting a profile deletes its bucket.
5. Restoring a snapshot whose epic/draft refs no longer resolve must heal via the EXISTING reconciliation machinery (`EpicTabExistenceReconciler`, layout `repairLayout`, navigation controller) — never crash, never wedge the strip.
6. First launch after this lands: whatever strip exists belongs to whatever bucket is active at that moment (default `"all-projects"`). No data migration beyond that.
7. Multi-window: buckets are global, last-writer-wins. Add a code comment documenting this v1 limitation.
8. System tabs (history/settings) travel with the strip — they are part of the snapshot (they already live inside `PersistedTabStripLayout.systemTabs`).

## Files to read BEFORE writing code

- `clients/gui-app/src/stores/tabs/store.ts` — `readTabStripLayout()` (exported reader), `replaceLayoutForTransaction` / `finalizeTransactionLayout` (coordinator-only write path), persist config (`TABS_PERSIST_KEY`, `migrateTabsPersistedState`).
- `clients/gui-app/src/stores/tabs/desktop-tabs-persistence.ts` — how per-window snapshots are saved/restored today (the precedent for restoring a layout into the live store, incl. hydration ordering).
- `clients/gui-app/src/stores/tabs/tab-command-coordinator.ts` — the sanctioned transaction API for structural layout replacement.
- `clients/gui-app/src/providers/epic-tab-existence-reconciler.tsx` — how stale epic refs heal after restore.
- `clients/gui-app/src/providers/windows-bridge-provider.tsx` — hydration gate (`hasRestoredTabs()` in `lib/has-restored-tabs.ts`).
- `clients/gui-app/src/lib/persist/keys.ts` + `lib/persist/zustand-persist-lifecycle.ts` — account-scoped persist pattern used by the profile stores.

## Implementation guidance

**New store** `clients/gui-app/src/stores/profiles/profile-tab-workspaces-store.ts` (zustand + persist, account-scoped key builder `profileTabWorkspacesKey(email)` in `lib/persist/keys.ts` + byte-exact assertions in `keys.test.ts`, mirroring the existing builders):

```ts
export interface ProfileTabWorkspacesState {
  /** bucketKey = profile id, or "all-projects" for the null profile. */
  readonly layoutsByBucket: Readonly<Record<string, PersistedTabStripLayout>>;
  readonly saveLayout: (bucket: string, layout: PersistedTabStripLayout) => void;
  readonly dropBucket: (bucket: string) => void;
  readonly resetForTests: () => void;
}
export function profileTabBucket(profileId: string | null): string; // "all-projects" for null
```

**Swap bridge** `clients/gui-app/src/providers/profile-tab-workspace-bridge.tsx` (render-null, mounted in `traycer-app.tsx` next to `ProfileAutoSwitchBridge`):

- Subscribe to `useActiveProjectProfileStore` (zustand `subscribe`, not React — the swap must be atomic and effect-order-safe).
- On change prev→next:
  1. If tabs have not hydrated yet (`hasRestoredTabs()`), DEFER: re-check on the windows-bridge hydration signal used by `desktop-tabs-persistence.ts` (read how it waits; use the same one). Never swap against a pre-hydration strip — that would snapshot an empty strip over the user's real bucket.
  2. Save `readTabStripLayout()` under `profileTabBucket(prev)`.
  3. Restore next bucket: `useProfileTabWorkspacesStore.getState().layoutsByBucket[profileTabBucket(next)]` → apply via the coordinator's transaction API (the same write path `desktop-tabs-persistence` uses to restore — do NOT call reducer internals ad hoc); absent snapshot → apply `emptyTabStripLayout()` (from `stores/tabs/layout.ts`).
- Write-through: subscribe to `useTabsStore` layout fields (the same selector `desktop-tabs-persistence` persists on) and save under the ACTIVE bucket, debounced (reuse their `DEBOUNCE_MS = 100` convention). Start only after hydration.
- Profile deletion: the dialog already calls `deleteProfile`; also call `dropBucket` there (edit `components/profiles/project-profile-dialog.tsx`).
- Restore healing: rely on existing reconcilers. If you find restore requires an explicit nudge (e.g. `EpicTabExistenceReconciler` only reacts to route changes), look at what `desktop-tabs-persistence` triggers after a restore and do the same.

**Keep** the `use-header-tabs.ts` display filter untouched (safety net for any ref that leaks across).

**Do NOT touch:** `desktop-tabs-persistence.ts` behavior for window snapshots, the windows bridge, protocol/shared/desktop packages, or the persist migration functions. If a conflict between per-window restore and bucket restore appears, prefer NOT breaking window restore and record the deviation in your final report.

## Tests (integrated style, real stores — follow `src/stores/tabs/__tests__/` and the profiles tests)

New `clients/gui-app/src/stores/tabs/__tests__/profile-tab-workspaces.test.ts(x)`:
- switch A→B saves A's strip and restores B's; switching back re-applies A's (round-trip).
- B with no bucket → empty strip after switch.
- write-through: layout change while active → bucket updated (after debounce; use the repo's fake-timer pattern if the debounce needs it).
- `dropBucket` on profile delete.
- restoring a snapshot with an unknown epic ref heals (no throw; ref dropped by reconciliation).
- hydration gate: switching before `hasRestoredTabs()` does not clobber buckets.

Update existing tests if the swap bridge changes their assumptions (run the full `src/stores/tabs` + `src/components/profiles` + `src/components/layout` suites).

## Verification (all must pass, paste outputs in final report)

1. `bunx nx run traycer-clients-gui-app:compile`
2. `cd clients/gui-app && bunx vitest run src/stores/tabs src/components/profiles src/lib/profiles src/components/layout __tests__/traycer-app.test.tsx`
3. `cd clients/gui-app && bunx vitest run` (full suite; pre-existing `new-conversation-submit-gate` failures trace to an unrelated dirty working-tree file — not yours; verify before claiming)
4. `git status -sb` proof that unrelated dirty files were never staged.

**Final report:** commits, files, verification outputs, deviations.
