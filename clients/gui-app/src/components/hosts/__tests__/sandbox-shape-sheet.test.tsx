import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  SandboxShapeRung,
} from "@traycer/protocol/host/sandbox-control";
import { SandboxShapeSheet } from "@/components/hosts/sandbox-shape-sheet";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import {
  USE_THIS_SHAPE,
  CHANGE_LABEL,
  idleAndRestingLine,
} from "@/lib/sandboxes/sandbox-strings";

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
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: authUser }),
}));
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

afterEach(() => {
  cleanup();
  catalogueInUse = CATALOGUE;
  authUser = null;
});

function renderSheet(onUseShape: Mock) {
  return render(
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
      context={{ audience: "private", reachHost: null, unmovedComputer: null }}
      onUseShape={onUseShape}
    />,
  );
}

describe("<SandboxShapeSheet />", () => {
  it("says a cleared resting period keeps the sandbox, not the period it opened with", () => {
    render(
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
      render(
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
  it("offers a provider's listed shapes in one Size list with the default selected", () => {
    catalogueInUse = catalogueWithShapes();
    renderSheet(vi.fn());

    expect(screen.queryByTestId("sandbox-shape-sheet-cpus")).toBeNull();
    expect(screen.queryByTestId("sandbox-shape-sheet-memory")).toBeNull();
    expect(screen.queryByTestId("sandbox-shape-sheet-disk")).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Size" }).textContent,
    ).toContain("2 vCPU · 4 GB · 20 GB");
  });

  it("opens on the configuration's defaults, shape and periods, when the person has no pick", () => {
    catalogueInUse = catalogueWithShapes();
    render(
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
    ).toContain("4 vCPU · 8 GB · 40 GB");
    expect(screen.getByText(idleAndRestingLine(2, 120))).toBeDefined();
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
            provider: "daytona",
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
      expect(size.textContent).toContain("2 vCPU · 8 GB · 20 GB");
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
      render(
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
            provider: "daytona",
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
      render(
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
        "Your acme allowance is short $0.21. $0.21 more starts this sandbox for an hour.",
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
});
