/**
 * The Rules editor's unsaved text across a change of host scope, through the
 * REAL panel, `RulesTab`, `AutoModeHostGate` and `HostScopeGate`. Judge and
 * Activity are markers: this is about what survives a transient disconnect, an
 * intent naming the followed host, and a real switch of machine.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRulesEditForTests } from "@/components/settings/panels/permissions/rules-edit-store";
import type { AutoPolicyGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  EMPTY_AUTO_POLICY_SECTIONS,
  joinAutoPolicySections,
} from "@/components/settings/panels/auto-policy-document";
import { PermissionsSettingsPanel } from "@/components/settings/panels/permissions-settings-panel";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import {
  armSettingsOpenIntent,
  resetSettingsOpenIntentForTests,
} from "@/stores/tabs/settings-open-intent-store";

// ---- the scope, as a subscribable store -----------------------------------

type ScopeStatus = "following" | "unreachable";
interface ScopeSnapshot {
  readonly status: ScopeStatus;
  readonly hostId: string;
}

// Subscribable, as production's scope is: every reader re-renders on its own
// when the status moves, not only when a parent passes new props.
const scopeStore = vi.hoisted(() => {
  let snapshot: ScopeSnapshot = { status: "following", hostId: "host-a" };
  const listeners = new Set<() => void>();
  return {
    get: (): ScopeSnapshot => snapshot,
    set: (next: ScopeSnapshot): void => {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

function useScope(): HostScope {
  const { status, hostId } = useSyncExternalStore(
    scopeStore.subscribe,
    scopeStore.get,
  );
  return hostScopeFixture({
    status,
    host: hostScopeOptionFixture({ hostId }),
  });
}
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => useScope(),
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
// The signed-in account; `""` is "not known yet", as in production.
const viewerStore = vi.hoisted(() => {
  let viewer = "viewer-a";
  const listeners = new Set<() => void>();
  return {
    get: (): string => viewer,
    set: (next: string): void => {
      viewer = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: (): string =>
    useSyncExternalStore(viewerStore.subscribe, viewerStore.get),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostSupportsMethod: () => true,
}));

// ---- the policy read and write --------------------------------------------

const policy = vi.hoisted(
  (): { current: AutoPolicyGetResponse | undefined } => ({
    current: undefined,
  }),
);
// Which machine each opening read was made for: the scope's host at the call.
const refetchedFor = vi.hoisted((): { current: Array<string> } => ({
  current: [],
}));
const refetchMock = vi.hoisted(() =>
  vi.fn<
    (options: {
      readonly cancelRefetch: boolean;
    }) => Promise<{ readonly isError: boolean }>
  >(),
);
// When set, host-b's read answers this instead: what the account holds once a
// save made on another machine has landed.
const savedElsewhere = vi.hoisted(
  (): { current: AutoPolicyGetResponse | null } => ({ current: null }),
);
vi.mock("@/hooks/auto-mode/use-auto-policy-query", () => ({
  useAutoPolicyQuery: () => ({
    data:
      scopeStore.get().hostId === "host-b" && savedElsewhere.current !== null
        ? savedElsewhere.current
        : policy.current,
    isError: false,
    refetch: refetchMock,
  }),
}));
interface HeldSave {
  readonly body: string;
  readonly onSuccess: (response: { readonly updatedAt: string | null }) => void;
}
const heldSaves = vi.hoisted((): { current: Array<HeldSave> } => ({
  current: [],
}));
vi.mock("@/hooks/auto-mode/use-auto-policy-set-mutation", () => ({
  useAutoPolicySetMutation: () => ({
    // Held: the write never answers until the test releases it.
    mutate: (
      variables: { readonly body: string },
      callbacks: {
        readonly onSuccess: (response: {
          readonly updatedAt: string | null;
        }) => void;
      },
    ): void => {
      heldSaves.current.push({
        body: variables.body,
        onSuccess: callbacks.onSuccess,
      });
    },
    isPending: false,
  }),
}));

// ---- the other two tabs are markers ---------------------------------------

vi.mock("@/components/settings/panels/permissions/judge-tab", () => ({
  JudgeTab: (): ReactNode => <div data-testid="judge-body" />,
}));
vi.mock("@/components/settings/panels/permissions/activity-tab", () => ({
  ActivityTab: (): ReactNode => <div data-testid="activity-body" />,
}));

// ---- helpers --------------------------------------------------------------

const DRAFT_NOTE = /^Applies to every repository on your account\./;

beforeEach(() => {
  scopeStore.set({ status: "following", hostId: "host-a" });
  viewerStore.set("viewer-a");
  policy.current = {
    body: joinAutoPolicySections({
      ...EMPTY_AUTO_POLICY_SECTIONS,
      allow: "- Run the linter",
    }),
    updatedAt: "2026-09-10T00:00:00.000Z",
    source: "account",
    readState: "fresh",
  };
  refetchedFor.current = [];
  savedElsewhere.current = null;
  heldSaves.current = [];
  refetchMock.mockReset();
  refetchMock.mockImplementation(() => {
    refetchedFor.current.push(scopeStore.get().hostId);
    return Promise.resolve({ isError: false });
  });
  useSettingsHostScopeStore.setState({ scopedHostId: null });
  useSettingsSearchStore.setState({ pendingReveal: null });
  resetSettingsOpenIntentForTests();
  resetRulesEditForTests();
});
afterEach(() => {
  cleanup();
  resetRulesEditForTests();
});

function allowField(): HTMLTextAreaElement {
  const element = screen.getByTestId("auto-policy-input-allow");
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("auto-policy-input-allow is not a textarea");
  }
  return element;
}

function discardButton(): HTMLButtonElement {
  const element = screen.getByTestId("auto-policy-discard");
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("auto-policy-discard is not a button");
  }
  return element;
}

async function openRules(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("permissions-tab-rules"));
}

async function flushTimers(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function moveScope(next: ScopeSnapshot): Promise<void> {
  await act(async () => {
    scopeStore.set(next);
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function moveViewer(next: string): Promise<void> {
  await act(async () => {
    viewerStore.set(next);
    await Promise.resolve();
  });
}

function armDraftIntent(text: string, hostId: string | null): void {
  act(() => {
    armSettingsOpenIntent({
      section: "permissions",
      tab: "rules",
      draft: { section: "allow", text },
      hostId,
      resetToGeneral: false,
    });
  });
}

describe("Rules editor across host scope changes", () => {
  it("A: a transient disconnect on the same host keeps the typed text and the consumed draft", async () => {
    render(<PermissionsSettingsPanel />);
    await openRules();
    fireEvent.change(allowField(), { target: { value: "typed edit" } });
    armDraftIntent("drafted rule", null);
    expect(allowField().value).toContain("typed edit");
    expect(allowField().value).toContain("drafted rule");
    expect(screen.getByText(DRAFT_NOTE)).not.toBeNull();

    await moveScope({ status: "unreachable", hostId: "host-a" });
    await moveScope({ status: "following", hostId: "host-a" });

    expect(allowField().value).toContain("typed edit");
    expect(allowField().value).toContain("drafted rule");
    expect(screen.getByText(DRAFT_NOTE)).not.toBeNull();
  });

  it("B: an intent naming the host Settings already follows appends its draft below the unsaved edit", async () => {
    render(<PermissionsSettingsPanel />);
    await openRules();
    fireEvent.change(allowField(), { target: { value: "first edit" } });
    expect(allowField().value).toBe("first edit");

    armDraftIntent("second draft", "host-a");

    expect(allowField().value).toContain("first edit");
    expect(allowField().value).toContain("second draft");
    expect(allowField().value.indexOf("first edit")).toBeLessThan(
      allowField().value.indexOf("second draft"),
    );
  });

  it("C: moving to another host keeps the unsaved edit and re-runs the opening read for the new host", async () => {
    render(<PermissionsSettingsPanel />);
    await openRules();
    fireEvent.change(allowField(), { target: { value: "edit on host-a" } });
    expect(refetchedFor.current).toContain("host-a");
    expect(refetchedFor.current).not.toContain("host-b");

    await moveScope({ status: "following", hostId: "host-b" });

    expect(allowField().value).toContain("edit on host-a");
    expect(refetchedFor.current).toContain("host-b");
  });

  describe("the Rules read waits for the first visit", () => {
    async function openTab(name: "modes" | "rules"): Promise<void> {
      const user = userEvent.setup();
      await user.click(screen.getByTestId(`permissions-tab-${name}`));
    }

    it("starts no Rules read while the page is opened on Modes and Rules was never shown", async () => {
      render(<PermissionsSettingsPanel />);
      await flushTimers();

      expect(refetchMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("auto-policy-input-allow")).toBeNull();
    });

    it("mounts and reads on the first visit, then keeps the edit across a look at Modes", async () => {
      render(<PermissionsSettingsPanel />);
      await openTab("rules");
      await flushTimers();
      expect(refetchMock).toHaveBeenCalled();
      fireEvent.change(allowField(), { target: { value: "kept edit" } });

      await openTab("modes");
      // Still mounted, hidden.
      expect(allowField().value).toBe("kept edit");
      await openTab("rules");

      expect(allowField().value).toBe("kept edit");
    });

    it("counts a draft intent as a visit", async () => {
      armDraftIntent("from a card", null);
      render(<PermissionsSettingsPanel />);
      await flushTimers();

      expect(refetchMock).toHaveBeenCalled();
      expect(allowField().value).toContain("from a card");
    });
  });

  describe("the edit follows the account, not the machine or a moment of not knowing who", () => {
    it("drops the edit when a different account signs in", async () => {
      render(<PermissionsSettingsPanel />);
      await openRules();
      fireEvent.change(allowField(), { target: { value: "viewer-a edit" } });

      await moveViewer("viewer-b");

      expect(allowField().value).toBe("- Run the linter");
    });

    it("keeps an edit made before the account resolved, once it does", async () => {
      viewerStore.set("");
      render(<PermissionsSettingsPanel />);
      await openRules();
      fireEvent.change(allowField(), { target: { value: "early edit" } });

      await moveViewer("viewer-a");

      expect(allowField().value).toBe("early edit");
    });

    it("keeps the edit through a gap of not knowing the account", async () => {
      render(<PermissionsSettingsPanel />);
      await openRules();
      fireEvent.change(allowField(), {
        target: { value: "edit across a gap" },
      });

      await moveViewer("");
      await moveViewer("viewer-a");

      expect(allowField().value).toBe("edit across a gap");
    });
  });

  it("a save still in flight when the machine switches leaves a clean editor once the new machine's read shows it", async () => {
    render(<PermissionsSettingsPanel />);
    await openRules();
    await flushTimers();
    fireEvent.change(allowField(), { target: { value: "saved edit" } });
    fireEvent.click(screen.getByTestId("auto-policy-save"));
    expect(heldSaves.current).toHaveLength(1);

    // host-b's opening read answers the record the save produced.
    const savedBody = joinAutoPolicySections({
      ...EMPTY_AUTO_POLICY_SECTIONS,
      allow: "saved edit",
    });
    savedElsewhere.current = {
      body: savedBody,
      updatedAt: "2026-09-11T00:00:00.000Z",
      source: "account",
      readState: "fresh",
    };
    await moveScope({ status: "following", hostId: "host-b" });
    await act(async () => {
      heldSaves.current[0]?.onSuccess({
        updatedAt: "2026-09-11T00:00:00.000Z",
      });
      await Promise.resolve();
    });
    await flushTimers();

    expect(allowField().value).toBe("saved edit");
    expect(discardButton().disabled).toBe(true);
    expect(screen.queryByText(/saved somewhere else/)).toBeNull();
  });
});
