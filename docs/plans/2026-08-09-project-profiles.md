# Project Profiles Implementation Plan

> **For agentic workers:** Execute this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax. Each task ends with a commit. Read the **Global Constraints** before writing any code — they override your defaults.

**Goal:** Add Hermes-style "Project Profiles" to the Thanos (Traycer fork) GUI: each profile = name + icon + color + one or more local workspace folders; when a profile is active, every list/composer/tab surface in the window is scoped to that profile so the user can never accidentally run an agent in the wrong project.

**Architecture:** 100% client-side in `clients/gui-app` (React renderer). No changes to `protocol/`, the closed-source host, the CLI, or the Electron shell. Epics/tasks are already tagged with workspace paths (`linkedWorkspaces` on history items); profiles are a filter/scope layer on top of existing data. State lives in Zustand persist stores following the repo's existing account-scoped persist pattern.

**Tech Stack:** React 19, TypeScript, Zustand (persist), TanStack Query + Router, Tailwind v4, shadcn/ui, lucide-react, Vitest + Testing Library, Bun workspaces + Nx.

**Locked product decisions (do not revisit):**
- **D1 — Membership:** an epic belongs to a profile if ANY of its `linkedWorkspaces[].workspacePath` paths sits under ANY of the profile's folders (path-segment-boundary prefix match, hostId-aware). Epics with zero linked workspaces are **unscoped**: they stay visible in every profile (fail-open — never hide user data).
- **D2 — Tabs on switch:** epic tabs positively known to belong to a different profile are **hidden** (not closed) while another profile is active; tabs whose membership is unknown stay visible (fail-open). Hidden tabs reappear when their profile is re-selected. The tab store is never mutated for this — filtering happens at the selector level.
- **D3 — Storage:** GUI persist only (localStorage via `src/lib/persist/keys.ts` builders, account-scoped bucket exactly like `composerRunSettingsKey`). No CLI store, no IPC bridge, no protocol work.
- **D4 — "All projects":** `activeProfileId === null` means the current unfiltered behavior (this is also the default, so existing users see zero change until they create a profile).
- **D5 — User-facing term:** "Project" (UI copy in English, matching the repo). Code namespace: `project-profiles` / `ProjectProfile`.

---

## Global Constraints

These come from the repo root `AGENTS.md`, `clients/gui-app/AGENTS.md`, and the fork's workflow. Read both AGENTS.md files before starting.

