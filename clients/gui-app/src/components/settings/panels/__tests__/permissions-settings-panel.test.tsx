import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRulesEditForTests } from "@/components/settings/panels/permissions/rules-edit-store";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import {
  useEnvironmentPick,
  useSettingsEnvironmentPickStore,
} from "@/stores/settings/settings-environment-pick-store";
import { PermissionsSettingsPanel } from "@/components/settings/panels/permissions-settings-panel";
import type { PendingRuleDraft } from "@/components/settings/panels/auto-policy-document";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import {
  armSettingsOpenIntent,
  resetSettingsOpenIntentForTests,
  useSettingsOpenIntentStore,
} from "@/stores/tabs/settings-open-intent-store";
import type { SettingsRuleDraft } from "@/stores/tabs/system-overlay-types";

// The panel is host-scoped, so it reads `useHostScope`; mocked at that
// boundary, as the shell panel suite does.
const scopeOverrides = vi.hoisted((): { current: Partial<HostScope> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", () => {
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return {
    useHostScope,
    usePersonalHostScope: useHostScope,
  };
});

// The real carry, observed: the mock records the call and forwards it, so the
// scope store is what proves "carried" and "not carried".
const carryMock = vi.hoisted(() => vi.fn<(hostId: string | null) => void>());
const carryForwards = vi.hoisted((): { current: boolean } => ({
  current: true,
}));
vi.mock(
  "@/components/settings/host-scope/carry-viewed-host-into-settings",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/components/settings/host-scope/carry-viewed-host-into-settings")
      >();
    return {
      carryViewedHostIntoSettingsScope: (hostId: string | null) => {
        carryMock(hostId);
        if (carryForwards.current) {
          original.carryViewedHostIntoSettingsScope(hostId);
        }
      },
    };
  },
);

// The three host-scoped tab bodies have their own suites; here they are
// markers, so the panel's routing is what is under test.
const rulesProps = vi.hoisted(
  (): { current: ReadonlyArray<PendingRuleDraft> } => ({ current: [] }),
);
// The Judge stub notes the scope it rendered under, so a body mounting against
// the machine the page is leaving is observable.
const judgeRenderedUnder = vi.hoisted(
  (): { current: Array<string | null> } => ({ current: [] }),
);
vi.mock("@/components/settings/panels/permissions/judge-tab", () => ({
  JudgeTab: (): ReactNode => {
    judgeRenderedUnder.current.push(
      useSettingsHostScopeStore.getState().scopedHostId,
    );
    return <div data-testid="judge-body" />;
  },
}));
vi.mock("@/components/settings/panels/permissions/rules-tab", () => ({
  RulesTab: (props: {
    readonly active: boolean;
    readonly drafts: ReadonlyArray<PendingRuleDraft>;
  }): ReactNode => {
    rulesProps.current = props.drafts;
    // Local state, as the real editor's unsaved text is: a remount loses it.
    const [text, setText] = useState("pristine");
    return (
      <div data-testid="rules-body">
        <span data-testid="rules-text">{text}</span>
        <button type="button" onClick={() => setText("UNSAVED EDIT")}>
          stub edit
        </button>
      </div>
    );
  },
}));
vi.mock("@/components/settings/panels/permissions/activity-tab", () => ({
  ActivityTab: (props: {
    readonly onAllowFromNowOn: (draft: SettingsRuleDraft) => void;
    readonly onFixInJudge: () => void;
  }): ReactNode => (
    <div data-testid="activity-body">
      <button
        type="button"
        onClick={() =>
          props.onAllowFromNowOn({ section: "allow", text: "from activity" })
        }
      >
        stub allow
      </button>
      <button type="button" onClick={props.onFixInJudge}>
        stub fix
      </button>
    </div>
  ),
}));

// The team's surface has its own suite; here it is a marker.
vi.mock("@/components/settings/environment/team-permissions", () => ({
  TeamPermissions: (props: { readonly children: ReactNode }): ReactNode => (
    <div data-testid="team-permissions">{props.children}</div>
  ),
}));

// A team's switch reads and writes through the pool; both are markers here, as
// the team's own suite owns them.
vi.mock("@/hooks/environment/team/use-browser-access-query", () => ({
  useEnvironmentBrowserAccessQuery: () => ({
    isPending: false,
    data: { agentAccess: true },
  }),
}));
vi.mock("@/hooks/environment/team/use-configuration-item-mutations", () => ({
  useConfigurationItemMutations: () => ({
    put: { mutate: vi.fn(), isPending: false, data: undefined },
  }),
}));

