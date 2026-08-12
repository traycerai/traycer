# Thanos Hide Account Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide Traycer account/collaboration chrome in the Thanos single-user fork without deleting upstream components, so daily dogfood no longer shows billing, sharing, cloud notifications, or subscription CTAs.

**Architecture:** One renderer helper `isThanosSingleUserChrome()` in `clients/gui-app/src/lib/thanos-flags.ts` (same pattern as `isProductIntroDisabled()`: false in unit tests, true otherwise). Gate **mount points only**. Do not delete `UserMenu`, `SharingPanel`, `NotificationsBell`, or mutate `SETTINGS_SECTIONS` order (leader-digit shortcuts are load-bearing). Keep the avatar menu because it is the only header entry to App Settings and Sign out. Keep `AuthLandingPage` Sign in — the app still needs a Traycer cloud session (see the no-login plan).

**Tech Stack:** React, Zustand, Vitest, existing `thanos-flags.ts`.

## Global Constraints

- Hide, do not delete. Upstream merges must stay mechanical.
- `import.meta.env.MODE === "test"` → helper returns `false` so existing suites keep seeing chrome.
- Provide `__setThanosSingleUserChromeForTests(value)` so new tests can assert the hidden path.
- Do not add a catch-all `"VITE_"` prefix to `clients/desktop/vite.renderer.config.ts` (updater secrets).
- Do not change `SETTINGS_SECTIONS` ids or array order.
- Do not skip `AuthLandingPage`. Login still exists; this plan is chrome only.
- Keep `RateLimitIconButton` for host/provider gauges; omit only the synthetic Traycer subscription tab.

---

## File map

| File | Role |
|---|---|
| `clients/gui-app/src/lib/thanos-flags.ts` | Flag + test override + settings-section predicate |
| `clients/gui-app/src/lib/__tests__/thanos-flags.test.ts` | Truth table |
| `clients/gui-app/src/components/layout/header/app-header.tsx` | Hide notifications bell |
| `clients/gui-app/src/components/auth/user-menu.tsx` | Hide Manage subscription |
| `clients/gui-app/src/components/settings/settings-sidebar.tsx` | Skip Account group |
| `clients/gui-app/src/components/settings/settings-modal-content.tsx` | `devices`/`usage` fall back to General |
| `clients/gui-app/src/lib/commands/sources/navigation.source.ts` | Palette omits Sessions/Usage |
| `clients/gui-app/src/components/epic-canvas/sidebar/left-panel-registry.ts` | Sharing not auto-visible |
| `clients/gui-app/src/components/settings/panels/traycer-subscription-section.tsx` | Return null |
| `clients/gui-app/src/components/layout/header/host-picker.tsx` | Hide remote-host Upgrade notice |
| `clients/gui-app/src/components/settings/host-scope/host-scope-gate.tsx` | Hide Upgrade plan button |
| `clients/gui-app/src/components/settings/panels/general-settings-panel.tsx` | Hide Data migration row |
| `clients/gui-app/src/components/layout/header/rate-limit-popover.tsx` | Omit Traycer rail tab |
| `clients/gui-app/src/components/settings/__tests__/settings-sidebar.test.tsx` | Assert Account group hidden when override is on |
| `AGENTS.md` | Document the flag |

---

### Task 1: Flag helper

**Files:**
- Modify: `clients/gui-app/src/lib/thanos-flags.ts`
- Create: `clients/gui-app/src/lib/__tests__/thanos-flags.test.ts`

**Interfaces:**
- Produces: `isThanosSingleUserChrome(): boolean`
- Produces: `isThanosHiddenSettingsSection(id: string): boolean` — true only for `"devices"` and `"usage"` when chrome is hidden
- Produces: `__setThanosSingleUserChromeForTests(value: boolean | null): void`
- Produces: `__resetThanosFlagsForTesting(): void`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetThanosFlagsForTesting,
  __setThanosSingleUserChromeForTests,
  isThanosHiddenSettingsSection,
  isThanosSingleUserChrome,
} from "../thanos-flags";

