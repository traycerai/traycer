import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type {
  HostScopeOption,
  HostScopeSandbox,
} from "@/components/settings/host-scope/host-scope-model";
import type { SweepHostPickerRow } from "@/components/epics/sweep-host-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

// The list asks each row's own client and count; this suite is about what a
// click does, so both are stubbed to "resolvable" and "not known".
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({}),
}));
vi.mock("@/hooks/epic/use-epic-sweep-host-worktree-count-query", () => ({
  useEpicSweepHostWorktreeCount: () => null,
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHostsPollLiveness: () => undefined,
}));
// The wake is the sandbox-wake suite's concern; here only that a pick asks.
vi.mock("@/lib/sandboxes/sandbox-wake", () => ({
  wakeSandboxOnPick: vi.fn(),
}));

import { SweepHostList } from "@/components/epics/sweep-host-list";
import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";

const onPick = vi.fn<(hostId: string) => void>();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function sandboxOption(
  hostId: string,
  sandbox: Pick<HostScopeSandbox, "state" | "frozen">,
  connectable: boolean,
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    isLocalMachine: false,
    isActive: false,
    connectable,
    kind: "sandbox",
    sandbox: {
      ...sandbox,
      summary: sandboxSummaryFixture({ hostId, burst: false }),
    },
  });
}

const PERSONAL = hostScopeOptionFixture({ hostId: "laptop", name: "Laptop" });
const AWAKE = sandboxOption(
  "sbx-awake",
  { state: "awake", frozen: false },
  true,
);
const SUSPENDED = sandboxOption(
  "sbx-suspended",
  { state: "suspended", frozen: false },
  false,
);
const FROZEN = sandboxOption(
  "sbx-frozen",
  { state: "suspended", frozen: true },
  false,
);

function renderList(hosts: readonly HostScopeOption[]): void {
  const rows: readonly SweepHostPickerRow[] = hosts.map((host) => ({
    host,
    isDefault: host.hostId === PERSONAL.hostId,
  }));
  render(
    <SweepHostList
      rows={rows}
      selectedEpicIds={new Set(["epic-1"])}
      currentHostCount={null}
      isLoading={false}
      listsFailed={false}
      onRetryLists={() => undefined}
      onPick={onPick}
    />,
  );
}

function row(hostId: string): HTMLElement {
  return screen.getByTestId(`sweep-host-option-${hostId}`);
}

describe("<SweepHostList /> picking a row", () => {
  it("asks the wake with the row's host option, then hands the id to the dialog, for a sleeping sandbox", () => {
    renderList([PERSONAL, SUSPENDED]);
    // A sleeping sandbox has no route, yet is a legal `pin` pick.
    expect(row("sbx-suspended").hasAttribute("disabled")).toBe(false);

    fireEvent.click(row("sbx-suspended"));

    expect(wakeSandboxOnPick).toHaveBeenCalledTimes(1);
    expect(wakeSandboxOnPick).toHaveBeenCalledWith(SUSPENDED);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("sbx-suspended");
    // The wake is asked first, so a pick that throws still woke it.
    expect(
      vi.mocked(wakeSandboxOnPick).mock.invocationCallOrder[0],
    ).toBeLessThan(onPick.mock.invocationCallOrder[0]);
  });

  it("asks the wake for an awake sandbox and a personal host too: the wake itself decides, and the id still goes to the dialog", () => {
    renderList([PERSONAL, AWAKE]);

    fireEvent.click(row("sbx-awake"));
    expect(wakeSandboxOnPick).toHaveBeenLastCalledWith(AWAKE);
    expect(onPick).toHaveBeenLastCalledWith("sbx-awake");

    fireEvent.click(row("laptop"));
    expect(wakeSandboxOnPick).toHaveBeenLastCalledWith(PERSONAL);
    expect(onPick).toHaveBeenLastCalledWith("laptop");
    expect(wakeSandboxOnPick).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it("neither wakes nor picks a frozen sandbox: its row is inert", () => {
    renderList([PERSONAL, FROZEN]);
    expect(row("sbx-frozen").hasAttribute("disabled")).toBe(true);

    fireEvent.click(row("sbx-frozen"));

    expect(wakeSandboxOnPick).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });
});
