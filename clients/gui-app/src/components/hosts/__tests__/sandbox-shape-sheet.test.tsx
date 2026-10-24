import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  SandboxCatalogue,
  SandboxShapeRung,
} from "@traycer/protocol/host/sandbox-control";
import { SandboxShapeSheet } from "@/components/hosts/sandbox-shape-sheet";
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
  useAuthUser: () => ({ data: null }),
}));

afterEach(() => {
  cleanup();
  catalogueInUse = CATALOGUE;
});

function renderSheet(onUseShape: Mock) {
  return render(
    <SandboxShapeSheet
      open
      onOpenChange={() => undefined}
      configuration={{ kind: "personal" }}
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
});
