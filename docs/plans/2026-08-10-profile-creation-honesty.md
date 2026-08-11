# Profile Creation Honesty — G1 + G2 + G3 Implementation Plan

> **For agentic workers:** implement task-by-task, in order. Each task ends green (tests + compile) and committed. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the three profile-isolation gaps verified in the 2026-08-10 audit: (G1) the epic-creation composer does not inherit the active profile's folders, (G2) "All projects" home wastes the only aggregate surface (and unassigned epics accumulate), (G3) orchestration binding is global-only and the prelude visibly leaks into the first user bubble.

**Architecture:** Client-only (`clients/gui-app`). No protocol, host, or CLI changes. G1 = a provider bridge that syncs `activeProfile.folders` into the global composer workspace store on profile switch. G2 = a new aggregate home rendered on `/` when `activeProfileId === null`, with a quick-assign section for unassigned epics. G3 = a per-epic orchestration binding override store (same pattern as `composer-run-settings-store`) wired into the two create call sites, plus render-time stripping of the marked prelude and a fail-open toast.

**Tech Stack:** React 19, zustand (persist/localStorage), TanStack Router + Query, vitest + Testing Library, Nx (`bunx nx run traycer-clients-gui-app:compile`).

## Global Constraints

- Repo: `~/Documents/Workspaces/Thanos Traycer` (path has a space — always quote).
- Branch: `feat/profile-creation-honesty` (already created from `main` @ `b7d73d67`; NEVER switch branches mid-run).
- **NEVER** `git add -A` / `git add .` — stage only the exact paths of the current task.
- Commits: DCO via `git commit -s -F /tmp/<task-name>.txt` (message file, never `-m`). Repo-local identity is already configured.
- **NEVER** bare `tsc`. Typecheck = `export PATH="$HOME/.bun/bin:$PATH" && bunx nx run traycer-clients-gui-app:compile` from repo root. Single-file lint-hook TS2307/TS7006 errors on `@/` aliases are FALSE — ignore them.
- **No optional parameters** (`x?: T`, no default params). Use `x: T | undefined` or `| null` and pass explicitly at every call site.
- Tests: `export PATH="$HOME/.bun/bin:$PATH" && bunx vitest run <exact/path.test.ts[x]>` from `clients/gui-app`. Test files live in colocated `__tests__/` dirs; imports from there need `../module`, not `./module`. `TestRouterProvider` mounts children async — first assertion must be `findBy*`/`waitFor`, never sync `getBy*`.
- Code-over-plan: if real code diverges from this plan, follow the code and record the deviation in `docs/plans/2026-08-10-profile-creation-honesty.deviations.md` (create it; one bullet per deviation: what, why, task).
- Do not push. Do not touch files outside each task's file list.

## Verified facts this plan relies on (do not re-audit; do verify line numbers before editing)

