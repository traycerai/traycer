import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostHealth } from "@/components/settings/host-scope/host-health";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { SweepWorktreesFlow } from "@/components/epics/sweep-worktrees-flow";

/**
 * Multi-host Sweep's host step.
 *
 * Two properties carry the whole design, and both are asserted against the
 * CLIENT rather than against copy: at one dialable host nothing about Sweep
 * changes, and when a host is chosen the confirmation behind the picker is
 * handed that host's client - identified by the host it addresses, never by
 * what the UI happens to say.
 *
 * Built through a typed factory rather than a cast, matching
 * `landing-placement.test.ts`: the ban on `as any` / `as unknown` applies in
 * tests too.
 */
function clientAddressing(hostId: string): HostClient<HostRpcRegistry> {
  const client: Pick<HostClient<HostRpcRegistry>, "getActiveHostId"> = {
    getActiveHostId: () => hostId,
  };
  return client as HostClient<HostRpcRegistry>;
}

const state = vi.hoisted(() => ({
  connectableHostIds: ["host-a"] as readonly string[],
  resolved: true,
  /**
   * Hosts whose client the seam cannot build - the real one answers `null`
   * when the entry stops being dialable or the credential lease goes away.
   */
  unresolvableHostIds: [] as readonly string[],
}));
const captured = vi.hoisted<{
  dialog: {
    epicIds: readonly string[] | null;
    hostClient: { getActiveHostId: () => string | null } | null;
  }[];
}>(() => ({ dialog: [] }));

/** The client the surface already speaks on — Sweep's client before this epic. */
const SURFACE_CLIENT = clientAddressing("host-a");

vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({
    hostIds: state.connectableHostIds,
    resolved: state.resolved,
  }),
}));

// Resolves an explicit id to a client that ADDRESSES it, which is the whole
// contract the real seam holds and the only part these assertions need.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null || state.unresolvableHostIds.includes(hostId)
      ? null
      : { getActiveHostId: () => hostId, resolvedFor: hostId },
}));

vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHostsPollLiveness: () => undefined,
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: hostOptions(),
    activeHostId: "host-a",
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  }),
}));

vi.mock("@/components/epics/sweep-worktrees-dialog", () => ({
  SweepWorktreesDialog: (props: {
    readonly epicIds: readonly string[] | null;
    readonly hostClient: { getActiveHostId: () => string | null } | null;
  }) => {
    captured.dialog.push({
      epicIds: props.epicIds,
      hostClient: props.hostClient,
    });
    return null;
  },
}));

const ONLINE_HEALTH: HostHealth = {
  state: "online",
  label: "Online",
  detail: null,
  tone: "live",
  live: true,
};
const OFFLINE_HEALTH: HostHealth = {
  state: "offline",
  label: "Offline",
  detail: null,
  tone: "idle",
  live: false,
};

function hostOption(input: {
  readonly hostId: string;
  readonly name: string;
  readonly connectable: boolean;
  readonly isLocalMachine: boolean;
}): HostScopeOption {
  return {
    hostId: input.hostId,
    name: input.name,
    isLocalMachine: input.isLocalMachine,
    isActive: input.hostId === "host-a",
    connectable: input.connectable,
    planRestricted: false,
    settingUp: false,
    registered: true,
    platform: null,
    version: null,
    health: input.connectable ? ONLINE_HEALTH : OFFLINE_HEALTH,
    updateState: null,
    entry: null,
    item: null,
  };
}

/**
 * Three hosts, covering every row class the picker must draw at once: the
 * surface's own (unbadged), a dialable one the Task has agents on, and a dead
 * one that must still be LISTED.
 */
function hostOptions(): readonly HostScopeOption[] {
  return [
    hostOption({
      hostId: "host-a",
      name: "Laptop",
      connectable: true,
      isLocalMachine: true,
    }),
    hostOption({
      hostId: "host-b",
      name: "Desktop",
      connectable: true,
      isLocalMachine: false,
    }),
    hostOption({
      hostId: "host-c",
      name: "Retired box",
      connectable: false,
      isLocalMachine: false,
    }),
  ];
}

const NO_OCCUPANCY: ReadonlySet<string> = new Set();

