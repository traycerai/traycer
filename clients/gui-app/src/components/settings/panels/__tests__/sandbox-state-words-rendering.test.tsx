import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_FROZEN_WORD,
  HOST_SANDBOX_STATES,
  hostSandboxStateWord,
} from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { SandboxesSettingsPanel } from "@/components/settings/panels/sandboxes-settings-panel";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const fixtures = vi.hoisted(() => ({ rows: [] as readonly SandboxSummary[] }));

vi.mock("@/components/settings/settings-panel-shell", () => ({
  SettingsPanelShell: (props: { readonly children: ReactNode }) =>
    props.children,
}));
vi.mock("@/components/settings/panels/sandbox-defaults-section", () => ({
  SandboxDefaultsSection: () => null,
}));
vi.mock("@/components/hosts/sandbox-confirm-dialogs", () => ({
  SandboxDestroyAllIdleDialog: () => null,
}));
vi.mock("@/components/hosts/sandbox-reported-sessions", () => ({
  SandboxSessionPillBadge: () => null,
}));
vi.mock("@/components/settings/panels/sandbox-row-actions", () => ({
  SandboxRowActions: () => null,
}));
vi.mock("@/components/settings/panels/use-open-automation-terminal", () => ({
  useOpenAutomationTerminal: () => ({ starting: false, run: vi.fn() }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-configurations", () => ({
  useSandboxConfigurations: () => ({
    configurations: [{ kind: "personal" }],
    teamEnvironmentIds: new Set<string>(),
    complete: true,
  }),
  useSandboxWakeString: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data: { sandboxes: fixtures.rows },
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-refresh-sandbox-costs", () => ({
  useRefreshSandboxCosts: () => undefined,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-control-unavailable-reason", () => ({
  useSandboxControlUnavailableReason: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-automation-query", () => ({
  useSandboxAutomation: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-settings-status", () => ({
  useSandboxSettingsStatus: () => ({ data: { items: [] } }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxRowSessionReport: () => ({
    report: { kind: "unknown" },
    failed: false,
    resumePending: false,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-row-unreachable", () => ({
  useSandboxRowUnreachable: () => false,
}));
vi.mock(
  "@/hooks/sandboxes/use-apply-requested-sandboxes-configuration",
  () => ({
    useApplyRequestedSandboxesConfiguration: () => undefined,
  }),
);
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", () => ({
  useConfigurationSandboxDefaults: () => ({ read: () => null }),
}));
vi.mock("@/stores/settings/settings-environment-pick-store", () => ({
  useEnvironmentPick: () => ({ kind: "personal" }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://example.test" }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/lib/relative-time", () => ({
  useSampledNow: () => 1_791_100_000_000,
}));
vi.mock("@/stores/auth/auth-store", () => ({
  useAuthStore: (selector: (state: { contextMetadata: null }) => unknown) =>
    selector({ contextMetadata: null }),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ close: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

function row(
  state: (typeof HOST_SANDBOX_STATES)[number],
  index: number,
): SandboxSummary {
  return sandboxSummaryFixture({
    id: `state-${state}`,
    displayName: state,
    state,
    lastTransitionAt: 1_791_000_000_000 + index,
    lastActivityAt: null,
    frozen: state === "suspended",
  });
}

describe("sandbox state words in the settings list", () => {
  afterEach(() => cleanup());

  it("renders every state word, keeps frozen beside its state, and filters by all twelve raw states", () => {
    fixtures.rows = HOST_SANDBOX_STATES.map(row);
    render(<SandboxesSettingsPanel />);

    for (const state of HOST_SANDBOX_STATES) {
      const renderedRow = screen.getByText(state).closest("li");
      if (renderedRow === null) throw new Error(`Missing ${state} row`);
      expect(
        within(renderedRow).getByTestId("sandboxes-row-state").textContent,
      ).toBe(hostSandboxStateWord(state));
    }

    const suspendedRow = screen.getByText("suspended").closest("li");
    if (suspendedRow === null) throw new Error("Missing suspended row");
    expect(within(suspendedRow).getByText(HOST_FROZEN_WORD)).toBeTruthy();

    fireEvent.pointerDown(screen.getByTestId("sandboxes-filter"), {
      button: 0,
      ctrlKey: false,
    });
    for (const state of HOST_SANDBOX_STATES) {
      expect(
        screen.getByTestId(`sandboxes-filter-state-${state}`).textContent,
      ).toBe(hostSandboxStateWord(state));
    }

    fireEvent.click(screen.getByTestId("sandboxes-filter-state-suspended"));
    expect(
      screen
        .getAllByTestId("sandboxes-row")
        .map((item) => item.getAttribute("data-sandbox-row")),
    ).toEqual(["state-suspended"]);
  });

  it("sorts only raw awake rows first, ahead of newer resuming and starting rows", () => {
    fixtures.rows = [
      sandboxSummaryFixture({
        id: "starting",
        displayName: "starting",
        state: "starting",
        lastTransitionAt: 3,
      }),
      sandboxSummaryFixture({
        id: "resuming",
        displayName: "resuming",
        state: "resuming",
        lastTransitionAt: 2,
      }),
      sandboxSummaryFixture({
        id: "awake",
        displayName: "awake",
        state: "awake",
        lastTransitionAt: 1,
      }),
    ];
    render(<SandboxesSettingsPanel />);

    expect(
      screen
        .getAllByTestId("sandboxes-row-name")
        .map((item) => item.textContent),
    ).toEqual(["awake", "starting", "resuming"]);
  });
});
