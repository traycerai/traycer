import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { environmentStatusResponseSchemaV11 } from "@traycer/protocol/host/environment-schemas";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { SandboxDetailsDrawerHost } from "@/components/hosts/sandbox-details-drawer";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";
import { SANDBOX_LIST_FAILED } from "@/lib/sandboxes/sandbox-strings";
import {
  closeSandboxDetails,
  openSandboxDetails,
} from "@/stores/sandboxes/sandbox-details-store";

const list = vi.hoisted(() => ({
  refetch: vi.fn(() => Promise.resolve()),
  sandboxes: undefined as readonly SandboxSummary[] | undefined,
  delivered: undefined as EnvironmentStatusResponse | undefined,
}));

// By default the list read failed: no data, and the query says so.
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data:
      list.sandboxes === undefined ? undefined : { sandboxes: list.sandboxes },
    isError: list.sandboxes === undefined,
    isFetching: false,
    refetch: list.refetch,
  }),
}));

// The sections around Settings delivery read the host, the cloud and the
// mutation cache; none of them is what this suite is about.
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: undefined }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-operation", () => ({
  useSandboxOperation: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-configurations", () => ({
  useSandboxConfigurations: () => ({ complete: false, configurations: [] }),
  sandboxConfigurationOf: () => null,
  useSandboxWakeString: () => null,
}));

vi.mock("@/hooks/sandboxes/use-sandbox-settings-status", () => ({
  useSandboxSettingsStatus: () => ({ data: list.delivered }),
}));

afterEach(() => {
  list.sandboxes = undefined;
  list.delivered = undefined;
  act(() => {
    closeSandboxDetails();
  });
  cleanup();
});

describe("<SandboxDetailsDrawerHost />", () => {
  it("says a failed list read failed and reads it again on Retry, instead of loading for ever", () => {
    render(<SandboxDetailsDrawerHost />);
    act(() => {
      openSandboxDetails("sbx-1");
    });

    expect(screen.getByText(SANDBOX_LIST_FAILED)).toBeDefined();
    expect(screen.queryByText("Loading this sandbox's details…")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(list.refetch).toHaveBeenCalledTimes(1);
  });

  it("lists an agent once however many keys are stored for it, in the order reported", () => {
    const unusedKey = (key: string) => ({
      kind: "env_override",
      key,
      os: "any",
      desiredRevision: 3,
      status: "not_used",
      code: "ok",
      args: { exitStatus: null, stage: null, durationMs: null, kind: null },
      brokerEnforced: null,
      minimumHostVersion: null,
      appliedAs: null,
    });
    list.sandboxes = [sandboxSummaryFixture({ id: "sbx-1", state: "awake" })];
    list.delivered = environmentStatusResponseSchemaV11.parse({
      principal: { kind: "personal" },
      reachability: "connected",
      bindingGeneration: 1,
      desiredRevision: 5,
      receivedRevision: 5,
      appliedRevision: 5,
      receiptAgeMs: 0,
      remoteAccess: "on",
      pendingUploads: [],
      setup: null,
      items: [
        unusedKey("claude:KEY_ONE"),
        unusedKey("codex:KEY_ONE"),
        unusedKey("claude:KEY_TWO"),
        unusedKey("claude:KEY_THREE"),
      ],
    });
    render(<SandboxDetailsDrawerHost />);
    act(() => {
      openSandboxDetails("sbx-1");
    });

    const section = screen.getByTestId("sandbox-details-settings-delivery");
    expect(
      Array.from(section.querySelectorAll("li"), (row) => row.textContent),
    ).toEqual([
      "Claude Code key · not used on sandboxes",
      "Codex key · not used on sandboxes",
    ]);
  });
});