function flow(occupiedHostIds: ReadonlySet<string>) {
  return (
    <SweepWorktreesFlow
      epicIds={["epic-1"]}
      surfaceHostClient={SURFACE_CLIENT}
      surfaceHostId="host-a"
      occupiedHostIds={occupiedHostIds}
      taskTitle="Ship it"
      onOpenChange={() => undefined}
    />
  );
}

function lastOpenDialogHostId(): string | null {
  const opened = captured.dialog.filter((call) => call.epicIds !== null);
  const last = opened.at(-1);
  if (last === undefined) throw new Error("the sweep dialog never opened");
  return last.hostClient?.getActiveHostId() ?? null;
}

function sweepDialogEverOpened(): boolean {
  return captured.dialog.some((call) => call.epicIds !== null);
}

describe("SweepWorktreesFlow", () => {
  beforeEach(() => {
    state.connectableHostIds = ["host-a"];
    state.resolved = true;
    state.unresolvableHostIds = [];
    captured.dialog = [];
  });
  afterEach(() => {
    cleanup();
  });

  it("shows no picker and sweeps on the surface's own client at one dialable host", () => {
    render(flow(NO_OCCUPANCY));

    expect(screen.queryByRole("dialog")).toBeNull();
    // The confirmation opened immediately, on the object the surface passed -
    // not on a client this flow re-resolved from a host id.
    const opened = captured.dialog.filter((call) => call.epicIds !== null);
    expect(opened.length).toBeGreaterThan(0);
    for (const call of opened) expect(call.hostClient).toBe(SURFACE_CLIENT);
  });

  it("asks which host before opening the confirmation once a second host is dialable", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    render(flow(new Set(["host-b"])));

    expect(screen.getByRole("dialog")).toBeTruthy();
    // Nothing is proven or offered until a host is named.
    expect(sweepDialogEverOpened()).toBe(false);
  });

  it("lists every host, badging only the ones the Task's records name", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    render(flow(new Set(["host-b"])));

    // host-c is neither badged nor the default, so it sits behind the
    // disclosure. Expanding is how this asserts completeness - the row exists
    // and is reachable, it is only demoted.
    fireEvent.click(screen.getByRole("button", { name: /Other hosts/ }));

    const rowA = screen.getByRole("button", { name: /Laptop/ });
    const rowB = screen.getByRole("button", { name: /Desktop/ });
    // Listed even though nothing names it and nothing can dial it:
    // completeness is the guarantee, the badge is only a hint.
    const rowC = screen.getByRole("button", { name: /Retired box/ });
    expect(rowA.getAttribute("data-occupied")).toBe("false");
    expect(rowB.getAttribute("data-occupied")).toBe("true");
    expect(rowC.getAttribute("data-occupied")).toBe("false");
    // The surface's current host is marked, never auto-followed.
    expect(rowA.getAttribute("data-default")).toBe("true");
    expect(rowB.getAttribute("data-default")).toBe("false");
    // A host that cannot be dialled is inert - the same verdict every other
    // picker reaches through `isHostOptionSelectable`.
    expect(rowC.hasAttribute("disabled")).toBe(true);
    expect(rowB.hasAttribute("disabled")).toBe(false);
  });

  it("keeps the badged host and the default at the top level, the rest behind one disclosure", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    render(flow(new Set(["host-b"])));

    // Badged (host-b) and default (host-a) are immediately visible; the rest
    // of the fleet is one collapsed row rather than a wall of machines.
    expect(screen.getByRole("button", { name: /Desktop/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Laptop/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retired box/ })).toBeNull();

    const toggle = screen.getByRole("button", { name: /Other hosts/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Other hosts (1)");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Retired box/ })).toBeTruthy();
  });

  it("puts the badged host above the default", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    render(flow(new Set(["host-b"])));

    // The shared picker's own order puts the local machine (host-a) first;
    // the group's claim is that the badge outranks it here.
    // Document order, which is what the claim is about.
    const [first, second] = screen.getAllByRole("button", {
      name: /Laptop|Desktop/,
    });
    expect(first.textContent).toContain("Desktop");
    expect(second.textContent).toContain("Laptop");
  });

  it("renders flat, with no disclosure, when nothing is badged", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    // No badges and no default: collapsing the WHOLE list would be worse than
    // the flat list the disclosure was added to tidy.
    render(
      <SweepWorktreesFlow
        epicIds={["epic-1"]}
        surfaceHostClient={SURFACE_CLIENT}
        surfaceHostId={null}
        occupiedHostIds={NO_OCCUPANCY}
        taskTitle="Ship it"
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: /Other hosts/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Laptop/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Desktop/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retired box/ })).toBeTruthy();
  });

  it("can sweep on a host that only the disclosure lists", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    render(flow(new Set()));

    // The completeness backstop, end to end: the badge signal named nothing,
    // and the machine that actually holds the worktrees is still reachable.
    fireEvent.click(screen.getByRole("button", { name: /Other hosts/ }));
    fireEvent.click(screen.getByRole("button", { name: /Desktop/ }));

    expect(lastOpenDialogHostId()).toBe("host-b");
  });

  it("hands the confirmation the PICKED host's client, not the surface's", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    render(flow(new Set(["host-b"])));

    fireEvent.click(screen.getByRole("button", { name: /Desktop/ }));

    expect(lastOpenDialogHostId()).toBe("host-b");
  });

  it("disables a row whose client cannot be built, rather than looping on it", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    // `connectable` is a directory fact and stays TRUE here: the client fails
    // to build for a reason the route knows nothing about (no request context
    // / no bound user). Without the row asking for itself, the row stays
    // enabled and every click re-enters the same unresolved pick in silence.
    state.unresolvableHostIds = ["host-b"];
    render(flow(new Set(["host-b"])));

    const row = screen.getByRole("button", { name: /Desktop/ });
    expect(row.hasAttribute("disabled")).toBe(true);
    // The refusal is ON the row, so the reason arrives before the click.
    expect(row.textContent).toContain("unavailable");
    // The host that CAN serve is untouched by its neighbour's refusal.
    expect(
      screen.getByRole("button", { name: /Laptop/ }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("keeps asking rather than telling a person there is nothing to sweep", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    // host-b is pickable HERE, so the click really does enter the `picked`
    // phase. Making it unresolvable up front would only prove the row refusal
    // above: the button would be disabled, `onPick` would never fire, and this
    // case would pass without reaching the branch it exists for.
    const view = render(flow(new Set(["host-b"])));
    fireEvent.click(screen.getByRole("button", { name: /Desktop/ }));
    expect(lastOpenDialogHostId()).toBe("host-b");

    // NOW the client stops resolving - the credential lease released, or the
    // entry left the directory - with a confirmation already open on it.
    state.unresolvableHostIds = ["host-b"];
    view.rerender(flow(new Set(["host-b"])));

    // The confirmation would have read the null client as an empty census and
    // said "No worktrees on this host for the selected tasks" - a claim about
    // that machine's disk we never got to make. It withdraws instead (which is
    // not a re-point: no other host's rows are ever shown under that proof),
    // and the question comes back with host-b now refused on its own row.
    expect(captured.dialog.at(-1)?.epicIds ?? null).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Desktop/ }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("does not decide the fleet's shape before the directory has answered", () => {
    state.connectableHostIds = [];
    state.resolved = false;
    render(flow(NO_OCCUPANCY));

    // An unanswered directory is not a one-host fleet: neither step opens,
    // rather than the confirmation quietly taking the single-host path.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sweepDialogEverOpened()).toBe(false);
  });

  it("keeps an open confirmation pointed at its host when the fleet collapses", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    const view = render(flow(new Set(["host-b"])));
    fireEvent.click(screen.getByRole("button", { name: /Desktop/ }));
    expect(lastOpenDialogHostId()).toBe("host-b");

    // host-b dies mid-confirmation. Sweep's host id is frozen from the proof
    // that dialog already ran, so re-deriving the step here would re-point a
    // LIVE dialog at another machine.
    state.connectableHostIds = ["host-a"];
    view.rerender(flow(new Set(["host-b"])));

    expect(lastOpenDialogHostId()).toBe("host-b");
  });
});
