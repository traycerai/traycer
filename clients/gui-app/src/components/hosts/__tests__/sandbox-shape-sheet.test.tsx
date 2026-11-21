import { sandboxReadinessLine } from "@/lib/sandboxes/sandbox-readiness";
import {
  durationSentence,
  READY_SENTENCE,
  readinessCatalogue,
  servedMinutes,
} from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";
import {
  AUTO_SIZING_RUNGS,
  autoSizingAlternateRegion,
  autoSizingCatalogue,
  autoSizingCatalogueWithRegions,
  autoSizingListedNoRatesCatalogue,
  autoSizingScalarNoRatesCatalogue,
} from "@/lib/sandboxes/__tests__/sandbox-auto-sizing-fixture";
import type {
  StageConfiguration,
  StageShape,
  StageSize,
} from "@/lib/sandboxes/sandbox-stage-model";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderWithQueryClient } from "@/components/composer/__tests__/composer-query-wrapper";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  SandboxShapeRung,
} from "@traycer/protocol/host/sandbox-control";
import { SandboxShapeSheet } from "@/components/hosts/sandbox-shape-sheet";
import { expectFocusRingInset } from "@/components/ui/__tests__/dialog-scroll-layout-assertions";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import {
  shortPriceLabel,
  SANDBOXES_CANT_BE_CREATED,
  USE_THIS_SHAPE,
  CHANGE_LABEL,
  idleAndRestingLine,
} from "@/lib/sandboxes/sandbox-strings";

const WINDOWS_SANDBOX_LIMITATION =
  "Windows sandboxes have no desktop or Computer Use.";

const CATALOGUE: SandboxCatalogue = {
  providers: [
    {
      provider: "firecracker",
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
        diskStepMb: 1024,
        diskMaxMb: 102400,
        diskDefaultMb: 20480,
      },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      shapes: null,
      dockerInGuest: true,
      creatable: true,
      notCreatableReason: null,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: { awakeMc: 80, suspendedMc: 4, stoppedMc: 2 },
          pricing: null,
        },
      ],
    },
  ],
};

let catalogueInUse: SandboxCatalogue = CATALOGUE;
const SETTLED = { isSuccess: true, isFetching: false };
let readinessState = SETTLED;
/** Every shape the sheet has asked the readiness query about, in render order. */
let readinessAsked: (StageSize | null)[] = [];
let authUser: AuthenticatedUser | null = null;

const GIB = 1024;
const LADDER: readonly SandboxShapeRung[] = [
  { cpus: 1, memoryMb: GIB, diskMb: 10 * GIB, default: false },
  { cpus: 2, memoryMb: 4 * GIB, diskMb: 20 * GIB, default: true },
  { cpus: 4, memoryMb: 8 * GIB, diskMb: 40 * GIB, default: false },
];

function catalogueWithShapes(): SandboxCatalogue {
  const [provider] = CATALOGUE.providers;
  return { providers: [{ ...provider, shapes: LADDER }] };
}

vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    isPending: false,
    isError: false,
    data: catalogueInUse,
  }),
}));
// The query's state is a case's to set; its data is the sentence the
// catalogue in use reads as, as the real hook's select would answer. The
// sheet's own guard on that state is what each case observes.
vi.mock("@/hooks/sandboxes/use-sandbox-get-readiness-query", () => ({
  useSandboxGetReadiness: (
    _configuration: StageConfiguration | null,
    shape: StageSize | null,
  ) => {
    readinessAsked.push(shape);
    return {
      isSuccess: readinessState.isSuccess,
      isFetching: readinessState.isFetching,
      data: sandboxReadinessLine(catalogueInUse, shape),
    };
  },
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: authUser }),
}));
// A team not named here is unknown, which is never short.
const teamBalancesMc = vi.hoisted(() => new Map<string, number>());
vi.mock(
  "@/hooks/sandboxes/use-team-bundle-balances",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-team-bundle-balances")
    >()),
    useTeamBundleBalances: () => (teamId: string) =>
      teamBalancesMc.get(teamId) ?? null,
  }),
);
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

afterEach(() => {
  cleanup();
  catalogueInUse = CATALOGUE;
  readinessState = SETTLED;
  readinessAsked = [];
  authUser = null;
  teamBalancesMc.clear();
});

function renderSheet(onUseShape: Mock) {
  return renderSheetWithInitialShape(onUseShape, {
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: null,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: 10_080,
  });
}

function renderSheetWithInitialShape(
  onUseShape: Mock,
  initialShape: StageShape,
) {
  return renderWithQueryClient(
    <SandboxShapeSheet
      open
      onOpenChange={() => undefined}
      configuration={{ kind: "personal" }}
      defaults={null}
      initialShape={initialShape}
      initialName=""
      context={{ audience: "private", reachHost: null, unmovedComputer: null }}
      onUseShape={onUseShape}
    />,
  );
}

function mixedLadderCatalogue(
  fixedDiskGb: number,
  providerDefaultDiskGb: number,
): SandboxCatalogue {
  const base = autoSizingCatalogue();
  const [provider] = base.providers;
  const [growingRung, fixedCandidate] = AUTO_SIZING_RUNGS;
  const fixedRung: SandboxShapeRung = {
    cpus: fixedCandidate.cpus,
    memoryMb: fixedCandidate.memoryMb,
    diskMb: fixedDiskGb * GIB,
    default: false,
  };
  return {
    ...base,
    providers: [
      {
        ...provider,
        shape: {
          ...provider.shape,
          diskDefaultMb: providerDefaultDiskGb * GIB,
        },
        shapes: [growingRung, fixedRung],
      },
    ],
  };
}