const initialInnerWidth = window.innerWidth;

beforeEach(() => {
  scopeOverrides.current = {};
  carryMock.mockReset();
  carryForwards.current = true;
  judgeRenderedUnder.current = [];
  rulesProps.current = [];
  useSettingsHostScopeStore.setState({ scopedHostId: null });
  useSettingsSearchStore.setState({ pendingReveal: null });
  resetSettingsOpenIntentForTests();
  resetRulesEditForTests();
});

afterEach(() => {
  cleanup();
  resetRulesEditForTests();
  window.innerWidth = initialInnerWidth;
});

function armIntent(overrides: {
  readonly tab: string | null;
  readonly draft: SettingsRuleDraft | null;
  readonly hostId: string | null;
}): void {
  armSettingsOpenIntent({
    section: "permissions",
    resetToGeneral: false,
    ...overrides,
  });
}

/**
 * Whether the element, or an ancestor, is hidden: a concealed `Activity`, or
 * an inactive tab pane (whose Tailwind `hidden` class jsdom does not apply).
 */
function isConcealed(element: HTMLElement): boolean {
  for (
    let node: HTMLElement | null = element;
    node !== null;
    node = node.parentElement
  ) {
    if (
      node.hidden ||
      node.getAttribute("data-state") === "inactive" ||
      getComputedStyle(node).display === "none"
    ) {
      return true;
    }
  }
  return false;
}

/** The connecting notices on screen; the force-mounted Rules pane keeps a hidden one. */
function shownConnectingNotices(): ReadonlyArray<HTMLElement> {
  return screen
    .getAllByTestId("host-scope-connecting")
    .filter((notice) => !isConcealed(notice));
}

function activeTabTestId(): string | null {
  const active = screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("data-state") === "active");
  return active?.getAttribute("data-testid") ?? null;
}

