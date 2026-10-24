import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import { SandboxShapeSheet } from "@/components/hosts/sandbox-shape-sheet";
import {
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

vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    isPending: false,
    isError: false,
    data: CATALOGUE,
  }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));

afterEach(cleanup);

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
});