1. **Branch:** work on `feat/project-profiles` created from `main`. NEVER commit to `main`. NEVER push. NEVER open a PR.
2. **Dirty working tree:** the checkout has UNRELATED uncommitted fork customizations (e.g. `AGENTS.md`, `clients/desktop/src/config.ts`, `clients/desktop/src/electron-main/app/crash-reporter.ts`, `clients/desktop/src/electron-main/host/__tests__/host-paths.test.ts`, and others). Do not read, modify, stage, or commit them. Stage ONLY files you created/edited for this feature, by exact path. NEVER `git add -A`, `git add .`, or `git commit -a`.
3. **DCO:** every commit uses `git commit -s` (Signed-off-by trailer) with conventional messages matching the repo log, e.g. `feat(gui-app): add project profile stores`.
4. **Never run `tsc` directly.** Typecheck = `bunx nx run @traycer-clients/gui-app:compile` from the repo root.
5. **Do not hand-run repo-wide lint/format/compile before each commit** — the pre-commit hook runs affected checks. Final verification (Task 8) runs the scoped commands listed there.
6. **No optional parameters or properties (`?:`)** — banned repo-wide by ESLint (`no-restricted-syntax`). Write `fn(x: string | undefined)` and `group: string | undefined` (explicit union), never `fn(x?: string)` / `group?: string`. Same for interface properties. No rest-tuple optionals either.
7. **No `as any` / `as unknown` / chained casts.** Narrow or define a real type.
8. **`cn(...)` from `@/lib/utils`** for every composed `className`. No template literals / `.join(" ")` for classNames. Static single strings are OK.
9. **Fluid layout sizing** — `w-full`, `max-w-*`, viewport caps. No fixed px/rem for layout surfaces (icons / touch targets are OK).
10. **Zustand = client UI state; TanStack Query = host/server data.** Do not mix.
11. **shadcn composition:** compose `src/components/ui/` primitives (dialog, dropdown-menu, button, tooltip, input…). Check what exists in `src/components/ui/` before writing anything new. Prefer composition over editing ui primitives.
12. **Spinners:** `AgentSpinningDots` only.
13. **Scope of edits:** only `clients/gui-app/src/**` plus this plan file. Do not touch `protocol/`, `clients/shared/`, `clients/desktop/`, `clients/traycer-cli/`, or any test snapshots outside the feature.
14. **UI copy in English.** Feature label: "Projects" / "Project".
15. **Tests:** Vitest + Testing Library. Integrated tests with real stores over isolated units. Reset stores between tests (each store's initial state must be restorable — follow how existing store tests reset, e.g. `useWorkspaceFoldersStore` tests under `src/stores/workspace/__tests__/`).

---

## Feature Summary (what the user sees)

- A **project switcher** chip in the app header (left of the tab strip): colored icon + project name. Dropdown lists "All projects", then each project (icon in its color), then "New project…". Hovering a project row reveals an edit (pencil) button.
- **New/Edit project dialog**: name field, icon grid (curated set), color grid (curated set), folder list with Add (native folder picker via the existing `useWorkspaceFolderActions().pickAndPrepareFolders()`) and per-row remove. First folder is the primary. Delete lives inside the edit dialog behind an inline confirm.
- When a project is active:
  - The **history list / epics list / tray / command palette** only show epics whose linked workspaces fall under the project's folders (D1), plus unscoped epics.
  - The **composer workspace selector is locked**: folders forced to the project's folders, add/remove/primary-change controls hidden, replaced by a read-only chip showing the project icon + primary folder name.
  - A **thin accent bar** in the project's color sits at the top of the header, and the switcher chip shows the project's icon/color — constant visual anchor of "where am I".
  - Epic **tabs** belonging to other projects are hidden from the strip (D2).
  - Opening an epic that belongs to exactly one *other* project **auto-switches** the active project to it, with a toast: `Switched to project "<name>"`.

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `clients/gui-app/src/lib/profiles/types.ts` | `ProjectProfile`, `ProjectProfileFolder`, input/patch types |
| `clients/gui-app/src/lib/profiles/profile-membership.ts` | Pure membership functions (path prefix, hostId match, item visibility) |
| `clients/gui-app/src/lib/profiles/__tests__/profile-membership.test.ts` | Unit tests for membership |
| `clients/gui-app/src/lib/profiles/use-active-project-profile.ts` | Hook joining active id + registry → `ProjectProfile | null` |
| `clients/gui-app/src/stores/profiles/project-profiles-store.ts` | Registry store (CRUD), persisted |
| `clients/gui-app/src/stores/profiles/active-project-profile-store.ts` | Active profile id, persisted |
| `clients/gui-app/src/stores/profiles/__tests__/project-profiles-store.test.ts` | Store tests |
| `clients/gui-app/src/components/profiles/profile-options.ts` | Curated icon/color options + resolvers |
| `clients/gui-app/src/components/profiles/project-profile-badge.tsx` | Small icon+name chip (used by switcher, composer lock, dialog) |
| `clients/gui-app/src/components/profiles/project-profile-dialog.tsx` | Create/edit/delete dialog |
| `clients/gui-app/src/components/profiles/project-profile-switcher.tsx` | Header dropdown switcher |
| `clients/gui-app/src/components/profiles/__tests__/project-profile-switcher.test.tsx` | Switcher component test |
| `clients/gui-app/src/providers/profile-auto-switch-bridge.tsx` | Route watcher that auto-switches profile on cross-project epic open |
| `docs/plans/2026-08-09-project-profiles.md` | This plan (committed in Task 0) |

**Modify:**

| File | Change |
|---|---|
| `clients/gui-app/src/lib/persist/keys.ts` | Add `projectProfilesRegistryKey(email)` + `activeProjectProfileKey(email)` builders |
| `clients/gui-app/src/lib/persist/__tests__/keys.test.ts` | Assert the two new keys byte-for-byte |
| `clients/gui-app/src/hooks/home/use-history-query.ts` | Post-filter history items by active profile (client-side, after existing filters) |
| `clients/gui-app/src/components/layout/header/app-header.tsx` | Render switcher + accent bar (variant `app` only) |
| `clients/gui-app/src/components/home/host-workspace-selector/use-home-workspace-source.ts` | When profile active: override `folders`/`primaryPath` from profile, expose `profileLocked: true` |
| `clients/gui-app/src/components/home/host-workspace-selector/host-workspace-selector.tsx` | When `profileLocked`: hide add/remove/primary-change affordances, render the read-only badge |
| `clients/gui-app/src/stores/tabs/use-header-tabs.ts` | Filter epic tabs by active profile (fail-open on unknown membership) |
| `clients/gui-app/src/traycer-app.tsx` | Mount `ProfileAutoSwitchBridge` alongside the other lifecycle bridges |

---

### Task 0: Branch + plan commit

- [ ] **Step 1:** From repo root: `git checkout -b feat/project-profiles` (working tree keeps the unrelated dirty files — leave them alone).
- [ ] **Step 2:** Commit this plan file:
  ```bash
  git add docs/plans/2026-08-09-project-profiles.md
  git commit -s -m "docs(gui-app): project profiles implementation plan"
  ```

---

### Task 1: Types + membership logic (pure, fully tested)

**Files:**
- Create: `clients/gui-app/src/lib/profiles/types.ts`
- Create: `clients/gui-app/src/lib/profiles/profile-membership.ts`
- Create: `clients/gui-app/src/lib/profiles/__tests__/profile-membership.test.ts`
- Test: `cd clients/gui-app && bunx vitest run src/lib/profiles`

**Interfaces (Produces — later tasks rely on these exact shapes):**

`types.ts`:
```ts
export interface ProjectProfileFolder {
  /** Absolute path on the host that prepared it. */
  readonly path: string;
  /** Host that owns the path; null = legacy/unknown (match any host). */
  readonly hostId: string | null;
}

export interface ProjectProfile {
  readonly id: string; // crypto.randomUUID()
  readonly name: string;
  readonly icon: string; // id from PROFILE_ICONS (Task 4)
  readonly color: string; // id from PROFILE_COLORS (Task 4)
  readonly folders: ReadonlyArray<ProjectProfileFolder>; // length >= 1; [0] is primary
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewProjectProfileInput {
  readonly name: string;
  readonly icon: string;
  readonly color: string;
  readonly folders: ReadonlyArray<ProjectProfileFolder>;
}

export interface ProjectProfilePatch {
  readonly name: string | undefined;
  readonly icon: string | undefined;
  readonly color: string | undefined;
  readonly folders: ReadonlyArray<ProjectProfileFolder> | undefined;
}
```

`profile-membership.ts`:
```ts
import type { ProjectProfile, ProjectProfileFolder } from "./types";

/** Workspace-ref shape this module needs (structural — matches TaskWorkspaceIdentifier). */
export interface MembershipWorkspaceRef {
  readonly hostId: string;
  readonly workspacePath: string;
}

export function isPathUnderFolder(path: string, folderPath: string): boolean {
  if (path === folderPath) return true;
  const prefix = folderPath.endsWith("/") ? folderPath : folderPath + "/";
  return path.startsWith(prefix);
}

export function folderMatchesWorkspace(
  folder: ProjectProfileFolder,
  workspace: MembershipWorkspaceRef,
): boolean {
  if (folder.hostId !== null && folder.hostId !== workspace.hostId) return false;
  return isPathUnderFolder(workspace.workspacePath, folder.path);
}

/** D1: any linked workspace under any profile folder. */
export function profileOwnsWorkspaceRefs(
  profile: ProjectProfile,
  workspaces: ReadonlyArray<MembershipWorkspaceRef>,
): boolean {
  return workspaces.some((ws) =>
    profile.folders.some((folder) => folderMatchesWorkspace(folder, ws)),
  );
}

/**
 * Visibility rule for lists: unscoped items (no linked workspaces) are visible
 * in every profile (fail-open); scoped items must be owned by the profile.
 */
export function itemVisibleInProfile(
  profile: ProjectProfile,
  workspaces: ReadonlyArray<MembershipWorkspaceRef>,
): boolean {
  if (workspaces.length === 0) return true;
  return profileOwnsWorkspaceRefs(profile, workspaces);
}
```

- [ ] **Step 1: Write the failing test** — `__tests__/profile-membership.test.ts` covering:
  - `isPathUnderFolder`: exact match; child path; sibling with shared prefix is NOT a match (`/a/foo` vs `/a/foobar`); folder with trailing slash; `/` root folder matches everything.
  - `folderMatchesWorkspace`: hostId mismatch rejects; hostId null matches any host; hostId equal matches.
  - `profileOwnsWorkspaceRefs`: multi-folder profile; multi-workspace item; no match.
  - `itemVisibleInProfile`: empty workspaces → true; owned → true; foreign → false.
  Use a fixture profile: `{ id: "p1", name: "Acme", icon: "rocket", color: "blue", folders: [{ path: "/Users/x/Acme", hostId: "h1" }], createdAt: 0, updatedAt: 0 }`.
- [ ] **Step 2: Run** `cd clients/gui-app && bunx vitest run src/lib/profiles` — expect FAIL (module missing).
- [ ] **Step 3: Implement** both files exactly as specified above.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add clients/gui-app/src/lib/profiles
  git commit -s -m "feat(gui-app): project profile types and membership logic"
  ```

---

### Task 2: Persist keys + stores

**Files:**
- Modify: `clients/gui-app/src/lib/persist/keys.ts` (append builders at the end)
- Modify: `clients/gui-app/src/lib/persist/__tests__/keys.test.ts`
- Create: `clients/gui-app/src/stores/profiles/project-profiles-store.ts`
- Create: `clients/gui-app/src/stores/profiles/active-project-profile-store.ts`
- Create: `clients/gui-app/src/stores/profiles/__tests__/project-profiles-store.test.ts`

**Key builders (append to `keys.ts`, mirroring the existing scoped builders exactly):**
```ts
export const projectProfilesRegistryKey = (email: string | null): string =>
  scopedPersistKey("project-profiles", scopeBucket(email));

export const activeProjectProfileKey = (email: string | null): string =>
  scopedPersistKey("active-project-profile", scopeBucket(email));
```

**IMPORTANT — persist wiring pattern:** the account-scoped stores in this repo do NOT hardcode their key at store creation; they are re-keyed per signed-in identity by a persist-lifecycle bridge. Before writing the stores, READ these reference files and mirror their pattern EXACTLY (storage option, bridging, hydration on identity change):
- `clients/gui-app/src/providers/composer-run-settings-persist-lifecycle-bridge.tsx`
- the store it bridges (find via its imports, under `clients/gui-app/src/stores/composer/`)
- `clients/gui-app/src/lib/persist/index.ts` and `basePersistOptions`

Create the two stores with the same mechanism, plus two lifecycle bridges:
- `clients/gui-app/src/providers/project-profiles-persist-lifecycle-bridge.tsx`
- `clients/gui-app/src/providers/active-project-profile-persist-lifecycle-bridge.tsx`

(Mounting happens in Task 7's `traycer-app.tsx` edit.)

**Interfaces (Produces):**
```ts
// project-profiles-store.ts
export interface ProjectProfilesState {
  readonly profiles: ReadonlyArray<ProjectProfile>;
  readonly createProfile: (input: NewProjectProfileInput) => ProjectProfile;
  readonly updateProfile: (id: string, patch: ProjectProfilePatch) => void;
  readonly deleteProfile: (id: string) => void;
}
export const useProjectProfilesStore: UseBoundStore<...>; // zustand persist-wrapped

// active-project-profile-store.ts
export interface ActiveProjectProfileState {
  readonly activeProfileId: string | null; // null = "All projects"
  readonly setActiveProfile: (id: string | null) => void;
}
export const useActiveProjectProfileStore: UseBoundStore<...>;
```

Behavior details:
- `createProfile`: trims name; generates `crypto.randomUUID()`; stamps `createdAt`/`updatedAt` (Date.now()); appends; returns the created profile.
- `updateProfile`: applies only defined patch fields (each patch field is `T | undefined`; ignore `undefined`), bumps `updatedAt`. No-op for unknown id.
- `deleteProfile`: removes by id. Does NOT touch the active store here (the dialog handles resetting active → null when deleting the active project).
- Guard in `createProfile`/`updateProfile`: name must be non-empty after trim and folders length ≥ 1 — throw `Error("Project profile requires a name and at least one folder")` otherwise.

**Tests** (`project-profiles-store.test.ts`, follow existing store-test reset style):
- create → appears in `profiles`, fields stamped, returned object matches state entry.
- create with blank name or empty folders → throws.
- update → only provided fields change; `updatedAt` bumps; unknown id no-op.
- delete → removed.
- active store: default null; set/switch; set null.
- persist keys test additions in `keys.test.ts`: `projectProfilesRegistryKey("a@b.c") === "traycer-gui-app:project-profiles:a@b.c"`; `projectProfilesRegistryKey(null) === "traycer-gui-app:project-profiles:anon"`; same two assertions for `activeProjectProfileKey` → `traycer-gui-app:active-project-profile:*`.

- [ ] **Step 1:** failing tests for stores + keys. **Step 2:** run `cd clients/gui-app && bunx vitest run src/stores/profiles src/lib/persist` → FAIL. **Step 3:** implement. **Step 4:** re-run → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add clients/gui-app/src/lib/persist/keys.ts clients/gui-app/src/lib/persist/__tests__/keys.test.ts clients/gui-app/src/stores/profiles clients/gui-app/src/providers/project-profiles-persist-lifecycle-bridge.tsx clients/gui-app/src/providers/active-project-profile-persist-lifecycle-bridge.tsx
  git commit -s -m "feat(gui-app): project profile persist keys and stores"
  ```

---

### Task 3: useActiveProjectProfile hook + history filtering

**Files:**
- Create: `clients/gui-app/src/lib/profiles/use-active-project-profile.ts`
- Modify: `clients/gui-app/src/hooks/home/use-history-query.ts`
- Test: extend/create `clients/gui-app/src/hooks/home/__tests__/use-history-query.test.tsx` (follow the existing test file if present — integrated style, real stores)

**`use-active-project-profile.ts` (Produces):**
```ts
import { useProjectProfilesStore } from "@/stores/profiles/project-profiles-store";
import { useActiveProjectProfileStore } from "@/stores/profiles/active-project-profile-store";
import type { ProjectProfile } from "./types";

/** The active profile, or null for "All projects". Self-heals a dangling id. */
export function useActiveProjectProfile(): ProjectProfile | null {
  const activeId = useActiveProjectProfileStore((s) => s.activeProfileId);
  const profiles = useProjectProfilesStore((s) => s.profiles);
  const setActiveProfile = useActiveProjectProfileStore((s) => s.setActiveProfile);
  const profile = profiles.find((p) => p.id === activeId) ?? null;
  if (activeId !== null && profile === null) {
    // Profile was deleted under us — fall back to All projects (render-phase
    // setState into zustand is safe: it's an external store, not React state).
    setActiveProfile(null);
    return null;
  }
  return profile;
}
```

**History filtering (`use-history-query.ts`):** find where the final `HistoryItem[]` list is assembled (after `filterHistoryItems`, pinning, sorting). Wrap the returned items:

```ts
const activeProfile = useActiveProjectProfile();
// ... existing pipeline produces `items` ...
const visibleItems = useMemo(
  () =>
    activeProfile === null
      ? items
      : items.filter((item) =>
          itemVisibleInProfile(activeProfile, item.linkedWorkspaces),
        ),
  [items, activeProfile],
);
```

Rules:
- Client-side post-filter ONLY. Do NOT change the request builder, query keys, or pagination — the host query stays profile-unaware. (Consequence to preserve: `hasNextPage`/`fetchNextPage` keep working against the unfiltered pages; the filter narrows the rendered list. Acceptable for v1 — document in a code comment.)
- `item.linkedWorkspaces` is `ReadonlyArray<HistoryWorkspaceRef>` where `HistoryWorkspaceRef = TaskWorkspaceIdentifier = { hostId, workspacePath }` — structurally satisfies `MembershipWorkspaceRef`.
- This single hook feeds the home history, `/epics` list panel (`epics-list-panel.tsx`), the tray source (`use-tray-epics-source.ts`), and the command palette (`epics.source.ts`) — verify with `rg "useHistoryQuery" clients/gui-app/src` that all four pick up the filtered result through this hook's public return. If any consumer bypasses the hook and calls `filterHistoryItems` directly, apply the same profile filter there too.

**Test:** seed the profiles stores (two profiles + items owned/unscoped/foreign), render `useHistoryQuery` with the existing test harness, assert only owned+unscoped items surface when a profile is active, and everything surfaces when null.

- [ ] **Step 1:** failing test. **Step 2:** run it → FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add clients/gui-app/src/lib/profiles/use-active-project-profile.ts clients/gui-app/src/hooks/home
  git commit -s -m "feat(gui-app): filter history surfaces by active project profile"
  ```

---

### Task 4: Options + badge + dialog

**Files:**
- Create: `clients/gui-app/src/components/profiles/profile-options.ts`
- Create: `clients/gui-app/src/components/profiles/project-profile-badge.tsx`
- Create: `clients/gui-app/src/components/profiles/project-profile-dialog.tsx`
- Test: `clients/gui-app/src/components/profiles/__tests__/project-profile-dialog.test.tsx`

**`profile-options.ts` (Produces):**
```ts
import {
  Folder, Briefcase, Rocket, Store, ShoppingCart, CodeXml, GraduationCap,
  MessagesSquare, ChartColumn, Wrench, Globe, Package, Zap, BookOpen, Users, Star,
  type LucideIcon,
} from "lucide-react";

export const PROFILE_COLORS = [
  { id: "blue",   hex: "#3b82f6" },
  { id: "red",    hex: "#ef4444" },
  { id: "green",  hex: "#22c55e" },
  { id: "orange", hex: "#f97316" },
  { id: "purple", hex: "#a855f7" },
  { id: "pink",   hex: "#ec4899" },
  { id: "cyan",   hex: "#06b6d4" },
  { id: "yellow", hex: "#eab308" },
] as const;
export type ProfileColorId = (typeof PROFILE_COLORS)[number]["id"];
export function profileColorHex(id: string): string {
  return PROFILE_COLORS.find((c) => c.id === id)?.hex ?? PROFILE_COLORS[0].hex;
}

export const PROFILE_ICONS: ReadonlyArray<{ id: string; Icon: LucideIcon }> = [
  { id: "folder", Icon: Folder }, { id: "briefcase", Icon: Briefcase },
  { id: "rocket", Icon: Rocket }, { id: "store", Icon: Store },
  { id: "cart", Icon: ShoppingCart }, { id: "code", Icon: CodeXml },
  { id: "graduation", Icon: GraduationCap }, { id: "messages", Icon: MessagesSquare },
  { id: "chart", Icon: ChartColumn }, { id: "wrench", Icon: Wrench },
  { id: "globe", Icon: Globe }, { id: "package", Icon: Package },
  { id: "zap", Icon: Zap }, { id: "book", Icon: BookOpen },
  { id: "users", Icon: Users }, { id: "star", Icon: Star },
];
export function profileIcon(id: string): LucideIcon {
  return PROFILE_ICONS.find((i) => i.id === id)?.Icon ?? Folder;
}
```
(If any lucide export name above doesn't exist in the installed version, substitute the closest valid export and note it in the commit message — compile is the arbiter.)

**`project-profile-badge.tsx`:** small inline chip — icon tinted with the profile color + name, optional trailing slot. Props: `{ profile: ProjectProfile; className: string | undefined; trailing: ReactNode | undefined }`. Use `cn()`, no fixed layout widths.

**`project-profile-dialog.tsx`:** compose the repo's `ui/dialog`, `ui/button`, `ui/input` (check `src/components/ui/` for exact names first). Local React state only; store writes happen on submit.

- Props: `{ open: boolean; onOpenChange: (open: boolean) => void; editing: ProjectProfile | null }` — `editing === null` = create mode.
- Fields: name input; icon grid (16 buttons, selected = ring); color grid (8 swatches, selected = ring); folder rows (folder icon, path middle-ellipsized, remove `X` button) + "Add folder…" button.
- Folder add: call `useWorkspaceFolderActions().pickAndPrepareFolders()` (read `clients/gui-app/src/hooks/workspace/use-workspace-folder-actions.ts` and `clients/gui-app/src/components/open-folder-dialog.tsx` for the exact call shape and the `preparedWorkspaceFolderToWorkspaceFolderInfo` mapping) and append `{ path, hostId }` entries, deduped by path. First folder in the list is primary — label row 0 with a small "Primary" badge.
- Validation: submit disabled until `name.trim().length > 0 && folders.length >= 1`.
- Submit: create mode → `createProfile(...)` then `setActiveProfile(created.id)` (a freshly created project becomes active — that is the user's intent); edit mode → `updateProfile(editing.id, patch)`. Close dialog.
- Delete (edit mode only): a destructive "Delete project" button that flips to an inline confirm row ("Delete this project? Epics are not deleted." + Confirm/Cancel). Confirm → if deleting the active profile, `setActiveProfile(null)` first; then `deleteProfile(id)`; close.
- Defaults in create mode: icon `folder`, color `blue`.

**Dialog test:** renders create mode; submit disabled until name+folder; creating dispatches to the store and activates the profile; edit mode pre-fills; delete flow resets active id.

- [ ] **Steps:** failing test → implement → pass → commit:
  ```bash
  git add clients/gui-app/src/components/profiles
  git commit -s -m "feat(gui-app): project profile dialog, badge, and options"
  ```

---

### Task 5: Header switcher + accent bar

**Files:**
- Create: `clients/gui-app/src/components/profiles/project-profile-switcher.tsx`
- Create: `clients/gui-app/src/components/profiles/__tests__/project-profile-switcher.test.tsx`
- Modify: `clients/gui-app/src/components/layout/header/app-header.tsx`

**Switcher:** a dropdown (check `src/components/ui/` for `dropdown-menu` or `popover` — use what exists) anchored to a header button:
- Button content: active profile → its icon in profile color + name; no profile → `Layers`-style icon (pick a valid lucide export, e.g. `Layers`) + "All projects".
- Menu: "All projects" row (check icon when active) → separator → one row per profile (`ProjectProfileBadge`, check icon on active) with a hover-revealed pencil `IconButton` that opens `ProjectProfileDialog` in edit mode for that profile → separator → "New project…" row (opens dialog in create mode).
- Selecting a row calls `setActiveProfile(id | null)`.
- The dialog instance lives inside the switcher component (local state: `{ mode: "closed" } | { mode: "create" } | { mode: "edit"; profile: ProjectProfile }` — model it as a discriminated union, no optional props).

**`app-header.tsx` changes (variant `app` only, signed-in only — mirror the existing `isSignedIn` gate used for other header controls):**
1. Render `<ProjectProfileSwitcher />` immediately BEFORE `<TabStrip />` in the header row.
2. Accent bar: when `useActiveProjectProfile()` returns a profile, render
   ```tsx
   <div
     aria-hidden
     data-testid="profile-accent-bar"
     className="absolute inset-x-0 top-0 z-10 h-0.5"
     style={{ backgroundColor: profileColorHex(profile.color) }}
   />
   ```
   as the first child of the `<header>` element (the header is already `relative`). Read the profile via the hook inside `AppHeader`; do NOT thread props through parents.

**Switcher test:** with two profiles seeded, open dropdown, select one → active store updates; "All projects" → null; "New project…" opens the dialog.

- [ ] **Steps:** failing test → implement → pass → commit:
  ```bash
  git add clients/gui-app/src/components/profiles clients/gui-app/src/components/layout/header/app-header.tsx
  git commit -s -m "feat(gui-app): project switcher and profile accent bar in app header"
  ```

---

### Task 6: Composer workspace lock

**Files:**
- Modify: `clients/gui-app/src/components/home/host-workspace-selector/use-home-workspace-source.ts`
- Modify: `clients/gui-app/src/components/home/host-workspace-selector/host-workspace-selector.tsx`
- Test: `clients/gui-app/src/components/home/host-workspace-selector/__tests__/profile-locked-source.test.tsx` (new, integrated)

**Source lock (`use-home-workspace-source.ts`):**
- Add `profileLocked: boolean` to the `HomeWorkspaceSource` interface.
- Inside the hook: `const activeProfile = useActiveProjectProfile();`
- When `activeProfile !== null`: the returned `folders` becomes the profile's folder paths (memoized on `[activeProfile]`), `primaryPath` becomes the first profile folder path, `primaryWorkspacePath` resolves from those (use the same `resolvePrimaryPath` the file already uses), and `profileLocked` is `true`. The mutating functions stay intact — Task 6's UI change makes them unreachable — but add a dev-safety comment that profile-locked sources ignore external folder mutation.
- When null: today's behavior, `profileLocked: false`.
- Do not touch the landing-draft store, worktree staging, or any persist logic — this is a read-side override at the seam every picker consumer already uses.

**Selector UI (`host-workspace-selector.tsx` and its rows as needed):**
- When `profileLocked`: hide the add-folder affordance, per-row remove buttons, and primary-change control; render a single read-only row: `ProjectProfileBadge` + primary folder name. Use `cn()` conditionals; keep the unlocked path pixel-identical to today.
- If the locked UI is more naturally rendered as an early-return branch in the selector component, do that — but keep both branches in the same file.

**Test:** with an active profile (2 folders), the exposed `folders`/`primaryPath` come from the profile and the selector renders no add/remove controls; with null profile, current behavior unchanged.

- [ ] **Steps:** failing test → implement → pass → commit:
  ```bash
  git add clients/gui-app/src/components/home/host-workspace-selector
  git commit -s -m "feat(gui-app): lock composer workspace to active project profile"
  ```

---

### Task 7: Tab filtering + auto-switch bridge + provider mounts

**Files:**
- Modify: `clients/gui-app/src/stores/tabs/use-header-tabs.ts`
- Create: `clients/gui-app/src/providers/profile-auto-switch-bridge.tsx`
- Modify: `clients/gui-app/src/traycer-app.tsx`
- Test: `clients/gui-app/src/stores/tabs/__tests__/use-header-tabs-profile-filter.test.ts(x)` (new)

**Tab filtering (D2):**
- Read `use-header-tabs.ts`, `stores/tabs/types.ts`, and `stores/tabs/selectors.ts` first. Identify how an epic tab exposes its `epicId` (TabRef / source-refs).
- Build the membership lookup from the SAME data the history surfaces use: the `useHistoryQuery` result is cached through TanStack Query — in the header-tabs hook, consume `useHistoryQuery({ search: <default empty search state>, nowMs: null })` (check how `epics.source.ts` constructs a default `HistorySearchState` and reuse that exact construction) and build `Map<epicId, HistoryItem>`.
- Filter the derived tab list: keep non-epic tabs always; keep epic tabs whose item is missing from the map (unknown → fail-open); keep epic tabs where `itemVisibleInProfile(activeProfile, item.linkedWorkspaces)`; drop the rest. When `activeProfile === null`, return the list untouched.
- Do not mutate the tabs store, persistence, or layout repair — this is a display-level derivation. If the strip's drag/drop index math proves to depend on the unfiltered array (check `tab-split-commands.ts` / `layout.ts` call sites of the hook), filter inside the hook's returned value only and leave internal indexes as they are; add a code comment documenting the choice.

**Auto-switch bridge (`profile-auto-switch-bridge.tsx`):**
- A render-null provider component. Watch the router for epic routes: `useRouterState({ select: (s) => s.location.pathname })` and match `/epics/<epicId>/...` (check `routes/epics.$epicId.$tabId.tsx` for the canonical pattern and use TanStack Router's parsed params if a hook for the active epic id already exists — search `useParams` usage under `components/epic-canvas/`).
- Maintain a `useRef<Set<string>>` of epicIds already handled this session.
- When an epic id is seen for the first time: resolve its `HistoryItem` from the same history-query map; if `item` exists and `profileOwnsWorkspaceRefs` is true for exactly one profile in the registry and that profile is not active → `setActiveProfile(thatId)` + `toast.info(\`Switched to project "${profile.name}"\`)` (sonner is already mounted; import `toast` from the same module other components use). If it matches multiple profiles or none → no-op.
- Mount in `traycer-app.tsx` next to the other lifecycle bridges, INSIDE the authenticated/host-ready tree (place it adjacent to `EpicTabExistenceReconciler`), plus mount the two persist-lifecycle bridges from Task 2 next to their siblings (`ComposerRunSettingsPersistLifecycleBridge` etc.).

**Test (tab filter):** seed tabs store with epic tabs + system tabs, seed profiles + history query cache (or mock the history hook boundary the same way existing tabs tests fake externals), assert foreign epic tabs drop out when a profile is active, return when set to null, and unknown epic tabs stay.

- [ ] **Steps:** failing test → implement → pass → commit:
  ```bash
  git add clients/gui-app/src/stores/tabs clients/gui-app/src/providers/profile-auto-switch-bridge.tsx clients/gui-app/src/providers/project-profiles-persist-lifecycle-bridge.tsx clients/gui-app/src/providers/active-project-profile-persist-lifecycle-bridge.tsx clients/gui-app/src/traycer-app.tsx
  git commit -s -m "feat(gui-app): scope header tabs to active project and auto-switch on epic open"
  ```

---

### Task 8: Final verification + report

- [ ] **Step 1:** `bunx nx run @traycer-clients/gui-app:compile` — must exit 0.
- [ ] **Step 2:** `cd clients/gui-app && bunx vitest run` — full gui-app suite must pass. If pre-existing tests fail on a clean `main` checkout too, note them as pre-existing (verify with `git stash -u` + rerun ONLY if the failures touch files you changed — otherwise report as-is).
- [ ] **Step 3:** `cd clients/gui-app && npx -y react-doctor@latest . --verbose --diff main --offline --no-score` — fix any new findings attributable to this feature; report the rest.
- [ ] **Step 4:** `git log --oneline main..HEAD` and `git status -sb` — confirm: only `feat/project-profiles` commits; the pre-existing dirty files remain modified-uncommitted and untouched.
- [ ] **Step 5: Final report** — print: commits created, files created/modified, full output summaries of Steps 1–3, any deviations from this plan and why.

---

## Self-Review Notes (completed by the planner)

- **Spec coverage:** switcher ✓ (T5), dialog ✓ (T4), history/tray/palette filter ✓ (T3), composer lock ✓ (T6), accent bar ✓ (T5), tab hiding ✓ (T7), auto-switch ✓ (T7), delete semantics ✓ (T2/T4), unscoped fail-open ✓ (T1/T3).
- **Known v1 limits (documented, accepted):** pagination of history is profile-unaware (filter is render-side); staged worktree intents keyed to non-profile folders become inert while locked (they key by folder path and simply won't match); epics with no workspace link appear in every profile.
- **Type consistency:** `ProjectProfile`, `ProjectProfileFolder`, `NewProjectProfileInput`, `ProjectProfilePatch`, `MembershipWorkspaceRef`, `profileOwnsWorkspaceRefs`, `itemVisibleInProfile`, `useActiveProjectProfile`, `useProjectProfilesStore`, `useActiveProjectProfileStore`, `ProjectProfileBadge`, `ProjectProfileDialog`, `ProjectProfileSwitcher`, `profileColorHex`, `profileIcon`, `profileLocked` — same names everywhere.
