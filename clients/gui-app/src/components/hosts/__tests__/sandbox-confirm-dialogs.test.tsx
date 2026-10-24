import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SandboxSessionReport } from "@/lib/sandboxes/sandbox-row-lines";
import type {
  SandboxBatchResult,
  SandboxDestroyBatchRequest,
} from "@/hooks/sandboxes/use-sandbox-destroy-batch-mutation";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const mocks = vi.hoisted(() => ({
  report: { kind: "unknown" } as SandboxSessionReport,
  destroyMutate: vi.fn<(variables: undefined, options: object) => void>(),
  batch: {
    data: undefined as readonly SandboxBatchResult[] | undefined,
    isPending: false,
    mutate: vi.fn<(request: SandboxDestroyBatchRequest) => void>(),
    reset: vi.fn(),
  },
}));

vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxSessionReport: () => ({ report: mocks.report, failed: false }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-configurations", () => ({
  useSandboxConfigurations: () => ({
    configurations: [{ kind: "personal" }],
    teamEnvironmentIds: new Set<string>(),
    complete: true,
  }),
  sandboxConfigurationOf: () => ({ kind: "personal" }),
  useSandboxWakeString: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-destroy-batch-mutation", () => ({
  useSandboxDestroyBatch: () => mocks.batch,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-destroy-mutation", () => ({
  useSandboxDestroy: () => ({
    isPending: false,
    mutate: mocks.destroyMutate,
  }),
}));

import {
  SandboxDestroyAllIdleDialog,
  SandboxDestroyDialog,
  SandboxStopDialog,
  SandboxSuspendDialog,
} from "@/components/hosts/sandbox-confirm-dialogs";

const NAME = "build-box";
const SANDBOX = sandboxSummaryFixture({ displayName: NAME, state: "awake" });

function sessionsLine(): string {
  return screen.getByTestId("sandbox-confirm-sessions-line").textContent;
}

describe("sandbox confirm dialogs", () => {
  beforeEach(() => {
    mocks.report = { kind: "unknown" };
    mocks.destroyMutate.mockReset();
    mocks.batch.data = undefined;
    mocks.batch.mutate.mockReset();
  });
  afterEach(() => cleanup());

  it("says how many sessions are running, with the caption", () => {
    mocks.report = { kind: "live", count: 3, busy: true };
    render(
      <SandboxSuspendDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />,
    );
    expect(sessionsLine()).toBe("3 sessions running");
    expect(
      screen.getByTestId("sandbox-confirm-sessions").textContent,
    ).toContain("Other sessions may also be interrupted.");
  });

  it("says 1 session running in the singular", () => {
    mocks.report = { kind: "live", count: 1, busy: false };
    render(<SandboxStopDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />);
    expect(sessionsLine()).toBe("1 session running");
  });

  it("says the count is unknown, never a zero, when no report is held", () => {
    render(
      <SandboxSuspendDialog sandbox={SANDBOX} open onOpenChange={vi.fn()} />,
    );
    expect(sessionsLine()).toBe("Sessions unknown · no report yet");
  });

  describe("Destroy", () => {
    function renderDestroy(): void {
      render(
        <SandboxDestroyDialog
          sandbox={SANDBOX}
          open
          onOpenChange={vi.fn()}
          onDestroyed={null}
        />,
      );
    }

    it("names the live count in the outcome sentence", () => {
      mocks.report = { kind: "live", count: 2, busy: true };
      renderDestroy();
      expect(
        screen.getByTestId("confirm-destructive-dialog").textContent,
      ).toContain("Destroying ends 2 running sessions.");
    });

    it("says every running session ends when the count is unknown", () => {
      renderDestroy();
      expect(
        screen.getByTestId("confirm-destructive-dialog").textContent,
      ).toContain("Destroying ends every running session.");
    });

    it("keeps Destroy disabled until the typed name matches", () => {
      renderDestroy();
      const confirm = screen.getByTestId("confirm-action");
      const input = screen.getByTestId("sandbox-confirm-destroy-typed");
      expect(confirm.hasAttribute("disabled")).toBe(true);

      fireEvent.change(input, { target: { value: "build" } });
      expect(confirm.hasAttribute("disabled")).toBe(true);
      fireEvent.click(confirm);
      expect(mocks.destroyMutate).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: ` ${NAME} ` } });
      expect(confirm.hasAttribute("disabled")).toBe(false);
      fireEvent.click(confirm);
      expect(mocks.destroyMutate).toHaveBeenCalledTimes(1);
    });
  });
  it("keeps the confirmed set in Destroy all idle once the list drops the destroyed rows", () => {
    const targets = [
      { sandboxId: "sbx-a", name: "box-a" },
      { sandboxId: "sbx-b", name: "box-b" },
    ];
    const dialog = (live: typeof targets) => (
      <SandboxDestroyAllIdleDialog targets={live} open onOpenChange={vi.fn()} />
    );
    const { rerender } = render(dialog(targets));
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(mocks.batch.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ targets }),
    );

    // While the batch runs the list refetches without the destroyed row.
    rerender(dialog([targets[1]]));
    const card = screen.getByTestId("confirm-destructive-dialog").textContent;
    expect(card).toContain("Destroy 2 idle agent sandboxes?");
    expect(card).toContain("box-a");

    mocks.batch.data = [
      { ...targets[0], outcome: { kind: "destroyed" } },
      { ...targets[1], outcome: { kind: "failed", message: "busy" } },
    ];
    rerender(dialog([]));
    expect(
      screen.getByTestId("confirm-destructive-dialog").textContent,
    ).toContain("Destroy 2 idle agent sandboxes?");
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(mocks.batch.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ targets }),
    );
  });
});