describe("PermissionsSettingsPanel", () => {
  it("renders four tab triggers, each carrying its settings anchor", () => {
    render(<PermissionsSettingsPanel />);

    for (const [tab, label] of [
      ["modes", "Modes"],
      ["judge", "Judge"],
      ["rules", "Rules"],
      ["activity", "Activity"],
    ] as const) {
      const trigger = screen.getByTestId(`permissions-tab-${tab}`);
      expect(trigger.textContent).toBe(label);
      expect(trigger.getAttribute("data-settings-anchor")).toBe(
        `permissions-tab-${tab}`,
      );
    }
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });

  it("shows the Browser agent access switch below the tabs on a host pick", () => {
    render(<PermissionsSettingsPanel />);

    const group = screen.getByTestId("settings-browser-agent-access");
    expect(group.textContent).toContain("Browser agent access");
    expect(
      within(group).getByRole("switch", {
        name: "Let agents use the in-app browser",
      }),
    ).toBeTruthy();
    const tabs = screen.getAllByRole("tab")[0];
    expect(
      tabs.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("starts on Modes", () => {
    render(<PermissionsSettingsPanel />);

    expect(activeTabTestId()).toBe("permissions-tab-modes");
  });

  describe("Modes with no usable host", () => {
    it("renders and works while the scope is connecting", () => {
      scopeOverrides.current = { status: "connecting" };
      render(<PermissionsSettingsPanel />);

      expect(screen.getByText(/New conversations start in/)).not.toBeNull();
      expect(screen.getByText("This app only")).not.toBeNull();
    });

    it("renders with no host at all", () => {
      scopeOverrides.current = { host: null };
      render(<PermissionsSettingsPanel />);

      expect(screen.getByText(/New conversations start in/)).not.toBeNull();
    });
  });

  describe("while the host is connecting", () => {
    beforeEach(() => {
      scopeOverrides.current = { status: "connecting" };
    });

    it("holds Judge, Rules and Activity behind the connecting copy", async () => {
      const user = userEvent.setup();
      render(<PermissionsSettingsPanel />);

      // The gate holds a body inside a hidden `Activity`, so "not shown" is
      // concealed rather than absent.
      await user.click(screen.getByTestId("permissions-tab-rules"));
      expect(shownConnectingNotices()).toHaveLength(1);
      expect(isConcealed(screen.getByTestId("rules-body"))).toBe(true);

      await user.click(screen.getByTestId("permissions-tab-judge"));
      expect(shownConnectingNotices()).toHaveLength(1);
      expect(isConcealed(screen.getByTestId("judge-body"))).toBe(true);

      await user.click(screen.getByTestId("permissions-tab-activity"));
      expect(shownConnectingNotices()).toHaveLength(1);
      expect(isConcealed(screen.getByTestId("activity-body"))).toBe(true);
    });
  });

  describe("the open intent", () => {
    it("opens Judge for tab: judge", () => {
      armIntent({ tab: "judge", draft: null, hostId: null });
      render(<PermissionsSettingsPanel />);

      expect(activeTabTestId()).toBe("permissions-tab-judge");
      expect(screen.getByTestId("judge-body")).not.toBeNull();
    });

    it("opens Rules for a draft, and hands it to the tab", () => {
      armIntent({
        tab: null,
        draft: { section: "allow", text: "Run the linter" },
        hostId: null,
      });
      render(<PermissionsSettingsPanel />);

      expect(activeTabTestId()).toBe("permissions-tab-rules");
      expect(rulesProps.current).toEqual([
        { id: 1, draft: { section: "allow", text: "Run the linter" } },
      ]);
    });

    it("does not remount Rules when the intent names the host Settings already follows", async () => {
      const user = userEvent.setup();
      // Following the active host: the raw pin is null, the scope's host is host-a.
      scopeOverrides.current = { hostId: "host-a" };
      render(<PermissionsSettingsPanel />);
      await user.click(screen.getByTestId("permissions-tab-rules"));
      await user.click(screen.getByRole("button", { name: "stub edit" }));
      expect(screen.getByTestId("rules-text").textContent).toBe("UNSAVED EDIT");

      act(() => {
        armIntent({
          tab: "rules",
          draft: { section: "allow", text: "second draft" },
          hostId: "host-a",
        });
      });

      expect(screen.getByTestId("rules-text").textContent).toBe("UNSAVED EDIT");
    });

    it("carries a named host into the Settings scope and acknowledges the intent", () => {
      armIntent({ tab: "judge", draft: null, hostId: "host-b" });
      render(<PermissionsSettingsPanel />);

      expect(carryMock).toHaveBeenCalledWith("host-b");
      expect(useSettingsHostScopeStore.getState().scopedHostId).toBe("host-b");
      expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
    });

    it("does not carry a host when the intent names none", () => {
      armIntent({ tab: "judge", draft: null, hostId: null });
      render(<PermissionsSettingsPanel />);

      expect(useSettingsHostScopeStore.getState().scopedHostId).toBeNull();
      expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
    });

    it("never mounts a gated body against the machine the page is leaving", () => {
      armIntent({ tab: "judge", draft: null, hostId: "host-b" });
      render(<PermissionsSettingsPanel />);

      expect(judgeRenderedUnder.current.length).toBeGreaterThan(0);
      expect(judgeRenderedUnder.current.every((id) => id === "host-b")).toBe(
        true,
      );
    });
  });

  describe("with a team picked", () => {
    const TEAM_PICK = { kind: "team", environmentId: "env-a" } as const;
    const POOL: ConfigurationSource = {
      kind: "pool",
      configuration: "team",
      environmentId: "env-a",
      roomId: "room-a",
      providerHandle: "handle-a",
      effectiveRole: "admin",
    };

    /** `PersonalPageFrame`'s rule: the team's source while a team is picked. */
    function PickedSource(props: { readonly children: ReactNode }): ReactNode {
      const pick = useEnvironmentPick();
      return pick.kind === "team" ? (
        <ConfigurationSourceContext.Provider value={POOL}>
          {props.children}
        </ConfigurationSourceContext.Provider>
      ) : (
        props.children
      );
    }

    function renderPicked(): void {
      render(
        <PickedSource>
          <PermissionsSettingsPanel />
        </PickedSource>,
      );
    }

    beforeEach(() => {
      const windowHost = hostScopeOptionFixture({
        hostId: "host-a",
        name: "MacBook Pro",
      });
      scopeOverrides.current = {
        host: windowHost,
        hosts: [
          windowHost,
          hostScopeOptionFixture({
            hostId: "host-b",
            name: "Studio",
            isLocalMachine: false,
          }),
        ],
      };
      useSettingsEnvironmentPickStore.setState({
        pick: TEAM_PICK,
        defaultPick: PERSONAL_PICK,
      });
    });

    afterEach(() => {
      useSettingsEnvironmentPickStore.setState({
        pick: null,
        defaultPick: PERSONAL_PICK,
      });
    });

    it("shows the team's Permissions while nothing asked for a machine's", () => {
      renderPicked();

      expect(screen.getByTestId("team-permissions")).not.toBeNull();
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        TEAM_PICK,
      );
    });

    it("shows the Browser agent access switch inside the team's Permissions", () => {
      renderPicked();

      const group = within(screen.getByTestId("team-permissions")).getByTestId(
        "settings-browser-agent-access",
      );
      expect(group.textContent).toContain("Browser agent access");
      expect(
        within(group)
          .getByRole("switch", { name: "Let agents use the in-app browser" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    it("opens a composer's machine on its Judge tab, moving the pick to that machine's row, and spends the intent", () => {
      armIntent({ tab: "judge", draft: null, hostId: "host-b" });
      renderPicked();

      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
        kind: "local",
        hostId: "host-b",
        hostName: "Studio",
      });
      expect(screen.queryByTestId("team-permissions")).toBeNull();
      expect(activeTabTestId()).toBe("permissions-tab-judge");
      expect(screen.getByTestId("judge-body")).not.toBeNull();
      expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
    });

    it("opens this window's own machine on its default row", () => {
      armIntent({ tab: "judge", draft: null, hostId: "host-a" });
      renderPicked();

      expect(useSettingsEnvironmentPickStore.getState().pick).toBeNull();
      expect(activeTabTestId()).toBe("permissions-tab-judge");
      expect(useSettingsOpenIntentStore.getState().intent).toBeNull();
    });
  });

  describe("a settings-search reveal", () => {
    it("switches to Rules for the Rules tab anchor", () => {
      useSettingsSearchStore.setState({
        pendingReveal: {
          section: "permissions",
          anchor: "permissions-tab-rules",
          requestedAt: 1,
        },
      });
      render(<PermissionsSettingsPanel />);

      expect(activeTabTestId()).toBe("permissions-tab-rules");
    });

    it("switches to Modes for the default-permission row anchor", () => {
      armIntent({ tab: "judge", draft: null, hostId: null });
      render(<PermissionsSettingsPanel />);
      expect(activeTabTestId()).toBe("permissions-tab-judge");

      act(() => {
        useSettingsSearchStore.setState({
          pendingReveal: {
            section: "permissions",
            anchor: "permissions-default-permission-mode",
            requestedAt: 2,
          },
        });
      });

      expect(activeTabTestId()).toBe("permissions-tab-modes");
    });

    it("ignores a reveal for another section", () => {
      useSettingsSearchStore.setState({
        pendingReveal: {
          section: "general",
          anchor: "permissions-tab-rules",
          requestedAt: 1,
        },
      });
      render(<PermissionsSettingsPanel />);

      expect(activeTabTestId()).toBe("permissions-tab-modes");
    });
  });

  describe("tab-to-tab hand-offs from Activity", () => {
    it("Allow from now on opens Rules with the drafted line", async () => {
      const user = userEvent.setup();
      armIntent({ tab: "activity", draft: null, hostId: null });
      render(<PermissionsSettingsPanel />);

      await user.click(screen.getByRole("button", { name: "stub allow" }));

      expect(activeTabTestId()).toBe("permissions-tab-rules");
      expect(rulesProps.current).toEqual([
        { id: 1, draft: { section: "allow", text: "from activity" } },
      ]);
    });

    it("Fix in Judge switches to Judge", async () => {
      const user = userEvent.setup();
      armIntent({ tab: "activity", draft: null, hostId: null });
      render(<PermissionsSettingsPanel />);

      await user.click(screen.getByRole("button", { name: "stub fix" }));

      expect(activeTabTestId()).toBe("permissions-tab-judge");
    });
  });

  describe("on a phone", () => {
    beforeEach(() => {
      window.innerWidth = 500;
    });

    it("replaces the tab bar with one Select carrying the active tab's anchor", () => {
      render(<PermissionsSettingsPanel />);

      expect(screen.queryAllByRole("tab")).toHaveLength(0);
      const select = screen.getByRole("combobox", { name: "Section" });
      expect(select.getAttribute("data-settings-anchor")).toBe(
        "permissions-tab-modes",
      );
    });

    it("moves the anchor to the newly active tab", () => {
      armIntent({ tab: "judge", draft: null, hostId: null });
      render(<PermissionsSettingsPanel />);

      expect(
        screen
          .getByRole("combobox", { name: "Section" })
          .getAttribute("data-settings-anchor"),
      ).toBe("permissions-tab-judge");
    });
  });
});
