/**
 * The Rules editor's unsaved text across a walk through OTHER Settings
 * sections, through the REAL `SettingsModalContent` / `SettingsSurface`, the
 * real `PermissionsSettingsPanel` and `RulesTab`. Leaving Permissions inside
 * Settings must not drop the edit; closing Settings (unmounting the surface)
 * resets it.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoPolicyGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  EMPTY_AUTO_POLICY_SECTIONS,
  joinAutoPolicySections,
} from "@/components/settings/panels/auto-policy-document";
import { SettingsModalContent } from "@/components/settings/settings-modal-content";
import { SettingsSurface } from "@/components/settings/settings-surface";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import {
  armSettingsOpenIntent,
  resetSettingsOpenIntentForTests,
} from "@/stores/tabs/settings-open-intent-store";

// ---- surface boundary -----------------------------------------------------

const route = vi.hoisted((): { pathname: string; mobile: boolean } => ({
  pathname: "/settings/permissions",
  mobile: false,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouterState: ({
      select,
    }: {
      select: (state: {
        readonly location: { readonly pathname: string };
      }) => unknown;
    }) => select({ location: { pathname: route.pathname } }),
  };
});
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: (): boolean => route.mobile,
}));
vi.mock("@/components/settings/settings-sidebar", () => ({
  SettingsSidebar: (): ReactNode => (
    <div data-testid="settings-sidebar-probe" />
  ),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    setSection: (): void => undefined,
    openSettings: (): void => undefined,
  }),
}));
vi.mock("@/components/settings/panels/providers-settings-panel", () => ({
  ProvidersSettingsPanel: (): ReactNode => (
    <div data-testid="providers-panel-probe" />
  ),
}));

// ---- host boundary, as in rules-tab-host-continuity -----------------------

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () =>
    hostScopeFixture({ status: "following", hostId: "host-a" }),
}));
vi.mock(
  "@/components/settings/host-scope/use-scoped-host-binding",
  async () => {
    const { scopedHostBindingFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return {
      useScopedHostBinding: (scope: HostScope) =>
        scopedHostBindingFixture(scope),
    };
  },
);
vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  useHostCapabilityProbe: (): void => undefined,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: (): string => "viewer-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostSupportsMethod: () => true,
}));

const policy = vi.hoisted(
  (): { current: AutoPolicyGetResponse | undefined } => ({
    current: undefined,
  }),
);
vi.mock("@/hooks/auto-mode/use-auto-policy-query", () => ({
  useAutoPolicyQuery: () => ({
    data: policy.current,
    isError: false,
    refetch: (): Promise<{ readonly isError: boolean }> =>
      Promise.resolve({ isError: false }),
  }),
}));
vi.mock("@/hooks/auto-mode/use-auto-policy-set-mutation", () => ({
  useAutoPolicySetMutation: () => ({
    mutate: (): void => undefined,
    isPending: false,
  }),
}));
vi.mock("@/components/settings/panels/permissions/judge-tab", () => ({
  JudgeTab: (): ReactNode => <div data-testid="judge-body" />,
}));
vi.mock("@/components/settings/panels/permissions/activity-tab", () => ({
  ActivityTab: (): ReactNode => <div data-testid="activity-body" />,
}));

// ---- helpers --------------------------------------------------------------

const STORED_ALLOW = "- Run the linter";
const TYPED = "typed edit";
const DRAFTED = "drafted rule";

beforeEach(() => {
  route.pathname = "/settings/permissions";
  route.mobile = false;
  policy.current = {
    body: joinAutoPolicySections({
      ...EMPTY_AUTO_POLICY_SECTIONS,
      allow: STORED_ALLOW,
    }),
    updatedAt: "2026-09-10T00:00:00.000Z",
    source: "account",
    readState: "fresh",
  };
  useSettingsHostScopeStore.setState({ scopedHostId: null });
  useSettingsSearchStore.setState({ pendingReveal: null });
  resetSettingsOpenIntentForTests();
});
afterEach(cleanup);

function allowField(): HTMLTextAreaElement {
  const element = screen.getByTestId("auto-policy-input-allow");
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("auto-policy-input-allow is not a textarea");
  }
  return element;
}

async function openRules(): Promise<void> {
  const user = userEvent.setup();
  const tab = screen.queryByTestId("permissions-tab-rules");
  if (tab !== null) {
    await user.click(tab);
    return;
  }
  // A phone swaps the tab strip for a Section select.
  await user.click(screen.getByRole("combobox", { name: "Section" }));
  await user.click(screen.getByRole("option", { name: /rules/i }));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function typeAndDeliverDraft(): Promise<void> {
  await openRules();
  fireEvent.change(allowField(), { target: { value: TYPED } });
  act(() => {
    armSettingsOpenIntent({
      section: "permissions",
      tab: "rules",
      draft: { section: "allow", text: DRAFTED },
      hostId: null,
      resetToGeneral: false,
    });
  });
  expect(allowField().value).toContain(TYPED);
  expect(allowField().value).toContain(DRAFTED);
}

function expectEditKeptOnce(): void {
  const value = allowField().value;
  expect(occurrences(value, TYPED)).toBe(1);
  expect(occurrences(value, DRAFTED)).toBe(1);
}

describe("Rules edit across sections inside Settings", () => {
  it("modal: keeps the typed text and the consumed draft, each once, through another section", async () => {
    const view = render(<SettingsModalContent section="permissions" />);
    await typeAndDeliverDraft();

    view.rerender(<SettingsModalContent section="providers" />);
    expect(screen.getByTestId("providers-panel-probe")).not.toBeNull();
    view.rerender(<SettingsModalContent section="permissions" />);
    await openRules();

    expectEditKeptOnce();
  });

  it("modal under StrictMode: an intent's draft is queued once", async () => {
    // Armed BEFORE the mount, so the panel's layout effect that queues the
    // draft is the one StrictMode runs twice with the same closure.
    act(() => {
      armSettingsOpenIntent({
        section: "permissions",
        tab: "rules",
        draft: { section: "allow", text: DRAFTED },
        hostId: null,
        resetToGeneral: false,
      });
    });
    const modal = (section: "permissions" | "providers"): ReactNode => (
      <StrictMode>
        <SettingsModalContent section={section} />
      </StrictMode>
    );
    const view = render(modal("permissions"));
    await openRules();

    expect(occurrences(allowField().value, DRAFTED)).toBe(1);

    view.rerender(modal("providers"));
    view.rerender(modal("permissions"));
    await openRules();

    expect(occurrences(allowField().value, DRAFTED)).toBe(1);
  });

  it("modal: closing Settings resets the edit to the record", async () => {
    const first = render(<SettingsModalContent section="permissions" />);
    await typeAndDeliverDraft();
    first.unmount();

    render(<SettingsModalContent section="permissions" />);
    await openRules();

    expect(allowField().value).toBe(STORED_ALLOW);
  });

  it("routed surface on a phone: keeps the edit through the index and another section", async () => {
    route.mobile = true;
    const view = render(<SettingsSurface lastPath={null} />);
    await typeAndDeliverDraft();

    route.pathname = "/settings";
    view.rerender(<SettingsSurface lastPath={null} />);
    expect(screen.queryByTestId("auto-policy-input-allow")).toBeNull();
    route.pathname = "/settings/providers";
    view.rerender(<SettingsSurface lastPath={null} />);
    expect(screen.getByTestId("providers-panel-probe")).not.toBeNull();
    route.pathname = "/settings/permissions";
    view.rerender(<SettingsSurface lastPath={null} />);
    await openRules();

    expectEditKeptOnce();
  });
});
