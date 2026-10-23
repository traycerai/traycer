import { useSandboxesPageStore } from "@/stores/sandboxes/sandboxes-page-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type {
  SandboxCatalogue,
  SandboxCatalogueProvider,
} from "@traycer/protocol/host/sandbox-control";
import {
  useSandboxStaging,
  type SandboxStaging,
} from "@/components/composer/use-sandbox-staging";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type {
  HostScopeOption,
  HostScopeSandbox,
} from "@/components/settings/host-scope/host-scope-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import type { StageShape } from "@/lib/sandboxes/sandbox-stage-model";
import { WAKE_STRING_MEMORY } from "@/lib/sandboxes/sandbox-strings";
import { useSandboxShapeMemoryStore } from "@/stores/composer/sandbox-shape-memory-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import { useAuthStore } from "@/stores/auth/auth-store";

const mocks = vi.hoisted(() => ({
  user: null as AuthenticatedUser | null,
  catalogue: null as SandboxCatalogue | null,
  openSettings: vi.fn<(opts: { readonly section: string | null }) => void>(),
}));

vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: mocks.user }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: mocks.catalogue }),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
}));

const SURFACE = "landing:window-test";
const MEMORY_HOST = "laptop";

const PROVIDER: SandboxCatalogueProvider = {
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
};

const CATALOGUE: SandboxCatalogue = { providers: [PROVIDER] };

const DEFAULT_SHAPE: StageShape = {
  os: "linux",
  cpus: 2,
  memoryMb: 4096,
  diskMb: null,
  region: "us-east",
  idleMinutes: 30,
  destroyAfterRestingMinutes: 10_080,
};

function teamOwnedItem(): HostListItem {
  return {
    hostId: "team-box",
    displayName: "team-box",
    platform: "linux",
    kind: "sandbox",
    publicKey: "pk",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: null,
    },
    owner: { kind: "team", id: "team-1", name: "acme" },
  };
}

function sandboxHost(
  hostId: string,
  sandbox: Partial<HostScopeSandbox> & Pick<HostScopeSandbox, "state">,
  item: HostListItem | null,
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    name: hostId,
    isLocalMachine: false,
    isActive: false,
    connectable: sandbox.state === "awake",
    kind: "sandbox",
    item,
    sandbox: {
      frozen: false,
      summary: sandboxSummaryFixture({ id: `sbx-${hostId}`, hostId }),
      teamOwned: item !== null,
      ...sandbox,
    },
  });
}

const LAPTOP = hostScopeOptionFixture({ hostId: MEMORY_HOST, name: "Laptop" });
const SUSPENDED = sandboxHost("box-suspended", { state: "suspended" }, null);
const STOPPED = sandboxHost("box-stopped", { state: "stopped" }, null);
const AWAKE = sandboxHost("box-awake", { state: "awake" }, null);
const FROZEN = sandboxHost(
  "box-frozen",
  { state: "suspended", frozen: true },
  null,
);
const TEAM_SUSPENDED = sandboxHost(
  "team-box",
  { state: "suspended" },
  teamOwnedItem(),
);

let latest: SandboxStaging | null = null;

function Harness(props: {
  readonly surfaceKey: string | null;
  readonly hosts: readonly HostScopeOption[];
}) {
  const result = useSandboxStaging({
    surface:
      props.surfaceKey === null
        ? null
        : { surfaceKey: props.surfaceKey, task: null },
    memoryHostId: MEMORY_HOST,
    hosts: props.hosts,
  });
  useEffect(() => {
    latest = result;
  }, [result]);
  return null;
}

function mount(hosts: readonly HostScopeOption[]): SandboxStaging {
  render(<Harness surfaceKey={SURFACE} hosts={hosts} />);
  return staging();
}

function staging(): SandboxStaging {
  if (latest === null) throw new Error("the surface staged nothing");
  return latest;
}

beforeEach(() => {
  localStorage.clear();
  mocks.user = userWith(
    userSubscription({
      totalPlanCredits: 1_000,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 0,
    }),
    [teamSubscription(1_000)],
  );
  mocks.catalogue = CATALOGUE;
  mocks.openSettings.mockClear();
  useStagedSandboxStore.setState({ bySurface: {} });
  useSandboxShapeMemoryStore.setState({
    byHost: {},
    lastConfigurationByHost: {},
  });
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "u1", username: "ada" },
  });
  latest = null;
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
});

