import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  SandboxCatalogue,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  sandboxPeriodLabel,
  sandboxRowActionLabel,
  sandboxRowActions,
  type SandboxPageConfiguration,
} from "@/lib/sandboxes/sandbox-row-lines";
import { KEPT_UNTIL_YOU_DESTROY_IT } from "@/lib/sandboxes/sandbox-strings";
import { useSandboxShapeMemoryStore } from "@/stores/composer/sandbox-shape-memory-store";

const CATALOGUE: SandboxCatalogue = {
  providers: [
    {
      provider: "tensorlake",
      os: ["linux"],
      shape: {
        cpuMin: 1,
        cpuMax: 16,
        cpuStep: 1,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        memoryMinMb: 1024,
        memoryMaxMb: 65536,
        memoryStepMb: 512,
        diskMinMb: 10240,
        diskMaxMb: 102400,
        diskDefaultMb: 20480,
      },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      dockerInGuest: true,
      creatable: true,
      notCreatableReason: null,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
        },
      ],
    },
  ],
};

const mocks = vi.hoisted(() => ({
  sandboxes: [] as readonly SandboxSummary[],
  /** `false` while the list query has not answered. */
  listed: true,
  configurations: [{ kind: "personal" }] as SandboxPageConfiguration[],
  catalogue: null as SandboxCatalogue | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-configurations")
    >()),
    useSandboxConfigurations: () => ({
      configurations: mocks.configurations,
      teamEnvironmentIds: new Set(
        mocks.configurations.flatMap((configuration) =>
          configuration.kind === "team" && configuration.environmentId !== null
            ? [configuration.environmentId]
            : [],
        ),
      ),
      complete: true,
    }),
    useSandboxWakeString: () => null,
  }),
);
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data: mocks.listed ? { sandboxes: mocks.sandboxes } : undefined,
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
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: mocks.catalogue }),
}));
vi.mock("@/hooks/host/use-composer-surface-host-pin", () => ({
  useComposerSurfaceHostKey: () => "landing:window-test",
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "laptop",
}));
vi.mock("@/hooks/sandboxes/use-sandbox-control-unavailable-reason", () => ({
  useSandboxControlUnavailableReason: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxSessionReport: () => ({
    report: { kind: "unknown" },
    failed: false,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-destroy-batch-mutation", () => ({
  useSandboxDestroyBatch: () => ({
    data: undefined,
    isPending: false,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://example.test" }),
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ close: vi.fn(), openSettings: vi.fn() }),
}));
// The actions have their own verbs and dialogs; the page's contract is which
// primary action each row offers, so the stub renders the model's own pick.
vi.mock("@/components/settings/panels/sandbox-row-actions", () => ({
  SandboxRowActions: (props: {
    summary: SandboxSummary;
    configuration: SandboxPageConfiguration;
    unreachable: boolean;
    frozenNeedsOwnCredits: boolean;
  }) => {
    const { primary } = sandboxRowActions(props);
    return (
      <span data-testid="row-primary">
        {primary === null
          ? ""
          : sandboxRowActionLabel(primary, props.configuration)}
      </span>
    );
  },
}));

import { SandboxesSettingsPanel } from "@/components/settings/panels/sandboxes-settings-panel";
import { useOpenSandboxesPage } from "@/hooks/sandboxes/use-open-sandboxes-page";
import { useSandboxesPageStore } from "@/stores/sandboxes/sandboxes-page-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";

function row(id: string, overrides: Partial<SandboxSummary>): SandboxSummary {
  return sandboxSummaryFixture({
    id,
    hostId: `host-${id}`,
    displayName: id,
    ...overrides,
  });
}

function renderPanel(sandboxes: readonly SandboxSummary[]): void {
  mocks.sandboxes = sandboxes;
  render(<SandboxesSettingsPanel />);
}

function rowOf(id: string): HTMLElement {
  const found = screen
    .getAllByTestId("sandboxes-row")
    .find((candidate) => candidate.getAttribute("data-sandbox-row") === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
}

function names(): string[] {
  return screen
    .queryAllByTestId("sandboxes-row-name")
    .map((node) => node.textContent);
}

describe("<SandboxesSettingsPanel />", () => {
  beforeEach(() => {
    mocks.sandboxes = [];
    mocks.listed = true;
    mocks.configurations = [{ kind: "personal" }];
    mocks.catalogue = null;
    useSandboxesPageStore.setState({
      configurationId: { kind: "personal" },
      revealSandboxId: null,
      revealConfigurationPending: false,
    });
    useSandboxShapeMemoryStore.setState({
      byHost: {},
      lastConfigurationByHost: {},
    });
  });

  it("shows the person's remembered pick in the defaults, else the spec's", () => {
    mocks.catalogue = CATALOGUE;
    renderPanel([]);
    expect(
      screen.getByTestId("sandboxes-defaults-shape").textContent,
    ).toContain("2 vCPU");
    expect(screen.getByTestId("sandboxes-defaults-idle").textContent).toBe(
      sandboxPeriodLabel(30),
    );
    expect(screen.getByTestId("sandboxes-defaults-resting").textContent).toBe(
      sandboxPeriodLabel(7 * 24 * 60),
    );
    cleanup();

    useSandboxShapeMemoryStore.getState().remember("laptop", "personal", {
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: null,
      region: "us-east",
      idleMinutes: 45,
      destroyAfterRestingMinutes: null,
    });
    renderPanel([]);

    expect(
      screen.getByTestId("sandboxes-defaults-shape").textContent,
    ).toContain("4 vCPU");
    expect(screen.getByTestId("sandboxes-defaults-idle").textContent).toBe(
      sandboxPeriodLabel(45),
    );
    expect(screen.getByTestId("sandboxes-defaults-resting").textContent).toBe(
      KEPT_UNTIL_YOU_DESTROY_IT,
    );
  });
  afterEach(() => cleanup());

  it("renders one row per state with its badge and primary action", () => {
    renderPanel([
      row("awake-1", { state: "awake" }),
      row("suspended-1", { state: "suspended" }),
      row("stopped-1", { state: "stopped" }),
      row("frozen-1", { state: "suspended", frozen: true, frozenAt: 1 }),
      row("failed-1", { state: "failed", failureCode: "boom" }),
    ]);

    const expected: Record<string, [string, string]> = {
      "awake-1": ["Awake", "Suspend"],
      "suspended-1": ["Suspended", "Resume"],
      "stopped-1": ["Stopped", "Start"],
      "frozen-1": ["Frozen", "Add credits ↗"],
      "failed-1": ["Failed", "Retry"],
    };
    for (const [id, [badge, primary]] of Object.entries(expected)) {
      const element = rowOf(id);
      expect(
        within(element).getByTestId("sandboxes-row-state").textContent,
      ).toBe(badge);
      expect(within(element).getByTestId("row-primary").textContent).toBe(
        primary,
      );
    }
  });

  it("offers an awake agent sandbox Keep instead of Suspend", () => {
    renderPanel([row("agent-1", { state: "awake", burst: true })]);
    expect(
      within(rowOf("agent-1")).getByTestId("row-primary").textContent,
    ).toBe("Keep this sandbox");
  });

  it("narrows the list by the search and by the state filter, with a count badge", () => {
    renderPanel([
      row("alpha", { state: "awake" }),
      row("beta", { state: "suspended" }),
      row("gamma", { state: "suspended" }),
    ]);
    expect(names().sort()).toEqual(["alpha", "beta", "gamma"]);

    fireEvent.change(screen.getByTestId("sandboxes-search"), {
      target: { value: "bet" },
    });
    expect(names()).toEqual(["beta"]);
    fireEvent.change(screen.getByTestId("sandboxes-search"), {
      target: { value: "" },
    });

    fireEvent.pointerDown(screen.getByTestId("sandboxes-filter"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByTestId("sandboxes-filter-state-awake"));
    expect(names()).toEqual(["alpha"]);
    expect(screen.getByTestId("sandboxes-filter-count").textContent).toBe("1");
  });

  it("lists exactly the filtered idle agent sandboxes in Destroy all idle", () => {
    renderPanel([
      row("idle-a", { state: "suspended", burst: true }),
      row("idle-b", { state: "stopped", burst: true }),
      row("idle-c", { state: "suspended", burst: true }),
      row("awake-agent", { state: "awake", burst: true }),
      row("plain-suspended", { state: "suspended", burst: false }),
    ]);
    expect(screen.queryByTestId("sandboxes-destroy-all-idle")).toBeNull();

    fireEvent.pointerDown(screen.getByTestId("sandboxes-filter"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByTestId("sandboxes-filter-kind-agent"));
    fireEvent.click(screen.getByTestId("sandboxes-filter-state-suspended"));

    fireEvent.click(screen.getByTestId("sandboxes-destroy-all-idle"));
    const targets = screen.getByTestId("sandbox-destroy-all-idle-targets");
    expect(
      Array.from(targets.querySelectorAll("li")).map((li) => li.textContent),
    ).toEqual(["idle-a", "idle-c"]);
  });

  it("reveals a notification's team row on its team once a list that had not answered settles", () => {
    mocks.configurations = [
      { kind: "personal" },
      {
        kind: "team",
        teamId: "team-1",
        teamName: "Acme",
        environmentId: "env-acme",
      },
    ];
    mocks.listed = false;
    let open: (sandboxId: string) => void = () => undefined;
    function Opener() {
      open = useOpenSandboxesPage();
      return null;
    }
    const { rerender } = render(
      <>
        <Opener />
        <SandboxesSettingsPanel />
      </>,
    );
    act(() => open("team-box"));

    mocks.listed = true;
    mocks.sandboxes = [
      row("team-box", {
        environmentId: "env-acme",
        burst: false,
        state: "suspended",
      }),
    ];
    rerender(
      <>
        <Opener />
        <SandboxesSettingsPanel />
      </>,
    );

    expect(useSandboxesPageStore.getState().configurationId).toEqual({
      kind: "team",
      teamId: "team-1",
    });
    expect(rowOf("team-box").className).toContain("bg-info/10");
  });

  it("says No sandboxes yet. when the configuration has none", () => {
    renderPanel([]);
    expect(screen.getByTestId("sandboxes-empty").textContent).toContain(
      "No sandboxes yet.",
    );
  });

  it("stages this configuration's New sandbox row on the landing composer from New task, creating nothing", () => {
    useStagedSandboxStore.setState({ bySurface: {} });
    mocks.catalogue = CATALOGUE;
    renderPanel([]);

    fireEvent.click(screen.getByRole("button", { name: "New task" }));

    const stage = readStagedSandbox("landing:window-test");
    expect(stage?.phase).toBe("staged");
    expect(stage?.target).toMatchObject({
      kind: "new",
      configuration: { kind: "personal" },
      shape: { os: "linux", cpus: 2, memoryMb: 4096, region: "us-east" },
    });
    useStagedSandboxStore.setState({ bySurface: {} });
  });
});
