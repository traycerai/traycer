import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import type { HostSwitcherAction } from "@/components/settings/host-scope/host-switcher";
import type { HostPickIntent } from "@/components/settings/host-scope/host-option-model";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type {
  HostScopeOption,
  HostScopeSandbox,
} from "@/components/settings/host-scope/host-scope-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));

afterEach(cleanup);

function sandboxOption(input: {
  readonly hostId: string;
  readonly name: string;
  readonly sandbox: HostScopeSandbox;
  readonly connectable: boolean;
}): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: input.hostId,
    name: input.name,
    isLocalMachine: false,
    isActive: false,
    connectable: input.connectable,
    kind: "sandbox",
    sandbox: input.sandbox,
  });
}

function listed(
  state: HostScopeSandbox["state"],
  frozen: boolean,
  burst: boolean,
  hostId: string,
): HostScopeSandbox {
  return {
    state,
    frozen,
    summary: sandboxSummaryFixture({
      id: `sbx-${hostId}`,
      hostId,
      state: state ?? "awake",
      frozen,
      burst,
    }),
  };
}

const PERSONAL = hostScopeOptionFixture({
  hostId: "laptop",
  name: "Laptop",
  isActive: true,
});
const AWAKE = sandboxOption({
  hostId: "sbx-awake",
  name: "Awake box",
  connectable: true,
  sandbox: listed("awake", false, false, "sbx-awake"),
});
const FROZEN = sandboxOption({
  hostId: "sbx-frozen",
  name: "Frozen box",
  connectable: false,
  sandbox: listed("suspended", true, false, "sbx-frozen"),
});
const SUSPENDED = sandboxOption({
  hostId: "sbx-suspended",
  name: "Suspended box",
  connectable: false,
  sandbox: listed("suspended", false, false, "sbx-suspended"),
});
const BURST = sandboxOption({
  hostId: "sbx-burst",
  name: "Task box",
  connectable: true,
  sandbox: listed("awake", false, true, "sbx-burst"),
});
const UNKNOWN_BURST = sandboxOption({
  hostId: "sbx-unknown",
  name: "Unanswered box",
  connectable: true,
  sandbox: { state: "awake", frozen: false, summary: null },
});

const PICKER_ACTION: HostSwitcherAction = {
  kind: "manage-hosts",
  onSelect: () => undefined,
};
const HOST_LIST_ACTION: HostSwitcherAction = {
  kind: "add-host",
  onSelect: () => undefined,
};

function renderSwitcher(input: {
  readonly hosts: readonly HostScopeOption[];
  readonly selected: HostScopeOption;
  readonly action: HostSwitcherAction;
  readonly intent: HostPickIntent;
}): void {
  render(
    <HostSwitcher
      refusalByHostId={NO_HOST_OPTION_REFUSALS}
      inertExceptHostId={null}
      hosts={input.hosts}
      selected={input.selected}
      activeHostId={PERSONAL.hostId}
      onSelect={() => undefined}
      action={input.action}
      surface="field"
      intent={input.intent}
      disabled={false}
      isLoading={false}
      listsFailed={false}
      onRetryLists={() => undefined}
      updateViewForHost={null}
    />,
  );
  fireEvent.click(screen.getByTestId("settings-host-switcher"));
}

function row(hostId: string): HTMLElement {
  return screen.getByTestId(`settings-host-switcher-option-${hostId}`);
}

describe("<HostSwitcher /> sandbox grouping", () => {
  it("lists personal hosts, then the user's sandboxes in their own group, and never a burst sandbox in a picker", () => {
    renderSwitcher({
      hosts: [PERSONAL, AWAKE, BURST, UNKNOWN_BURST],
      selected: PERSONAL,
      action: PICKER_ACTION,
      intent: "bind",
    });

    expect(screen.getByText("Host")).toBeDefined();
    const group = screen.getByTestId("settings-host-switcher-sandboxes");
    expect(group.contains(row("sbx-awake"))).toBe(true);
    expect(group.contains(row("laptop"))).toBe(false);
    expect(row("laptop")).toBeDefined();

    // A burst sandbox is for one agent's task: never offered here. A sandbox
    // whose control-plane row has not answered might be burst, so it fails
    // closed too.
    expect(
      screen.queryByTestId("settings-host-switcher-option-sbx-burst"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-option-sbx-unknown"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-agent-sandboxes"),
    ).toBeNull();
  });

  it("keeps the burst sandbox a surface is already pointed at", () => {
    renderSwitcher({
      hosts: [PERSONAL, BURST],
      selected: BURST,
      action: PICKER_ACTION,
      intent: "bind",
    });
    expect(
      screen
        .getByTestId("settings-host-switcher-sandboxes")
        .contains(row("sbx-burst")),
    ).toBe(true);
  });

  it("shows the host list's burst sandboxes in a sub-group that starts collapsed", () => {
    renderSwitcher({
      hosts: [PERSONAL, AWAKE, BURST],
      selected: PERSONAL,
      action: HOST_LIST_ACTION,
      intent: "view",
    });

    const agentGroup = screen.getByTestId(
      "settings-host-switcher-agent-sandboxes",
    );
    expect(agentGroup.textContent).toContain("Agent sandboxes");
    expect(
      screen.queryByTestId("settings-host-switcher-option-sbx-burst"),
    ).toBeNull();
    // The user's own sandbox is open by default.
    expect(row("sbx-awake")).toBeDefined();

    fireEvent.click(
      screen.getByTestId("settings-host-switcher-agent-sandboxes-toggle"),
    );
    expect(agentGroup.contains(row("sbx-burst"))).toBe(true);
  });
});

describe("<HostSwitcher /> sandbox rows", () => {
  it("disables a frozen sandbox where a host must be dialable, and says it is frozen", () => {
    renderSwitcher({
      hosts: [PERSONAL, FROZEN],
      selected: PERSONAL,
      action: PICKER_ACTION,
      intent: "bind",
    });
    expect(row("sbx-frozen").getAttribute("aria-disabled")).toBe("true");
    expect(row("sbx-frozen").textContent).toContain("frozen");
    expect(row("sbx-frozen").textContent).not.toContain("suspended");
  });

  it("speaks the lifecycle word, not 'offline', for a suspended sandbox", () => {
    renderSwitcher({
      hosts: [PERSONAL, SUSPENDED, AWAKE],
      selected: PERSONAL,
      action: PICKER_ACTION,
      intent: "bind",
    });
    expect(row("sbx-suspended").textContent).toContain("suspended");
    expect(row("sbx-suspended").textContent).not.toContain("offline");
    expect(row("sbx-awake").textContent).toContain("awake");
    expect(row("sbx-awake").getAttribute("aria-disabled")).not.toBe("true");
  });

  it("still lets a view surface point at a frozen sandbox, so it can be destroyed", () => {
    renderSwitcher({
      hosts: [PERSONAL, FROZEN],
      selected: PERSONAL,
      action: HOST_LIST_ACTION,
      intent: "view",
    });
    expect(row("sbx-frozen").getAttribute("aria-disabled")).not.toBe("true");
    expect(row("sbx-frozen").textContent).toContain("frozen");
  });

  it("calls a sandbox row a Sandbox to assistive tech", () => {
    renderSwitcher({
      hosts: [PERSONAL, AWAKE],
      selected: PERSONAL,
      action: PICKER_ACTION,
      intent: "bind",
    });
    expect(row("sbx-awake").textContent).toContain("Sandbox");
  });
});