- `stores/workspace/workspace-folders-store.ts` — global composer workspace store: `folders`, `primaryPath`, `folderInfoByPath`, actions `addResolvedFolders`, `removeFolder`, `setPrimaryPath`. `WorkspaceFolderInfo` (line 10) carries resolution metadata (repoIdentifier etc.). Persisted.
- `stores/profiles/active-project-profile-store.ts` — persisted `activeProfileId: string | null`; readable synchronously via `useActiveProjectProfileStore.getState()` (safe in router `beforeLoad`).
- `stores/profiles/project-profiles-store.ts` — `profiles`, and `assignEpicsToProfile(profileId, epicIds)` (exclusive, deduped, removes from other profiles) + `unassignEpic(epicId)`. `ProjectProfile = { id, name, icon, color, folders: ProjectProfileFolder[], assignedEpicIds, createdAtMs }`; `ProjectProfileFolder = { path, hostId: string | null, ... }`.
- `lib/profiles/profile-membership.ts` — `itemVisibleInProfile(profile, workspaces, epicId, allProfiles)`, `profileOwnsEpic`, `isPathUnderFolder`.
- `lib/profiles/use-active-project-profile.ts` — `useActiveProjectProfile(): ProjectProfile | null` (null = "All projects").
- `routes/index.tsx` — `/` route `beforeLoad` redirects to `/draft/new` when `!hasRestoredTabs()`; component renders `RootLandingPage`.
- `components/layout/root-landing-page.tsx` — signed-out → `AuthLandingPage`; signed-in → `<ProfileLaunchLanding/>` (renders null).
- `components/profiles/profile-launch-landing.tsx` (commit `b7d73d67`) — once-per-launch jump to most recent owned epic; empty-strip fallback navigates `/` → `/draft/new`. Currently the fallback ALSO fires when `activeProfile === null` (to be fixed in Task 4).
- `components/epic-canvas/sidebar/new-conversation-modal.tsx` — chat creation inside an existing epic; calls `maybeInjectOrchestrationPreludeAtCreate(content, traycerCli, null)` (~line 760).
- `components/home/hooks/use-landing-composer-actions.ts` — epic.create path; calls `maybeInjectOrchestrationPreludeAtCreate(...)` (~line 300).
- `lib/orchestration/inject-orchestration-prelude.ts` — `maybeInjectOrchestrationPreludeAtCreate(content, traycerCli, bindingOverride)`; `bindingOverride` param exists but every call site passes `null`; silent fail-open (catch → original content).
- `stores/orchestration/orchestration-binding-store.ts` — global binding `{ enabled, orchestrationName, roleId, modelGroup }` (DEFAULT enabled:true, `dev-team`, `orchestrator`).
- `lib/chat/orchestration-prelude.ts` — `stripOrchestrationPrelude(content: string): string` + markers `ORCHESTRATION_PRELUDE_START/END`. CLI already emits markers (`clients/traycer-cli/src/store/orchestration-store.ts:231,267`). Strip is NEVER imported by production render code (bug).
- `components/chat/chat-message-user-body.tsx` — user bubble; `message.content` (string) flows to `ChatUserMessageContent` (~line 335) and `messageText` (~line 150).
- `stores/composer/composer-run-settings-store.ts` (lines 17-21) — the per-epic persistence pattern to copy for G3 overrides.
- `components/home/data/home-page.data.ts:33` — `HistoryItem { id, epicId, taskType, title, initialUserPrompt, updatedAtMs, updatedLabel, updatedBucket, linkedWorkspaces, worktreeBranches, ownership, isPinned, ... }`.
- `hooks/home/use-history-query.ts` — `useHistoryQuery(params)` returns `{ items, membershipItems, ... }`; `items` is profile-filtered, `membershipItems` unfiltered.
- `stores/profiles/history-membership-cache-store.ts` — `itemsByEpicId: ReadonlyMap<string, HistoryItem>` warmed by the history query.
- Toast infra exists in the repo (upstream #1078 added toasts). Find the canonical hook with `grep -rn "useToast\|toast(" clients/gui-app/src/components --include="*.tsx" | head` and use that pattern.
- IPC orchestration surface (for the G3 picker): `useRunnerHost().traycerCli` exposes orchestration list/roles/model-groups methods already used by `settings/panels/orchestrations-settings-panel.tsx` and `settings/panels/model-group-editor.tsx` — reuse their TanStack Query hooks (`use-runner-traycer-*-query.ts` pattern).

---

## WS1 — G1: composer inherits the active profile's folders

### Task 1: pure resolver `profile-workspace-folders.ts`

**Files:**
- Create: `clients/gui-app/src/lib/profiles/profile-workspace-folders.ts`
- Test: `clients/gui-app/src/lib/profiles/__tests__/profile-workspace-folders.test.ts`

**Interfaces:**
- Consumes: `ProjectProfile`, `ProjectProfileFolder` from `@/lib/profiles/types`.
- Produces: `profileFoldersForHost(profile: ProjectProfile, activeHostId: string | null): ReadonlyArray<ProjectProfileFolder>` — folders of the profile usable on the active host: keep folder when `folder.hostId === null || folder.hostId === activeHostId`; stable order (profile.folders order). Also `profileHasUsableFolders(profile, activeHostId): boolean`.

- [ ] **Step 1: failing test** — cases: (a) null-hostId folder kept on any host; (b) matching hostId kept; (c) foreign hostId dropped; (d) mixed list keeps order; (e) empty folders → `profileHasUsableFolders` false.
- [ ] **Step 2: run** — `cd clients/gui-app && export PATH="$HOME/.bun/bin:$PATH" && bunx vitest run src/lib/profiles/__tests__/profile-workspace-folders.test.ts` → FAIL (module missing).
- [ ] **Step 3: implement** the two pure functions (no React, no stores).
- [ ] **Step 4: run** → PASS.
- [ ] **Step 5: commit** `feat(gui-app): resolve profile folders usable on the active host` (stage the 2 files).

### Task 2: `replaceResolvedFolders` action on the workspace store

**Files:**
- Modify: `clients/gui-app/src/stores/workspace/workspace-folders-store.ts`
- Test: `clients/gui-app/src/stores/workspace/__tests__/workspace-folders-store.test.ts` (create if absent — check first)

**Interfaces:**
- Produces: new store action `replaceResolvedFolders(folders: ReadonlyArray<WorkspaceFolderInfo>): void` — replaces `folders` + `folderInfoByPath` wholesale, sets `primaryPath` to `resolvePrimaryPath(nextPaths, null)` (i.e. first folder). Existing actions unchanged. No persist-schema change (same shape, new writer).

- [ ] **Step 1: failing test** — replace swaps the set, drops stale info entries, primary becomes first path; replace with `[]` clears and primary → null.
- [ ] **Step 2-4:** fail → implement → pass.
- [ ] **Step 5: commit** `feat(gui-app): wholesale folder replacement on the composer workspace store`.

### Task 3: `ProfileWorkspaceFoldersBridge` provider

**Files:**
- Create: `clients/gui-app/src/providers/profile-workspace-folders-bridge.tsx`
- Test: `clients/gui-app/src/providers/__tests__/profile-workspace-folders-bridge.test.tsx`
- Modify: the provider composition root where `ProfileTabWorkspaceBridge` is mounted (find with `grep -rn "ProfileTabWorkspaceBridge" clients/gui-app/src --include="*.tsx" | grep -v test`) — mount the new bridge next to it.

**Interfaces:**
- Consumes: Task 1's `profileFoldersForHost`; `useActiveProjectProfile()`; `useReactiveActiveHostId()` (`@/hooks/host/use-reactive-active-host-id`); folder resolution via the existing resolved-folders query (find the exact hook in `hooks/workspace/use-resolved-workspace-folders-query.ts` — it maps paths → `WorkspaceFolderInfo`; reuse it, do not reimplement); `useWorkspaceFoldersStore` Task 2 action.
- Produces: `<ProfileWorkspaceFoldersBridge/>` — renders null. Effect keyed on `[activeProfile?.id, activeHostId, resolvedInfoReady]`: when `activeProfile !== null` AND `profileHasUsableFolders(...)` AND resolution for those paths is ready → `replaceResolvedFolders(resolvedInfos)`. When profile is null or has no usable folders → no-op (keep last-used; "All projects" is a neutral surface). Must NOT re-apply while the id/host inputs are unchanged (user may hand-edit folders within the same profile session — the store is the user's surface between switches).

- [ ] **Step 1: failing test** — render bridge with a mocked active profile (2 folders, one foreign-host) → store receives only the usable folder(s), primary = first; switch to null profile → store untouched; switch to folderless profile → untouched; same-profile re-render with user-edited store → untouched.
- [ ] **Step 2-4:** fail → implement → pass. Mock the resolution query hook, not the network.
- [ ] **Step 5: wire** into the provider root (1-line mount).
- [ ] **Step 6: compile** — `bunx nx run traycer-clients-gui-app:compile` → clean.
- [ ] **Step 7: commit** `feat(gui-app): sync active profile folders into the composer workspace on profile switch` (stage the 3 files).

---

## WS2 — G2: "All projects" aggregate home + unassigned rescue

### Task 4: home redirect guards profile-null + launch-landing fallback guard

**Files:**
- Modify: `clients/gui-app/src/routes/index.tsx` (beforeLoad)
- Modify: `clients/gui-app/src/components/profiles/profile-launch-landing.tsx` (fallback guard)
- Modify: `clients/gui-app/src/components/profiles/__tests__/profile-launch-landing.test.tsx`
- Test (route): create `clients/gui-app/src/routes/__tests__/index-route.test.ts` ONLY if an existing route-test pattern exists to copy (check `src/routes/__tests__/`); otherwise extract the decision to `lib/profiles/home-route-decision.ts` pure function and test that.

**Interfaces:**
- Produces: `shouldRedirectHomeToDraft(hasRestoredTabs: boolean, activeProfileId: string | null): boolean` = `!hasRestoredTabs && activeProfileId !== null`. Route `beforeLoad` uses it with `useActiveProjectProfileStore.getState().activeProfileId`.
- `ProfileLaunchLanding` fallback gains `if (activeProfile === null) return;` before the draft navigate (All-projects now OWNS `/`; never bounce to a draft). Launch-jump block already no-ops on null.

- [ ] **Step 1: failing tests** — decision table (restored/null-profile → false; empty/profile → true; empty/null → false; restored/profile → false) + launch-landing: with null profile, empty strip, pathname `/` → NO navigate (assert `mockNavigate` not called).
- [ ] **Step 2-4:** fail → implement → pass.
- [ ] **Step 5: commit** `feat(gui-app): All projects keeps the home route; launch fallback skips the null profile`.

### Task 5: `AllProjectsHome` component

**Files:**
- Create: `clients/gui-app/src/components/profiles/all-projects-home.tsx`
- Create: `clients/gui-app/src/components/profiles/all-projects-home-sections.tsx` (profile card + unassigned row presentational pieces — keep the main file under ~250 lines)
- Test: `clients/gui-app/src/components/profiles/__tests__/all-projects-home.test.tsx`

**Interfaces:**
- Consumes: `useProjectProfilesStore` (profiles + `assignEpicsToProfile`); `useHistoryQuery` (reuse the exact params shape the home page uses — find its call site under `components/home/` and mirror it with `search.query: ""`); `useHistoryMembershipCacheStore` optional fast path; `itemVisibleInProfile`/`profileOwnsEpic` from membership; `activateTabIntent` + `useNavigate` for epic open (copy the intent-building from `lib/profiles/profile-landing.ts` usage in `profile-launch-landing.tsx`); `profileIcon`/`profileColorHex` helpers from `project-profile-switcher.tsx` (export them if currently module-private).
- Produces: `<AllProjectsHome/>`:
  1. Header: `Layers` icon + "All projects" + subheading count line (`{n} projects · {m} unassigned`).
  2. One card per profile (sorted by most recent owned activity): icon/color chip, name, up to 5 most-recent owned epics (`itemVisibleInProfile` against that profile; sort `updatedAtMs` desc) each showing `epicDisplayTitle`-equivalent label + `updatedLabel`; click → open that epic via `activateTabIntent` (auto-switch lands the user in the profile — existing behavior, do not reimplement). Empty owned list → "No epics yet" muted line.
  3. **Unassigned section**: epics assigned to NO profile (`!allProfiles.some(p => p.assignedEpicIds.includes(epicId))`), sorted recent-first, capped at 10 with a "show more" expander. Each row: title, `updatedLabel`, and an "Assign to…" dropdown listing profiles → `assignEpicsToProfile(profileId, [epicId])` (row disappears on next render because the predicate excludes it — no local state games).
  4. Footer action: primary button "New chat" → `navigate({ to: "/draft/new" })`.
  5. Empty state (zero profiles): hero copy "Create a project profile to keep workspaces, tabs and chats separate" + button opening the existing profile dialog (reuse `ProjectProfileDialog` from the switcher in create mode).
- Styling: follow the existing home/landing surfaces (Tailwind classes already used in `components/home/`); no new theme tokens.

- [ ] **Step 1: failing test** — with 2 profiles (one owning epic A via folder match, one owning epic B via assignment) + 1 unassigned epic C: cards render A under its profile and B under its own; C appears in Unassigned; clicking C's assign → store called with (profileId, [C]); card epic click → `activateTabIntent` path (mock navigate); zero profiles → empty state; "New chat" → `/draft/new` navigate.
- [ ] **Step 2-4:** fail → implement → pass.
- [ ] **Step 5: commit** `feat(gui-app): aggregate All projects home with per-profile cards and unassigned rescue`.

### Task 6: wire `RootLandingPage`

**Files:**
- Modify: `clients/gui-app/src/components/layout/root-landing-page.tsx`
- Test: extend/create `clients/gui-app/src/components/layout/__tests__/root-landing-page.test.tsx`

**Interfaces:**
- signed-out → `AuthLandingPage` (unchanged); signed-in + `useActiveProjectProfile() === null` → `<AllProjectsHome/>`; signed-in + profile → `<ProfileLaunchLanding/>` (unchanged).

- [ ] **Step 1-4:** failing test (three branches) → implement → pass.
- [ ] **Step 5: compile** clean.
- [ ] **Step 6: commit** `feat(gui-app): render the aggregate home on / for All projects`.

---

## WS3 — G3: orchestration per-epic override + prelude display fix + honest failure

### Task 7: per-epic override store + effective resolver

**Files:**
- Create: `clients/gui-app/src/stores/orchestration/orchestration-epic-overrides-store.ts`
- Create: `clients/gui-app/src/lib/orchestration/effective-orchestration-binding.ts`
- Tests: `clients/gui-app/src/stores/orchestration/__tests__/orchestration-epic-overrides-store.test.ts`, `clients/gui-app/src/lib/orchestration/__tests__/effective-orchestration-binding.test.ts`

**Interfaces:**
- Store (copy the persistence pattern of `composer-run-settings-store.ts:17-21`): `overridesByEpicId: Readonly<Record<string, OrchestrationBinding>>`, `setEpicOverride(epicId: string, binding: OrchestrationBinding): void`, `clearEpicOverride(epicId: string): void`, `resetForTests(): void`. Persist key via `basePersistOptions(...)` following sibling stores in `stores/orchestration/`.
- Produces: `effectiveOrchestrationBinding(epicId: string | null): OrchestrationBinding` — `epicId !== null` and override present → override; else `useOrchestrationBindingStore.getState().binding`. (v1 scope: `epic.create` from the landing composer passes `epicId: null` → global binding; per-epic overrides apply to chats created INSIDE an existing epic. Record this as a deliberate scope note in the file header comment.)

- [ ] **Step 1-4:** failing tests (set/clear/override-wins/global-fallback/null-epic) → implement → pass.
- [ ] **Step 5: commit** `feat(gui-app): per-epic orchestration binding overrides with global fallback`.

### Task 8: wire the create call sites

**Files:**
- Modify: `clients/gui-app/src/components/epic-canvas/sidebar/new-conversation-modal.tsx` (~line 760 call)
- Modify: `clients/gui-app/src/components/home/hooks/use-landing-composer-actions.ts` (~line 300 call)
- Tests: extend the modal's existing submit-gate test (`new-conversation-submit-gate.test.tsx` — the file notes at ~328-330 it only counts createChat; ADD assertion on injected content) and the landing actions' existing test file (find via `grep -rln "use-landing-composer-actions" clients/gui-app/src --include="*.test.*"`)

**Interfaces:**
- Modal: resolve the target epic id (the modal's `epicId` prop) → pass `effectiveOrchestrationBinding(epicId)` as `bindingOverride`.
- Landing actions: pass `effectiveOrchestrationBinding(null)` (explicit global; keeps signature non-optional).

- [ ] **Step 1: failing tests** — modal with a per-epic override `{ orchestrationName: "x", roleId: "y", enabled: true, modelGroup: "cheap" }` → `traycerCli.orchestrationPrelude` called with `{ name: "x", roleId: "y", group: "cheap" }` (mock IPC) and createChat initialMessage contains the marked prelude; without override → global binding used. Landing path → global binding call.
- [ ] **Step 2-4:** fail → implement → pass.
- [ ] **Step 5: compile** clean.
- [ ] **Step 6: commit** `feat(gui-app): create-time orchestration injection honors per-epic overrides`.

### Task 9: strip the prelude at render

**Files:**
- Modify: `clients/gui-app/src/components/chat/chat-message-user-body.tsx`
- Test: create/extend `clients/gui-app/src/components/chat/__tests__/chat-message-user-body.test.tsx`

**Interfaces:**
- Apply `stripOrchestrationPrelude` to the string content paths feeding the bubble (`message.content` → `ChatUserMessageContent` and the `messageText` prop) via `useMemo`. Presentation-only: never mutate the stored message. Structured-content path (`message.structuredContent`) — if it is a `JsonContent` doc, leave untouched UNLESS the prelude markers appear inside its text nodes; v1 strips only the string path (the injected prelude is plain paragraphs prepended into the composer doc; verify at runtime which path carries it and strip that one — record the finding in the deviations file).

- [ ] **Step 1: failing test** — message whose content is `<prelude markers>role text</end>\n\nreal question` renders "real question" and NOT "role text"; message without markers renders unchanged; prelude-only message renders unchanged (fail-open rule of the strip).
- [ ] **Step 2-4:** fail → implement → pass.
- [ ] **Step 5: commit** `fix(gui-app): hide the injected orchestration prelude from the user bubble`.

### Task 10: honest failure toast on injection fail-open

**Files:**
- Modify: `clients/gui-app/src/lib/orchestration/inject-orchestration-prelude.ts`
- Modify: both call sites from Task 8 (pass the callback)
- Test: extend `clients/gui-app/src/lib/orchestration/__tests__/inject-orchestration-prelude.test.ts` (create if absent)

**Interfaces:**
- New signature (no optional params): `maybeInjectOrchestrationPreludeAtCreate(content: JsonContent, traycerCli: ITraycerCli | null, bindingOverride: OrchestrationBinding | null, onFailure: ((reason: OrchestrationInjectionFailure) => void) | null): Promise<JsonContent>` where `OrchestrationInjectionFailure = { readonly kind: "cli-unavailable" | "prelude-error" | "empty-prelude"; readonly orchestrationName: string; readonly roleId: string }`. Fire `onFailure` ONLY when binding was enabled and injection was attempted but produced no prelude (cli null → `cli-unavailable`; catch → `prelude-error`; null/empty prelude → `empty-prelude`). Binding disabled/incomplete → no callback (not a failure).
- Call sites: pass a callback that raises the repo's standard warning toast: "Orchestration context unavailable — chat created without it." (Find the canonical toast hook; mirror an existing warning toast.) Create proceeds regardless (fail-open preserved).

- [ ] **Step 1: failing tests** — each failure kind invokes the callback once with the right kind; success path does not; disabled binding does not.
- [ ] **Step 2-4:** fail → implement → pass (both call sites updated, toast asserted via mock in the modal test).
- [ ] **Step 5: compile** clean.
- [ ] **Step 6: commit** `feat(gui-app): warn when orchestration injection fails open at create`.

### Task 11: composer orchestration chip + modal picker

**Files:**
- Create: `clients/gui-app/src/components/orchestration/orchestration-binding-chip.tsx`
- Create: `clients/gui-app/src/components/orchestration/orchestration-binding-popover.tsx`
- Modify: `clients/gui-app/src/components/epic-canvas/sidebar/new-conversation-modal.tsx` (mount chip+popover in its toolbar row, next to existing run-settings controls)
- Test: `clients/gui-app/src/components/orchestration/__tests__/orchestration-binding-chip.test.tsx`

**Interfaces:**
- Consumes: orchestration/roles/model-groups query hooks already used by `settings/panels/orchestrations-settings-panel.tsx` + `settings/panels/model-group-editor.tsx` (reuse, do not refetch differently); `effectiveOrchestrationBinding`; Task 7 store actions.
- `<OrchestrationBindingChip epicId: string | null/>` — when effective binding `enabled` and names non-empty: compact chip `🎭 {orchestrationName} · {roleId} · {modelGroup ?? "default"}`; click opens popover. When disabled: muted chip "Orchestration off".
- `<OrchestrationBindingPopover epicId: string/>` — three dropdowns (orchestration, role of selected orchestration, model group) + enabled toggle + "Reset to global" button (clears the epic override). Changing any value writes `setEpicOverride(epicId, next)` immediately (the create reads it via Task 8). Dirty-state indicator when an override exists (dot on the chip).
- v1 mounts ONLY in the new-conversation modal (per-epic create). Landing/epic.create stays global (scope note from Task 7). Do not mount in the chat composer (injection is create-time only).

- [ ] **Step 1: failing test** — chip renders effective binding; popover change → store override written; "Reset to global" → override cleared, chip reflects global; disabled global + no override → "Orchestration off" and popover toggle enables an override.
- [ ] **Step 2-4:** fail → implement → pass.
- [ ] **Step 5: compile** clean.
- [ ] **Step 6: commit** `feat(gui-app): per-epic orchestration picker in the new-conversation modal`.

---

## Final verification (last task, no commit until green)

- [ ] `export PATH="$HOME/.bun/bin:$PATH" && bunx nx run traycer-clients-gui-app:compile --skip-nx-cache` → clean.
- [ ] Full affected-area sweep: `cd clients/gui-app && bunx vitest run src/lib/profiles src/providers/__tests__/profile-workspace-folders-bridge.test.tsx src/components/profiles src/components/layout src/stores/workspace src/stores/orchestration src/lib/orchestration src/components/orchestration src/components/chat/__tests__/chat-message-user-body.test.tsx src/components/epic-canvas/sidebar` → all green (note and investigate any pre-existing failures on `main`; do not fix unrelated flakes — list them in the deviations file).
- [ ] Update the deviations file with anything that diverged.