describe("<SandboxShapeSheet />", () => {
  const SERVED_MS = servedMinutes(7);

  /** This file's provider carrying the readiness and duration a server would serve. */
  function servedReadiness(input: {
    readonly warm: number | null;
    readonly coldCreateMeasuredMs: number | null | undefined;
  }): SandboxCatalogue {
    const [served] = readinessCatalogue(input).providers;
    const [provider] = CATALOGUE.providers;
    return {
      providers: [
        {
          ...provider,
          ...(served.coldCreateMeasuredMs === undefined
            ? {}
            : { coldCreateMeasuredMs: served.coldCreateMeasuredMs }),
          readiness: served.readiness,
        },
      ],
    };
  }

  it.each([
    { warm: 2, measured: SERVED_MS, text: READY_SENTENCE },
    { warm: 0, measured: SERVED_MS, text: durationSentence(SERVED_MS) },
    { warm: null, measured: SERVED_MS, text: durationSentence(SERVED_MS) },
    { warm: 0, measured: null, text: null },
    { warm: 0, measured: undefined, text: null },
  ])(
    "renders the sentence a served warm count $warm and duration $measured read as",
    ({ warm, measured, text }) => {
      catalogueInUse = servedReadiness({
        warm,
        coldCreateMeasuredMs: measured,
      });
      renderSheet(vi.fn());
      const line = screen.queryByTestId("sandbox-shape-sheet-readiness");
      if (text === null) expect(line).toBeNull();
      else expect(line?.textContent).toBe(text);
    },
  );

  it.each([
    { name: "refetching", state: { isSuccess: true, isFetching: true } },
    {
      name: "errored on its last read",
      state: { isSuccess: false, isFetching: false },
    },
  ])(
    "shows no readiness while the query is $name, though it still holds a sentence",
    ({ state }) => {
      catalogueInUse = servedReadiness({
        warm: 2,
        coldCreateMeasuredMs: SERVED_MS,
      });
      readinessState = state;
      renderSheet(vi.fn());
      expect(screen.queryByTestId("sandbox-shape-sheet-readiness")).toBeNull();
    },
  );

  it("renders all three billed hourly rates for the selected shape", () => {
    const [provider] = CATALOGUE.providers;
    catalogueInUse = {
      providers: [
        {
          ...provider,
          regions: [
            {
              ...provider.regions[0],
              pricing: {
                vcpuHourMillicredits: 50,
                memoryGbHourMillicredits: 25,
                diskGbHourMillicredits: 0.5,
                suspendedMemoryGbHourMillicredits: 30,
                awakeDiskGbHourMillicredits: 2,
                multiplier: 1.25,
              },
            },
          ],
        },
      ],
    };
    renderSheet(vi.fn());
    const price = screen.getByTestId("sandbox-shape-sheet-price");
    expect(price.textContent).toContain("$0.30 an hour while awake");
    expect(price.textContent).toContain(
      `Suspended: ${shortPriceLabel(163)} · Stopped: ${shortPriceLabel(13)}`,
    );
  });

  it("labels resting rates as From when older pricing only quotes the smallest shape", () => {
    renderSheet(vi.fn());
    expect(
      screen.getByTestId("sandbox-shape-sheet-price").textContent,
    ).toContain(
      `From Suspended: ${shortPriceLabel(4)} · Stopped: ${shortPriceLabel(2)}`,
    );
  });

  it("insets focusable controls inside the shape form scroll area", () => {
    renderSheet(vi.fn());

    const scroller = screen
      .getByTestId("sandbox-shape-sheet")
      .querySelector("div.overflow-y-auto");
    if (scroller === null) throw new Error("expected the shape form scroller");
    expectFocusRingInset(scroller, ["-m-1", "p-1"]);
  });

  it("says a cleared resting period keeps the sandbox, not the period it opened with", () => {
    renderWithQueryClient(
      <SandboxShapeSheet
        open
        onOpenChange={() => undefined}
        configuration={{ kind: "personal" }}
        defaults={null}
        initialShape={{
          os: "linux",
          cpus: 2,
          memoryMb: 4096,
          diskMb: null,
          region: "us-east",
          idleMinutes: 30,
          destroyAfterRestingMinutes: 10_080,
        }}
        initialName=""
        context={{
          audience: "private",
          reachHost: null,
          unmovedComputer: null,
        }}
        onUseShape={() => undefined}
      />,
    );
    expect(screen.getByText(idleAndRestingLine(30, 10_080))).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: CHANGE_LABEL }));
    expect(
      screen.getByText("Destroyed after suspended or stopped for"),
    ).toBeDefined();
    fireEvent.change(screen.getByTestId("sandbox-shape-sheet-resting"), {
      target: { value: "" },
    });

    expect(screen.getByText(idleAndRestingLine(30, null))).toBeDefined();
  });
  it("introduces the sheet the same way for Personal and a team", () => {
    const intro = "Used for this sandbox and remembered for your next one.";
    for (const configuration of [
      { kind: "personal" },
      { kind: "team", teamId: "team-1", teamName: "Acme" },
    ] as const) {
      renderWithQueryClient(
        <SandboxShapeSheet
          open
          onOpenChange={() => undefined}
          configuration={configuration}
          defaults={null}
          initialShape={null}
          initialName=""
          context={{
            audience: "private",
            reachHost: null,
            unmovedComputer: null,
          }}
          onUseShape={() => undefined}
        />,
      );
      expect(
        document.getElementById(
          screen.getByRole("dialog").getAttribute("aria-describedby") ?? "",
        )?.textContent,
      ).toBe(intro);
      cleanup();
    }
  });

  it("does not describe empty-catalogue guidance as a remembered choice", () => {
    catalogueInUse = { providers: [] };
    renderSheet(vi.fn());

    expect(screen.getByText(SANDBOXES_CANT_BE_CREATED)).toBeDefined();
    expect(
      screen.queryByText(
        "Used for this sandbox and remembered for your next one.",
      ),
    ).toBeNull();
  });

  it("offers a provider's listed shapes in one Size list with the default selected", () => {
    catalogueInUse = catalogueWithShapes();
    renderSheet(vi.fn());

    expect(screen.queryByTestId("sandbox-shape-sheet-cpus")).toBeNull();
    expect(screen.queryByTestId("sandbox-shape-sheet-memory")).toBeNull();
    expect(screen.queryByTestId("sandbox-shape-sheet-disk")).toBeNull();
    const size = screen.getByRole("combobox", { name: "Size" });
    expect(size.textContent).toContain("2 vCPU · 4 GB · 20 GB · from $0.08/h");
    expect(size.textContent).not.toContain("Suspend keeps memory");
    expect(screen.getByText("Suspend keeps memory")).toBeTruthy();
    fireEvent.click(size);
    expect(
      screen.getByRole("option", { name: /1 vCPU · 1 GB · 10 GB/ }).textContent,
    ).toContain("$0.08/h");
    expect(
      screen.getByRole("option", { name: /1 vCPU · 1 GB · 10 GB/ }).textContent,
    ).not.toContain("from ");
    expect(
      screen.getByRole("option", { name: /4 vCPU · 8 GB · 40 GB/ }).textContent,
    ).toContain("from $0.08/h");
  });

  it("shows growing Linux starts and their disk-based prices, keeping a chosen disk across sizes", () => {
    catalogueInUse = autoSizingCatalogue();
    const onUseShape = vi.fn();
    renderSheet(onUseShape);

    const disk = screen.getByRole("spinbutton", { name: "Disk (GB)" });
    if (!(disk instanceof HTMLInputElement)) {
      throw new Error("Expected Disk (GB) to be an input");
    }
    expect(disk.getAttribute("min")).toBe("10");
    expect(disk.getAttribute("max")).toBe("200");
    expect(disk.getAttribute("step")).toBe("1");
    expect(disk.value).toBe("50");

    const size = screen.getByRole("combobox", { name: "Size" });
    expect(size.textContent).toContain(
      "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.14–$1.44/h",
    );
    expect(
      screen.getByTestId("sandbox-shape-sheet-resting-price").textContent,
    ).toBe("Suspended: $0.01/h · Stopped: $0.01/h");
    fireEvent.click(size);
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.14–$1.44/h",
      "4 vCPU · 8 GB, grows to 16 vCPU · 64 GB · $0.26–$1.44/h",
      "8 vCPU · 16 GB, grows to 16 vCPU · 64 GB · $0.52–$1.44/h",
      "8 vCPU · 32 GB, grows to 16 vCPU · 64 GB · $0.73–$1.44/h",
      "16 vCPU · 32 GB, grows to 16 vCPU · 64 GB · $1.03–$1.44/h",
      "16 vCPU · 64 GB · $1.44/h",
    ]);

    fireEvent.change(disk, { target: { value: "200" } });
    expect(
      screen.getByRole("option", {
        name: "4 vCPU · 8 GB, grows to 16 vCPU · 64 GB · $0.28–$1.47/h",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "16 vCPU · 64 GB · $1.47/h" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("option", {
        name: "4 vCPU · 8 GB, grows to 16 vCPU · 64 GB · $0.28–$1.47/h",
      }),
    );
    expect(disk.value).toBe("200");

    fireEvent.change(disk, { target: { value: "30" } });
    expect(disk.value).toBe("30");
    expect(
      screen.getByTestId("sandbox-shape-sheet-price").textContent,
    ).toContain("$0.26–$1.44 an hour while awake");
    fireEvent.click(screen.getByRole("button", { name: USE_THIS_SHAPE }));
    expect(onUseShape.mock.calls[0]?.[0]).toMatchObject({
      cpus: 4,
      memoryMb: 8 * GIB,
      diskMb: 30 * GIB,
    });
  });

  it("keeps the growing rung's 50 GB disk when the provider default is 60 GB", () => {
    const base = autoSizingCatalogue();
    const [provider] = base.providers;
    catalogueInUse = {
      ...base,
      providers: [
        {
          ...provider,
          shape: { ...provider.shape, diskDefaultMb: 60 * GIB },
        },
      ],
    };
    renderSheet(vi.fn());

    const disk = screen.getByRole("spinbutton", { name: "Disk (GB)" });
    if (!(disk instanceof HTMLInputElement)) {
      throw new Error("Expected Disk (GB) to be an input");
    }
    expect(disk.value).toBe("50");
    fireEvent.click(screen.getByRole("combobox", { name: "Size" }));
    expect(
      screen.getByRole("option", {
        name: "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.14–$1.44/h",
      }).textContent,
    ).toBe("2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.14–$1.44/h");
  });

  it("keeps a chosen growing disk through a fixed rung and back", () => {
    catalogueInUse = mixedLadderCatalogue(50, 50);
    const onUseShape = vi.fn();
    renderSheet(onUseShape);

    const useShape = screen.getByRole("button", { name: USE_THIS_SHAPE });
    const startingDisk = screen.getByRole("spinbutton", { name: "Disk (GB)" });
    if (!(startingDisk instanceof HTMLInputElement)) {
      throw new Error("Expected Disk (GB) to be an input");
    }
    fireEvent.change(startingDisk, { target: { value: "30" } });
    fireEvent.blur(startingDisk);
    const chosenDisk = screen.getByRole("spinbutton", { name: "Disk (GB)" });
    if (!(chosenDisk instanceof HTMLInputElement)) {
      throw new Error("Expected Disk (GB) to be an input");
    }
    expect(chosenDisk.value).toBe("30");
    expect(useShape.hasAttribute("disabled")).toBe(false);
    fireEvent.click(useShape);
    expect(onUseShape.mock.calls[0]?.[0]).toMatchObject({
      cpus: 2,
      memoryMb: 4 * GIB,
      diskMb: 30 * GIB,
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Size" }));
    fireEvent.click(
      screen.getByRole("option", { name: /4 vCPU · 8 GB · 50 GB/ }),
    );
    expect(screen.queryByRole("spinbutton", { name: "Disk (GB)" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(useShape.hasAttribute("disabled")).toBe(false);
    fireEvent.click(useShape);
    expect(onUseShape.mock.calls[1]?.[0]).toMatchObject({
      cpus: 4,
      memoryMb: 8 * GIB,
      diskMb: 50 * GIB,
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Size" }));
    const restoredGrowingOption = screen.getByRole("option", {
      name: "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.13–$1.44/h",
    });
    fireEvent.click(restoredGrowingOption);
    const restoredDisk = screen.getByRole("spinbutton", { name: "Disk (GB)" });
    if (!(restoredDisk instanceof HTMLInputElement)) {
      throw new Error("Expected Disk (GB) to be an input");
    }
    expect(restoredDisk.value).toBe("30");
    expect(useShape.hasAttribute("disabled")).toBe(false);
    fireEvent.click(useShape);
    expect(onUseShape.mock.calls[2]?.[0]).toMatchObject({
      cpus: 2,
      memoryMb: 4 * GIB,
      diskMb: 30 * GIB,
    });
  });

  it("uses the growing rung's disk when switching from fixed without a saved growing disk", () => {
    catalogueInUse = mixedLadderCatalogue(60, 70);
    const onUseShape = vi.fn();
    renderSheetWithInitialShape(onUseShape, {
      os: "linux",
      cpus: 4,
      memoryMb: 8 * GIB,
      diskMb: 60 * GIB,
      region: "us-east",
      idleMinutes: 30,
      destroyAfterRestingMinutes: 10_080,
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Size" }));
    const defaultGrowingOption = screen.getByRole("option", {
      name: "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.14–$1.44/h",
    });
    fireEvent.click(defaultGrowingOption);
    const disk = screen.getByRole("spinbutton", { name: "Disk (GB)" });
    if (!(disk instanceof HTMLInputElement)) {
      throw new Error("Expected Disk (GB) to be an input");
    }
    expect(disk.value).toBe("50");
    const useShape = screen.getByRole("button", { name: USE_THIS_SHAPE });
    expect(useShape.hasAttribute("disabled")).toBe(false);
    fireEvent.click(useShape);
    expect(onUseShape.mock.calls[0]?.[0]).toMatchObject({
      cpus: 2,
      memoryMb: 4 * GIB,
      diskMb: 50 * GIB,
    });
  });

  it("prices a selected nonfirst region from its unit rates", () => {
    const [provider] = autoSizingCatalogue().providers;
    const [east] = provider.regions;
    catalogueInUse = autoSizingCatalogueWithRegions([
      east,
      autoSizingAlternateRegion(),
    ]);
    renderSheet(vi.fn());

    fireEvent.click(screen.getByRole("combobox", { name: "Sandbox region" }));
    fireEvent.click(screen.getByRole("option", { name: "US West" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Size" }));
    expect(
      screen.getByRole("option", {
        name: "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.15–$1.61/h",
      }).textContent,
    ).toBe("2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.15–$1.61/h");
    expect(
      screen.getByRole("option", {
        name: "4 vCPU · 8 GB, grows to 16 vCPU · 64 GB · $0.29–$1.61/h",
      }).textContent,
    ).toBe("4 vCPU · 8 GB, grows to 16 vCPU · 64 GB · $0.29–$1.61/h");
  });

  function expectNoRatesDiskQuote(
    catalogue: SandboxCatalogue,
    listedText: string,
  ): void {
    catalogueInUse = catalogue;
    renderSheet(vi.fn());

    const disk = screen.getByRole("spinbutton", { name: "Disk (GB)" });
    if (!(disk instanceof HTMLInputElement)) {
      throw new Error("Expected Disk (GB) to be an input");
    }
    fireEvent.click(screen.getByRole("combobox", { name: "Size" }));
    expect(screen.getByRole("option", { name: listedText }).textContent).toBe(
      listedText,
    );

    fireEvent.change(disk, { target: { value: "30" } });
    const unpricedText = "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB";
    expect(screen.getByRole("option", { name: unpricedText }).textContent).toBe(
      unpricedText,
    );
  }

  it("shows a listed no-rates offer at 50 GB and no price for an unlisted 30 GB disk", () => {
    expectNoRatesDiskQuote(
      autoSizingListedNoRatesCatalogue(),
      "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.14–$1.50/h",
    );
  });

  it("shows a scalar exact no-rates quote at 50 GB and no price at 30 GB", () => {
    expectNoRatesDiskQuote(
      autoSizingScalarNoRatesCatalogue(),
      "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.14/h",
    );
  });

  function expectDiskInput(
    diskGb: string,
    min: number,
    max: number,
    pricedLabel: string | null,
  ): void {
    const base = autoSizingCatalogue();
    const [provider] = base.providers;
    catalogueInUse = {
      ...base,
      providers: [
        {
          ...provider,
          shape: {
            ...provider.shape,
            diskMinMb: min * GIB,
            diskMaxMb: max * GIB,
            diskDefaultMb: 50 * GIB,
          },
        },
      ],
    };
    renderSheet(vi.fn());

    const disk = screen.getByRole("spinbutton", { name: "Disk (GB)" });
    if (!(disk instanceof HTMLInputElement)) {
      throw new Error("Expected Disk (GB) to be an input");
    }
    expect(disk.getAttribute("min")).toBe(String(min));
    expect(disk.getAttribute("max")).toBe(String(max));
    fireEvent.change(disk, { target: { value: diskGb } });
    const problemLine = screen.queryByTestId("sandbox-shape-sheet-problem");
    if (pricedLabel === null) {
      expect(problemLine?.textContent).toBe(
        `Disk must be between ${min} and ${max} GB.`,
      );
    } else {
      expect(problemLine).toBeNull();
    }
    fireEvent.click(screen.getByRole("combobox", { name: "Size" }));

    if (pricedLabel === null) {
      const labels = screen
        .getAllByRole("option")
        .map((option) => option.textContent);
      for (const label of labels) expect(label).not.toContain("/h");
    } else {
      expect(
        screen.getByRole("option", { name: pricedLabel }).textContent,
      ).toBe(pricedLabel);
    }
  }

  it.each(["5", "", "201", "30.5"])(
    "names the disk bounds and omits growing option rates when the disk input is invalid (%s GB)",
    (diskGb) => {
      expectDiskInput(diskGb, 10, 200, null);
    },
  );

  it.each([
    {
      diskGb: "19",
      pricedLabel: null,
    },
    {
      diskGb: "101",
      pricedLabel: null,
    },
    {
      diskGb: "20",
      pricedLabel: "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.13–$1.44/h",
    },
    {
      diskGb: "100",
      pricedLabel: "2 vCPU · 4 GB, grows to 16 vCPU · 64 GB · $0.14–$1.45/h",
    },
  ])(
    "uses narrower catalogue disk bounds for $diskGb GB",
    ({ diskGb, pricedLabel }) => {
      expectDiskInput(diskGb, 20, 100, pricedLabel);
    },
  );

  it("leaves a size string alone when that rung is smaller than the catalogue's source shape", () => {
    const [provider] = CATALOGUE.providers;
    catalogueInUse = {
      providers: [
        {
          ...provider,
          shapes: [
            { cpus: 4, memoryMb: 8 * GIB, diskMb: 40 * GIB, default: false },
            { cpus: 2, memoryMb: 4 * GIB, diskMb: 20 * GIB, default: true },
          ],
        },
      ],
    };
    renderSheet(vi.fn());

    const size = screen.getByRole("combobox", { name: "Size" });
    expect(size.textContent).toContain("2 vCPU · 4 GB · 20 GB");
    expect(size.textContent).not.toContain("$");
    expect(size.textContent).not.toContain("Suspend keeps memory");
    expect(screen.getByText("Suspend keeps memory")).toBeTruthy();
    fireEvent.click(size);
    expect(
      screen.getByRole("option", { name: /4 vCPU · 8 GB · 40 GB/ }).textContent,
    ).toContain("$0.08/h");
    expect(
      screen.getByRole("option", { name: /2 vCPU · 4 GB · 20 GB/ }).textContent,
    ).not.toContain("$");
  });

  it("opens on the configuration's defaults, shape and periods, when the person has no pick", () => {
    catalogueInUse = catalogueWithShapes();
    renderWithQueryClient(
      <SandboxShapeSheet
        open
        onOpenChange={() => undefined}
        configuration={{ kind: "personal" }}
        defaults={{
          os: "linux",
          cpus: 4,
          memoryMb: 8 * GIB,
          diskMb: 40 * GIB,
          idleMinutes: 2,
          restingMinutes: 120,
        }}
        initialShape={null}
        initialName=""
        context={{
          audience: "private",
          reachHost: null,
          unmovedComputer: null,
        }}
        onUseShape={() => undefined}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Size" }).textContent,
    ).toContain("4 vCPU · 8 GB · 40 GB · from $0.08/h");
    expect(screen.getByText(idleAndRestingLine(2, 120))).toBeDefined();
  });

  it("opens a nondefault rung with unset disk at its own geometry, price and readiness and submits it", () => {
    const [provider] = catalogueWithShapes().providers;
    catalogueInUse = {
      providers: [
        {
          ...provider,
          readiness: {
            request: {
              os: "linux",
              shape: { cpus: 4, memoryMb: 8192, diskMb: 40960 },
              region: "us-east",
              generationId: null,
              launchForm: {
                kind: "template",
                object: "gs://templates/platform-v1/manifest.json",
                digest: "a".repeat(64),
              },
            },
            result: { warm: 2 },
          },
          regions: [
            {
              ...provider.regions[0],
              pricing: {
                vcpuHourMillicredits: 50,
                memoryGbHourMillicredits: 25,
                diskGbHourMillicredits: 1,
                suspendedMemoryGbHourMillicredits: 30,
                awakeDiskGbHourMillicredits: 2,
                multiplier: 1,
              },
            },
          ],
        },
      ],
    };
    const onUseShape = vi.fn();
    renderWithQueryClient(
      <SandboxShapeSheet
        open
        onOpenChange={() => undefined}
        configuration={{ kind: "personal" }}
        defaults={null}
        initialShape={{
          os: "linux",
          cpus: 4,
          memoryMb: 8192,
          diskMb: null,
          region: "us-east",
          idleMinutes: 30,
          destroyAfterRestingMinutes: 120,
        }}
        initialName=""
        context={{
          audience: "private",
          reachHost: null,
          unmovedComputer: null,
        }}
        onUseShape={onUseShape}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Size" }).textContent,
    ).toContain("4 vCPU · 8 GB · 40 GB · $0.48/h");
    expect(
      screen.getByTestId("sandbox-shape-sheet-readiness").textContent,
    ).toBe(READY_SENTENCE);
    expect(
      screen.getByTestId("sandbox-shape-sheet-price").textContent,
    ).toContain("$0.48 an hour while awake");
    const use = screen.getByRole("button", { name: USE_THIS_SHAPE });
    expect(use.hasAttribute("disabled")).toBe(false);
    fireEvent.click(use);
    expect(onUseShape.mock.calls[0]?.[0]).toMatchObject({
      cpus: 4,
      memoryMb: 8192,
      diskMb: 40960,
    });
  });

  it("uses the listed shape that was picked, disk included", () => {
    catalogueInUse = catalogueWithShapes();
    const onUseShape = vi.fn();
    renderSheet(onUseShape);

    fireEvent.click(screen.getByRole("combobox", { name: "Size" }));
    fireEvent.click(
      screen.getByRole("option", { name: /4 vCPU · 8 GB · 40 GB/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: USE_THIS_SHAPE }));

    expect(onUseShape.mock.calls[0]?.[0]).toMatchObject({
      cpus: 4,
      memoryMb: 8 * GIB,
      diskMb: 40 * GIB,
    });
  });

  describe("switching to Windows", () => {
    const WINDOWS_LADDER: readonly SandboxShapeRung[] = [
      { cpus: 1, memoryMb: 4 * GIB, diskMb: 10 * GIB, default: false },
      { cpus: 2, memoryMb: 8 * GIB, diskMb: 20 * GIB, default: true },
    ];

    function withWindowsProvider(): void {
      const [linux] = CATALOGUE.providers;
      catalogueInUse = {
        providers: [
          { ...linux, shapes: LADDER },
          {
            ...linux,
            provider: "gce-windows",
            os: ["windows"],
            shapes: WINDOWS_LADDER,
            regions: [
              {
                id: "us",
                label: "United States",
                fromPriceMcPerHour: {
                  awakeMc: 252,
                  suspendedMc: 4,
                  stoppedMc: 2,
                },
                pricing: {
                  vcpuHourMillicredits: 136.2,
                  memoryGbHourMillicredits: 16.2,
                  diskGbHourMillicredits: 0.108,
                  multiplier: 1.25,
                },
              },
            ],
          },
        ],
      };
      authUser = userWith(
        userSubscription({
          totalPlanCredits: 100,
          consumedFromPlan: 0,
          bonusCredits: 0,
          consumedFromBonus: 0,
          bundleRemaining: 0,
        }),
        [],
      );
    }

    function switchToWindows(): void {
      fireEvent.click(
        screen.getByRole("combobox", { name: "Operating system" }),
      );
      fireEvent.click(screen.getByRole("option", { name: "Windows" }));
    }

    it("keeps the Windows region and size as offered, priced at the billed rate", () => {
      withWindowsProvider();
      renderSheet(vi.fn());

      switchToWindows();

      expect(
        screen.getByRole("combobox", { name: "Sandbox region" }).textContent,
      ).toContain("United States");
      const size = screen.getByRole("combobox", { name: "Size" });
      expect(size.textContent).toContain("2 vCPU · 8 GB · 20 GB · $0.50/h");
      expect(
        screen.getByTestId("sandbox-shape-sheet-price").textContent,
      ).toContain("$0.50 an hour while awake · uses your credits");
      fireEvent.click(size);
      expect(
        screen.getByRole("option", { name: /1 vCPU · 4 GB · 10 GB/ })
          .textContent,
      ).toContain("$0.25/h");
      expect(
        screen.getByRole("option", { name: /2 vCPU · 8 GB · 20 GB/ })
          .textContent,
      ).toContain("$0.50/h");
    });

    it("says Windows has no desktop or Computer Use as soon as Windows is picked, before anything is staged", () => {
      withWindowsProvider();
      const onUseShape = vi.fn();
      renderSheet(onUseShape);
      expect(screen.queryByText(WINDOWS_SANDBOX_LIMITATION)).toBeNull();

      switchToWindows();

      expect(screen.getByText(WINDOWS_SANDBOX_LIMITATION)).toBeDefined();
      expect(onUseShape).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: USE_THIS_SHAPE }));

      expect(onUseShape).toHaveBeenCalledTimes(1);
      expect(onUseShape.mock.calls[0]?.[0]).toMatchObject({ os: "windows" });
    });

    it("drops the Windows limitation again when Linux is picked back", () => {
      withWindowsProvider();
      renderSheet(vi.fn());
      switchToWindows();
      expect(screen.getByText(WINDOWS_SANDBOX_LIMITATION)).toBeDefined();

      fireEvent.click(
        screen.getByRole("combobox", { name: "Operating system" }),
      );
      fireEvent.click(screen.getByRole("option", { name: "Linux" }));

      expect(screen.queryByText(WINDOWS_SANDBOX_LIMITATION)).toBeNull();
    });
  });

  describe("opening on Windows with a staged region", () => {
    function renderWindowsSheet(region: string) {
      const [linux, windows] = catalogueInUse.providers;
      const [us] = windows.regions;
      catalogueInUse = {
        providers: [
          linux,
          {
            ...windows,
            regions: [us, { ...us, id: "eu", label: "Europe" }],
          },
        ],
      };
      renderWithQueryClient(
        <SandboxShapeSheet
          open
          onOpenChange={() => undefined}
          configuration={{ kind: "personal" }}
          defaults={null}
          initialShape={{
            os: "windows",
            cpus: 2,
            memoryMb: 8 * GIB,
            diskMb: 20 * GIB,
            region,
            idleMinutes: 30,
            destroyAfterRestingMinutes: 10_080,
          }}
          initialName=""
          context={{
            audience: "private",
            reachHost: null,
            unmovedComputer: null,
          }}
          onUseShape={() => undefined}
        />,
      );
    }

    function openWithWindowsProvider(region: string): void {
      // Reuse the Windows provider the switch tests build.
      const [linux] = CATALOGUE.providers;
      catalogueInUse = {
        providers: [
          { ...linux, shapes: LADDER },
          {
            ...linux,
            provider: "gce-windows",
            os: ["windows"],
            shapes: [
              {
                cpus: 2,
                memoryMb: 8 * GIB,
                diskMb: 20 * GIB,
                default: true,
              },
            ],
            regions: [
              {
                id: "us",
                label: "United States",
                fromPriceMcPerHour: {
                  awakeMc: 252,
                  suspendedMc: 4,
                  stoppedMc: 2,
                },
                pricing: {
                  vcpuHourMillicredits: 136.2,
                  memoryGbHourMillicredits: 16.2,
                  diskGbHourMillicredits: 0.108,
                  multiplier: 1.25,
                },
              },
            ],
          },
        ],
      };
      authUser = userWith(
        userSubscription({
          totalPlanCredits: 100,
          consumedFromPlan: 0,
          bonusCredits: 0,
          consumedFromBonus: 0,
          bundleRemaining: 0,
        }),
        [],
      );
      renderWindowsSheet(region);
    }

    it("says Windows has no desktop or Computer Use when the sheet opens on Windows", () => {
      openWithWindowsProvider("us");

      expect(screen.getByText(WINDOWS_SANDBOX_LIMITATION)).toBeDefined();
    });

    it("opens with a region selected and a price when the staged region is not offered", () => {
      openWithWindowsProvider("us-east");

      expect(
        screen.getByRole("combobox", { name: "Sandbox region" }).textContent,
      ).not.toBe("");
      expect(
        screen.getByTestId("sandbox-shape-sheet-price").textContent,
      ).toContain("an hour while awake");
    });

    it("keeps a staged region that is offered", () => {
      openWithWindowsProvider("eu");

      expect(
        screen.getByRole("combobox", { name: "Sandbox region" }).textContent,
      ).toContain("Europe");
    });
  });

  describe("price box", () => {
    function withPersonalCredits(totalPlanCredits: number): void {
      authUser = userWith(
        userSubscription({
          totalPlanCredits,
          consumedFromPlan: 0,
          bonusCredits: 0,
          consumedFromBonus: 0,
          bundleRemaining: 0,
        }),
        [],
      );
      catalogueInUse = {
        providers: [
          {
            ...CATALOGUE.providers[0],
            regions: [
              {
                id: "us-east",
                label: "US East",
                fromPriceMcPerHour: {
                  awakeMc: 210,
                  suspendedMc: 4,
                  stoppedMc: 2,
                },
                pricing: null,
              },
            ],
          },
        ],
      };
    }

    it("follows the price clause with Add credits at a short balance", () => {
      withPersonalCredits(0);
      renderSheet(vi.fn());

      const box = screen.getByTestId("sandbox-shape-sheet-price");
      expect(box.textContent).toContain(
        "Not enough credits. $0.21 more starts this sandbox for an hour.",
      );
      const link = within(box).getByTestId("sandbox-shape-sheet-add-credits");
      expect(link.textContent).toBe("Add credits ↗");
    });

    it("asks for the team's credits at a short team balance", () => {
      withPersonalCredits(0);
      teamBalancesMc.set("team-1", 0);
      authUser = {
        ...userWith(
          userSubscription({
            totalPlanCredits: 0,
            consumedFromPlan: 0,
            bonusCredits: 0,
            consumedFromBonus: 0,
            bundleRemaining: 0,
          }),
          [teamSubscription(0)],
        ),
      };
      renderWithQueryClient(
        <SandboxShapeSheet
          open
          onOpenChange={() => undefined}
          configuration={{ kind: "team", teamId: "team-1", teamName: "acme" }}
          defaults={null}
          initialShape={null}
          initialName=""
          context={{
            audience: "private",
            reachHost: null,
            unmovedComputer: null,
          }}
          onUseShape={() => undefined}
        />,
      );

      expect(
        screen.getByTestId("sandbox-shape-sheet-price").textContent,
      ).toContain(
        "acme's credits are short $0.21. $0.21 more starts this sandbox for an hour.",
      );
    });

    it("offers no Add credits when the balance covers the price", () => {
      withPersonalCredits(1_000);
      renderSheet(vi.fn());

      expect(screen.getByTestId("sandbox-shape-sheet-price")).toBeDefined();
      expect(
        screen.queryByTestId("sandbox-shape-sheet-add-credits"),
      ).toBeNull();
    });
  });

  describe("the shape the readiness query is asked about", () => {
    /**
     * The distinct sizes asked about in order; a repeat of the last is one
     * question. The sheet hands over its whole shape, of which only the size
     * is what the query keys on.
     */
    function questions(): StageSize[] {
      const asked: StageSize[] = [];
      for (const shape of readinessAsked) {
        if (shape === null) continue;
        const size: StageSize = {
          os: shape.os,
          region: shape.region,
          cpus: shape.cpus,
          memoryMb: shape.memoryMb,
          diskMb: shape.diskMb,
        };
        const last = asked.at(-1);
        if (last !== undefined && JSON.stringify(last) === JSON.stringify(size))
          continue;
        asked.push(size);
      }
      return asked;
    }

    function type(testId: string, value: string): HTMLElement {
      const input = screen.getByTestId(testId);
      fireEvent.change(input, { target: { value } });
      return input;
    }

    it("asks nothing new while a number is typed, then asks once about the last valid value on blur", () => {
      renderSheet(vi.fn());
      expect(questions().map((shape) => shape.cpus)).toEqual([2]);

      type("sandbox-shape-sheet-cpus", "3");
      const input = type("sandbox-shape-sheet-cpus", "4");

      expect(questions().map((shape) => shape.cpus)).toEqual([2]);
      expect(screen.queryByTestId("sandbox-shape-sheet-readiness")).toBeNull();

      fireEvent.blur(input);

      expect(questions().map((shape) => shape.cpus)).toEqual([2, 4]);
    });

    it("holds readiness while the disk is edited, then asks with the committed disk", () => {
      catalogueInUse = autoSizingCatalogue();
      renderSheet(vi.fn());
      expect(questions().map((shape) => shape.diskMb)).toEqual([50 * GIB]);

      const disk = type("sandbox-shape-sheet-disk", "30");
      expect(questions().map((shape) => shape.diskMb)).toEqual([50 * GIB]);
      expect(screen.queryByTestId("sandbox-shape-sheet-readiness")).toBeNull();

      fireEvent.blur(disk);

      expect(questions().map((shape) => shape.diskMb)).toEqual([
        50 * GIB,
        30 * GIB,
      ]);
    });

    it("asks about a typed number on Enter without a blur", () => {
      renderSheet(vi.fn());

      const input = type("sandbox-shape-sheet-memory", "8");
      expect(questions().map((shape) => shape.memoryMb)).toEqual([4096]);

      fireEvent.keyDown(input, { key: "Enter" });

      expect(questions().map((shape) => shape.memoryMb)).toEqual([4096, 8192]);
    });

    it("asks about a picked region at once", () => {
      const [provider] = CATALOGUE.providers;
      const [us] = provider.regions;
      catalogueInUse = {
        providers: [
          { ...provider, regions: [us, { ...us, id: "eu", label: "Europe" }] },
        ],
      };
      renderSheet(vi.fn());

      fireEvent.click(screen.getByRole("combobox", { name: "Sandbox region" }));
      fireEvent.click(screen.getByRole("option", { name: "Europe" }));

      expect(questions().map((shape) => shape.region)).toEqual([
        "us-east",
        "eu",
      ]);
    });

    it("asks about a picked size at once", () => {
      catalogueInUse = catalogueWithShapes();
      renderSheet(vi.fn());

      fireEvent.click(screen.getByRole("combobox", { name: "Size" }));
      fireEvent.click(
        screen.getByRole("option", { name: /4 vCPU · 8 GB · 40 GB/ }),
      );

      expect(questions().map((shape) => shape.cpus)).toEqual([2, 4]);
    });

    it("asks nothing new when the name or an idle period is edited", () => {
      renderSheet(vi.fn());

      type("sandbox-shape-sheet-name", "My sandbox");
      fireEvent.click(screen.getByRole("button", { name: CHANGE_LABEL }));
      const resting = type("sandbox-shape-sheet-resting", "5");
      fireEvent.blur(resting);

      expect(questions().map((shape) => shape.cpus)).toEqual([2]);
    });
  });
});