describe("useSandboxStaging New rows", () => {
  it("offers Personal then each team, with the shape, price and whose credits", () => {
    const { composer } = mount([LAPTOP]);

    expect(composer.newRows.map((row) => row.configurationKey)).toEqual([
      "personal",
      "team-1",
    ]);
    expect(composer.newRows[0]).toMatchObject({
      label: "New Personal sandbox",
      configurationName: "Personal",
    });
    expect(composer.newRows[1].label).toBe("New acme sandbox");
    expect(composer.newRows[1].subLine).toContain("uses your acme credits");
    expect(composer.newRows[0].subLine).toContain("2 vCPU");
  });

  it("stages a new sandbox in the default shape and remembers the configuration", () => {
    const { composer } = mount([LAPTOP]);

    act(() => composer.onPickNew("personal"));

    const stage = readStagedSandbox(SURFACE);
    expect(stage).toMatchObject({
      phase: "staged",
      clientRequestId: null,
      target: {
        kind: "new",
        configuration: { kind: "personal" },
        shape: DEFAULT_SHAPE,
        name: "",
        wakeString: WAKE_STRING_MEMORY,
      },
    });
    expect(
      useSandboxShapeMemoryStore.getState().lastConfigurationByHost[
        MEMORY_HOST
      ],
    ).toBe("personal");
    expect(staging().composer.stagedConfigurationKey).toBe("personal");
  });

  it("stages the remembered shape of that configuration", () => {
    const remembered: StageShape = {
      ...DEFAULT_SHAPE,
      cpus: 4,
      memoryMb: 8192,
    };
    useSandboxShapeMemoryStore
      .getState()
      .remember(MEMORY_HOST, "team-1", remembered);
    const { composer } = mount([LAPTOP]);

    act(() => composer.onPickNew("team-1"));

    expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
      kind: "new",
      configuration: { kind: "team", teamId: "team-1", teamName: "acme" },
      shape: remembered,
    });
    expect(staging().composer.rememberedConfigurationKey).toBe("team-1");
  });

  it("falls back to the default when the remembered region is no longer offered", () => {
    useSandboxShapeMemoryStore.getState().remember(MEMORY_HOST, "personal", {
      ...DEFAULT_SHAPE,
      region: "eu-west",
    });
    const { composer } = mount([LAPTOP]);

    act(() => composer.onPickNew("personal"));

    expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
      shape: DEFAULT_SHAPE,
    });
  });

  it("stages nothing while the catalogue has not answered", () => {
    mocks.catalogue = null;
    const { composer } = mount([LAPTOP]);

    act(() => composer.onPickNew("personal"));

    expect(readStagedSandbox(SURFACE)).toBeNull();
  });

  it("reads the staged chip, and needs credits at a short balance", () => {
    mocks.user = userWith(
      userSubscription({
        totalPlanCredits: 0,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [],
    );
    const { composer } = mount([LAPTOP]);
    expect(composer.newRows[0].label).toBe(
      "New Personal sandbox · needs credits",
    );

    act(() => composer.onPickNew("personal"));

    expect(staging().consequences).toMatchObject({
      configuration: { kind: "personal" },
      needsCredits: true,
      audience: "private",
    });
  });

  it("tells a team sandbox on the landing composer as shared", () => {
    const { composer } = mount([LAPTOP]);

    act(() => composer.onPickNew("team-1"));

    expect(staging().consequences).toMatchObject({
      configuration: { kind: "team", teamId: "team-1", teamName: "acme" },
      audience: "shared",
      price: { awakeMcPerHour: 120, exact: false },
    });
  });
});

describe("useSandboxStaging host picks", () => {
  it("stages a suspended sandbox of the person's to resume, with no create", () => {
    const { composer } = mount([LAPTOP, SUSPENDED]);

    act(() => composer.onPickHost(SUSPENDED));

    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "staged",
      clientRequestId: null,
      target: {
        kind: "existing",
        hostId: "box-suspended",
        sandboxId: "sbx-box-suspended",
        name: "box-suspended",
        configuration: { kind: "personal" },
        verb: "resume",
      },
    });
    expect(staging().composer.stagedLabel).toContain("suspended");
  });

  it("stages a stopped sandbox to start", () => {
    const { composer } = mount([LAPTOP, STOPPED]);

    act(() => composer.onPickHost(STOPPED));

    expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
      kind: "existing",
      verb: "start",
    });
    expect(staging().composer.stagedLabel).toContain("stopped");
  });

  it("stages a team's sandbox under its team", () => {
    const { composer } = mount([LAPTOP, TEAM_SUSPENDED]);

    act(() => composer.onPickHost(TEAM_SUSPENDED));

    expect(readStagedSandbox(SURFACE)?.target).toMatchObject({
      kind: "existing",
      configuration: { kind: "team", teamId: "team-1", teamName: "acme" },
    });
  });

  it.each([
    ["a personal computer", LAPTOP],
    ["an awake sandbox", AWAKE],
    ["a frozen sandbox", FROZEN],
  ])("clears the stage when %s is picked", (_name, host) => {
    const { composer } = mount([LAPTOP, AWAKE, FROZEN, SUSPENDED]);
    act(() => composer.onPickNew("personal"));
    expect(readStagedSandbox(SURFACE)).not.toBeNull();

    act(() => staging().composer.onPickHost(host));

    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(staging().composer.stagedLabel).toBeNull();
  });

  it("replaces a staged new sandbox with the resting one picked after it", () => {
    const { composer } = mount([LAPTOP, SUSPENDED]);
    act(() => composer.onPickNew("personal"));

    act(() => staging().composer.onPickHost(SUSPENDED));

    expect(readStagedSandbox(SURFACE)?.target.kind).toBe("existing");
  });
});

describe("useSandboxStaging surfaces", () => {
  it("stages nothing for a picker that is not a composer's", () => {
    render(<Harness surfaceKey={null} hosts={[LAPTOP]} />);
    expect(latest).toBeNull();
  });

  it("opens Settings › Sandboxes on Personal when nothing is staged", () => {
    useSandboxesPageStore.setState({
      configurationId: { kind: "team", teamId: "stale-team" },
    });
    const { composer } = mount([LAPTOP]);

    composer.onManage();

    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    expect(mocks.openSettings.mock.calls[0][0].section).toBe("sandboxes");
    expect(useSandboxesPageStore.getState().configurationId).toEqual({
      kind: "personal",
    });
  });

  it("opens Settings › Sandboxes on the staged configuration", () => {
    mount([LAPTOP, TEAM_SUSPENDED]);
    act(() => staging().composer.onPickHost(TEAM_SUSPENDED));
    const staged = readStagedSandbox(SURFACE)?.target.configuration;
    if (staged?.kind !== "team") throw new Error("expected a team stage");

    act(() => staging().composer.onManage());

    expect(mocks.openSettings.mock.calls[0][0].section).toBe("sandboxes");
    expect(useSandboxesPageStore.getState().configurationId).toEqual({
      kind: "team",
      teamId: staged.teamId,
    });
  });
});