describe("thanos-flags", () => {
  afterEach(() => {
    __resetThanosFlagsForTesting();
  });

  it("keeps account chrome visible in unit tests by default", () => {
    expect(isThanosSingleUserChrome()).toBe(false);
    expect(isThanosHiddenSettingsSection("devices")).toBe(false);
    expect(isThanosHiddenSettingsSection("usage")).toBe(false);
    expect(isThanosHiddenSettingsSection("general")).toBe(false);
  });

  it("hides devices and usage when the single-user override is on", () => {
    __setThanosSingleUserChromeForTests(true);
    expect(isThanosSingleUserChrome()).toBe(true);
    expect(isThanosHiddenSettingsSection("devices")).toBe(true);
    expect(isThanosHiddenSettingsSection("usage")).toBe(true);
    expect(isThanosHiddenSettingsSection("general")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd clients/gui-app && bunx vitest run src/lib/__tests__/thanos-flags.test.ts`

Expected: FAIL — module does not export the new helpers.

- [ ] **Step 3: Implement helpers**

Add to `thanos-flags.ts`:

```ts
let singleUserChromeOverride: boolean | null = null;

export function isThanosSingleUserChrome(): boolean {
  if (singleUserChromeOverride !== null) return singleUserChromeOverride;
  if (import.meta.env.MODE === "test") return false;
  return true;
}

export function isThanosHiddenSettingsSection(id: string): boolean {
  if (!isThanosSingleUserChrome()) return false;
  return id === "devices" || id === "usage";
}

export function __setThanosSingleUserChromeForTests(
  value: boolean | null,
): void {
  singleUserChromeOverride = value;
}

export function __resetThanosFlagsForTesting(): void {
  singleUserChromeOverride = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd clients/gui-app && bunx vitest run src/lib/__tests__/thanos-flags.test.ts`

Expected: PASS

---

### Task 2: Header + user menu

**Files:**
- Modify: `clients/gui-app/src/components/layout/header/app-header.tsx`
- Modify: `clients/gui-app/src/components/auth/user-menu.tsx`

**Keep:** `HeaderIdentity` / `UserMenu` (Settings + Sign out). **Hide:** `HeaderNotificationsBell`, Manage subscription item.

- [ ] **Step 1: Gate the bell**

In `AppHeader`, replace `{showBell ? <HeaderNotificationsBell /> : null}` with:

```tsx
{showBell && !isThanosSingleUserChrome() ? (
  <HeaderNotificationsBell />
) : null}
```

- [ ] **Step 2: Gate Manage subscription in `UserMenu`**

Wrap the `user-menu-manage-subscription` `DropdownMenuItem` (and the separator before Sign out if it would double) so it does not render when `isThanosSingleUserChrome()` is true.

- [ ] **Step 3: Run existing tests (must stay green — flag is false in test mode)**

Run: `cd clients/gui-app && bunx vitest run src/components/auth/__tests__/user-menu.test.tsx src/components/layout/__tests__/header-notifications-bell.test.tsx src/components/layout/__tests__/app-shell-lifecycle-bridges.test.tsx`

Expected: PASS

---

### Task 3: Settings Account group + palette + deep links

**Files:**
- Modify: `clients/gui-app/src/components/settings/settings-sidebar.tsx`
- Modify: `clients/gui-app/src/components/settings/settings-modal-content.tsx`
- Modify: `clients/gui-app/src/lib/commands/sources/navigation.source.ts`

- [ ] **Step 1: Skip Account group in the sidebar**

When mapping `SETTINGS_SECTION_GROUPS`, skip `group.id === "account"` if `isThanosSingleUserChrome()`. Also skip any section where `isThanosHiddenSettingsSection(section.id)`.

- [ ] **Step 2: Deep-link fallback**

In `SettingsPanelForSection`, if `isThanosHiddenSettingsSection(props.section)` return `<GeneralSettingsPanel />` instead of Sessions/Usage.

- [ ] **Step 3: Command palette**

In `SETTINGS_SUBPAGE.useItems`, skip sections where `isThanosHiddenSettingsSection(section.id)`.

- [ ] **Step 4: Sidebar test with override**

Add to `settings-sidebar.test.tsx`:

```ts
it("omits the Account group when Thanos single-user chrome is on", () => {
  __setThanosSingleUserChromeForTests(true);
  render(<RouterProvider router={buildRouter("/settings/general")} />);
  expect(screen.queryByText("Account")).toBeNull();
  expect(screen.queryByTestId("settings-sidebar-item-devices")).toBeNull();
  expect(screen.queryByTestId("settings-sidebar-item-usage")).toBeNull();
  expect(screen.getByTestId("settings-sidebar-item-general")).toBeTruthy();
});
```

Reset the override in `afterEach`.

- [ ] **Step 5: Run tests**

Run: `cd clients/gui-app && bunx vitest run src/components/settings/__tests__/settings-sidebar.test.tsx src/lib/commands/__tests__/navigation.source.test.tsx`

Expected: PASS. Palette test still lists every `SETTINGS_SECTIONS` entry in default test mode.

---

### Task 4: Sharing rail + subscription + upgrade CTAs + migration

**Files:**
- Modify: `clients/gui-app/src/components/epic-canvas/sidebar/left-panel-registry.ts` — `sharing.isAutoVisible: () => !isThanosSingleUserChrome()`
- Modify: `clients/gui-app/src/components/settings/panels/traycer-subscription-section.tsx` — early `return null`
- Modify: `clients/gui-app/src/components/layout/header/host-picker.tsx` — `showUpsell` also requires `!isThanosSingleUserChrome()`
- Modify: `clients/gui-app/src/components/settings/host-scope/host-scope-gate.tsx` — `action={isThanosSingleUserChrome() ? null : <PlanRestrictedUpgradeAction />}`
- Modify: `clients/gui-app/src/components/settings/panels/general-settings-panel.tsx` — wrap Data migration `SettingsRow` with `isThanosSingleUserChrome() ? null : …`
- Modify: `clients/gui-app/src/components/layout/header/rate-limit-popover.tsx` — `orderRailTabs(providers, traycerSubscription.eligible && !isThanosSingleUserChrome())` and the zero-state check the same way

- [ ] **Step 1: Apply the gates**

- [ ] **Step 2: Run tests (default test mode keeps chrome)**

Run: `cd clients/gui-app && bunx vitest run src/components/epic-canvas/__tests__/left-panel-registry.test.ts src/components/settings/panels/__tests__/traycer-subscription-section.test.tsx src/components/settings/panels/__tests__/general-settings-panel.test.tsx src/components/layout/header/__tests__/host-picker.test.tsx src/components/settings/host-scope/__tests__/host-scope-gate.test.tsx src/components/layout/header/__tests__/rate-limit-popover.test.tsx`

Expected: PASS

---

### Task 5: Docs

**Files:**
- Modify: `AGENTS.md` (symlink `CLAUDE.md`)

Add under fork notes:

```
Thanos single-user chrome: `isThanosSingleUserChrome()` in
`clients/gui-app/src/lib/thanos-flags.ts` hides billing/sharing/account
settings. False in unit tests. Login is still required (cloud history).
```

---

## Out of scope (this plan)

- Removing `AuthLandingPage` / device-flow login
- Desktop native Sign In/Out menu and tray identity (optional follow-up; same flag in Electron main)
- True offline / local epic store — see `2026-08-12-thanos-no-login-offline.md`
