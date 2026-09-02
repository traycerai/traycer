import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { SweepWorktreesFlow } from "@/components/epics/sweep-worktrees-flow";

/**
 * Multi-host Sweep's host DECISION - the flow's half of it.
 *
 * Three properties carry the design, and each is asserted against the CLIENT
 * rather than against copy: at one dialable host nothing about Sweep changes;
 * with a fleet the confirmation opens immediately on the surface's own host
 * and merely CARRIES the choice (there is no step in front of it any more);
 * and once somebody switches, the confirmation is handed that host's client,
 * identified by the host it addresses.
 *
 * The chip itself lives inside the dialog and is exercised against the real
 * dialog in `sweep-host-chip.test.tsx`. Here the dialog is a capture, so these
 * cases can say exactly which client and which choice it received without a
 * census, a proof or a popover in the way.
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

interface CapturedHostChoice {
  readonly hostId: string | null;
  readonly unavailableHostId: string | null;
  readonly onSwitch: (hostId: string) => void;
}

const captured = vi.hoisted<{
  dialog: {
    epicIds: readonly string[] | null;
    hostClient: { getActiveHostId: () => string | null } | null;
    hostChoice: CapturedHostChoice | null;
    fleetPending: boolean;
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

vi.mock("@/components/epics/sweep-worktrees-dialog", () => ({
  SweepWorktreesDialog: (props: {
    readonly epicIds: readonly string[] | null;
    readonly hostClient: { getActiveHostId: () => string | null } | null;
    readonly hostChoice: CapturedHostChoice | null;
    readonly fleetPending: boolean;
  }) => {
    captured.dialog.push({
      epicIds: props.epicIds,
      hostClient: props.hostClient,
      hostChoice: props.hostChoice,
      fleetPending: props.fleetPending,
    });
    return null;
  },
}));

interface SurfaceHost {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
}

/** Where the surface is pointed before anything moves it. */
const SURFACE_ON_A: SurfaceHost = {
  client: SURFACE_CLIENT,
  hostId: "host-a",
};

function flow() {
  return flowOn(SURFACE_ON_A);
}

/**
 * The same flow with the SURFACE's own host spelled out, because History's is
 * live: it hands this flow the app-wide effective-host follower, which
 * re-renders with a different machine's client the moment selection fails
 * over. A fixture that could only hold those props still would have made every
 * "never re-pointed" case here pass for the wrong reason.
 */
function flowOn(surface: SurfaceHost) {
  return (
    <SweepWorktreesFlow
      epicIds={["epic-1"]}
      surfaceHostClient={surface.client}
      surfaceHostId={surface.hostId}
      taskTitle="Ship it"
      onOpenChange={() => undefined}
    />
  );
}

function lastOpenDialog() {
  const opened = captured.dialog.filter((call) => call.epicIds !== null);
  const last = opened.at(-1);
  if (last === undefined) throw new Error("the sweep dialog never opened");
  return last;
}

function lastOpenDialogHostId(): string | null {
  return lastOpenDialog().hostClient?.getActiveHostId() ?? null;
}

function lastHostChoice(): CapturedHostChoice {
  const choice = lastOpenDialog().hostChoice;
  if (choice === null) throw new Error("the dialog carried no host choice");
  return choice;
}

function switchTo(hostId: string): void {
  const { onSwitch } = lastHostChoice();
  act(() => {
    onSwitch(hostId);
  });
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

  it("carries no host choice and sweeps on the surface's own client at one dialable host", () => {
    render(flow());

    // The confirmation opened immediately, on the object the surface passed -
    // not on a client this flow re-resolved from a host id - and with no host
    // control at all, which is what makes the single-host header byte-identical.
    const opened = captured.dialog.filter((call) => call.epicIds !== null);
    expect(opened.length).toBeGreaterThan(0);
    for (const call of opened) {
      expect(call.hostClient).toBe(SURFACE_CLIENT);
      expect(call.hostChoice).toBeNull();
    }
  });

  it("opens the confirmation straight away on the surface's host once a second host is dialable", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    render(flow());

    // The landing step is gone: the census a person needs in order to answer
    // "which host" is on screen in the same gesture that used to only ask.
    expect(lastOpenDialog().hostClient).toBe(SURFACE_CLIENT);
    const choice = lastHostChoice();
    expect(choice.hostId).toBe("host-a");
    expect(choice.unavailableHostId).toBeNull();
  });

  it("hands the confirmation the SWITCHED host's client, not the surface's", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    render(flow());

    switchTo("host-b");

    expect(lastOpenDialogHostId()).toBe("host-b");
    expect(lastHostChoice().hostId).toBe("host-b");
  });

  it("undoes a pick whose client cannot be built, rather than showing an empty census", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    // The gesture and the refusal in one step: the popover row was enabled
    // because this same seam answered for it a render ago, and by the time the
    // pick is resolved the host is gone - deregistered, or its lease released.
    state.unresolvableHostIds = ["host-b"];
    render(flow());
    switchTo("host-b");

    // Handing the dialog a null client instead would have painted an empty
    // census - "no worktrees here" is a claim about that machine's disk we
    // never got to make. The gesture is undone and named instead.
    expect(lastOpenDialog().hostClient).toBe(SURFACE_CLIENT);
    expect(lastOpenDialog().epicIds).not.toBeNull();
    expect(lastHostChoice().hostId).toBe("host-a");
    expect(lastHostChoice().unavailableHostId).toBe("host-b");
  });

  it("undoes ONE step, to the host you were looking at rather than to the surface", () => {
    state.connectableHostIds = ["host-a", "host-b", "host-c"];
    render(flow());
    switchTo("host-b");
    expect(lastOpenDialogHostId()).toBe("host-b");

    state.unresolvableHostIds = ["host-c"];
    switchTo("host-c");

    // "Previous" means the host this person was last looking at, not wherever
    // the surface happens to point.
    expect(lastOpenDialogHostId()).toBe("host-b");
    expect(lastHostChoice().unavailableHostId).toBe("host-c");
  });

  it("HOLDS a settled host that later goes unreachable, rather than re-pointing", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    const view = render(flow());
    switchTo("host-b");
    expect(lastOpenDialogHostId()).toBe("host-b");

    // host-b has been the answer for a while - proven, maybe part-way through
    // Review - and NOW leaves the directory. That is the fleet plane, not a
    // failed gesture, and undoing a gesture nobody just made would hand a live
    // confirmation another machine's worktrees.
    state.unresolvableHostIds = ["host-b"];
    view.rerender(flow());

    expect(lastHostChoice().hostId).toBe("host-b");
    // No client, so the dialog says it cannot reach the host it is on. What it
    // must NOT do is quietly become host-a's dialog.
    expect(lastOpenDialog().hostClient).toBeNull();
    // The inline chip error belongs to a REFUSED PICK; nobody picked here.
    expect(lastHostChoice().unavailableHostId).toBeNull();
  });

  it("clears a stale unavailable host once another switch lands", () => {
    state.connectableHostIds = ["host-a", "host-b", "host-c"];
    state.unresolvableHostIds = ["host-b"];
    render(flow());
    switchTo("host-b");
    expect(lastHostChoice().unavailableHostId).toBe("host-b");

    state.unresolvableHostIds = [];
    switchTo("host-c");

    // The error names a host the person is no longer trying to reach.
    expect(lastHostChoice().unavailableHostId).toBeNull();
    expect(lastOpenDialogHostId()).toBe("host-c");
  });

  it("does not follow the SURFACE's own host when it fails over mid-dialog", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    const view = render(flow());
    expect(lastOpenDialog().hostClient).toBe(SURFACE_CLIENT);

    // History hands this flow the app-wide effective-host FOLLOWER. host-a
    // dies, selection fails over, and the surface props now describe host-b.
    // Reading them would move the dialog's session key and discard a proof
    // somebody may already have reviewed - with no gesture from anybody.
    view.rerender(
      flowOn({
        client: clientAddressing("host-b"),
        hostId: "host-b",
      }),
    );

    expect(lastOpenDialogHostId()).toBe("host-a");
    expect(lastHostChoice().hostId).toBe("host-a");
  });

  it("still follows the surface's client where there was no choice to latch", () => {
    // The single-host path is the one we promised not to touch: no chip, and
    // the surface's own object for the life of the dialog, whatever it is.
    const movedClient = clientAddressing("host-z");
    const view = render(flow());
    expect(lastOpenDialog().hostClient).toBe(SURFACE_CLIENT);

    view.rerender(flowOn({ client: movedClient, hostId: "host-z" }));

    expect(lastOpenDialog().hostClient).toBe(movedClient);
    expect(lastOpenDialog().hostChoice).toBeNull();
  });

  it("opens UNCHOSEN when the surface cannot name its host, rather than waiting invisibly", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    const view = render(flowOn({ client: SURFACE_CLIENT, hostId: null }));

    // Every caller arms its own "sweep is open" state and disarms it from
    // `onOpenChange`, so rendering nothing here would leave the request armed
    // with no dialog to cancel - permanently, if the effective host never
    // recovers. The dialog opens and ASKS instead.
    expect(lastOpenDialog().epicIds).not.toBeNull();
    expect(lastHostChoice().hostId).toBeNull();
    // And it censuses nothing until it is answered: a null client is the only
    // honest one here, where the app-wide follower would walk whichever
    // machine the window happens to be on.
    expect(lastOpenDialog().hostClient).toBeNull();

    view.rerender(flow());

    // Adopting the id when it lands is the latch arriving late, not a
    // re-point: it is the same host the surface was always on, and nothing had
    // been invested in the meantime.
    expect(lastHostChoice().hostId).toBe("host-a");
    expect(lastOpenDialog().hostClient).toBe(SURFACE_CLIENT);
  });

  it("lets a person's own pick beat a surface id that lands afterwards", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    const view = render(flowOn({ client: SURFACE_CLIENT, hostId: null }));
    switchTo("host-b");
    expect(lastOpenDialogHostId()).toBe("host-b");

    // The window finds its host a moment later. Adopting it now would answer a
    // question the person has already answered.
    view.rerender(flow());

    expect(lastOpenDialogHostId()).toBe("host-b");
    expect(lastHostChoice().hostId).toBe("host-b");
  });

  it("stays unchosen after a failed pick rather than quietly answering for you", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    state.unresolvableHostIds = ["host-b"];
    const view = render(flowOn({ client: SURFACE_CLIENT, hostId: null }));
    switchTo("host-b");
    expect(lastHostChoice().hostId).toBeNull();
    expect(lastHostChoice().unavailableHostId).toBe("host-b");

    // The chip is saying "couldn't reach Studio — choose another host". Taking
    // the surface's id now would contradict that sentence while it is on
    // screen, and start a census nobody asked for.
    view.rerender(flow());

    expect(lastHostChoice().hostId).toBeNull();
    expect(lastOpenDialog().hostClient).toBeNull();
  });

  it("does not make a one-host fleet wait on an id it has no use for", () => {
    // There is no choice to latch here, so an unresolved surface id is not in
    // the way of anything - and delaying this dialog would buy nothing.
    render(flowOn({ client: SURFACE_CLIENT, hostId: null }));

    expect(lastOpenDialog().hostChoice).toBeNull();
    expect(lastOpenDialog().hostClient).toBe(SURFACE_CLIENT);
  });

  it("opens PENDING, deciding nothing, before the directory has answered", () => {
    state.connectableHostIds = [];
    state.resolved = false;
    render(flow());

    // An unanswered directory is not a one-host fleet, so nothing is decided -
    // but the dialog still opens, because a click that renders nothing arms
    // the caller with no way to see or cancel what it armed.
    expect(lastOpenDialog().epicIds).not.toBeNull();
    expect(lastOpenDialog().fleetPending).toBe(true);
    // No host, and therefore no census: the app-wide follower would otherwise
    // walk whichever machine the window is on while the dialog says it has
    // not started.
    expect(lastOpenDialog().hostClient).toBeNull();
    // And no chip - not even "Choose a host". We do not yet know whether this
    // account HAS a choice, and flashing a chooser at a single-host install
    // is the byte-identical promise broken for the length of a query.
    expect(lastOpenDialog().hostChoice).toBeNull();
  });

  it("resolves a pending fleet of one host onto the surface, never showing a chooser", () => {
    state.connectableHostIds = [];
    state.resolved = false;
    const view = render(flow());
    expect(lastOpenDialog().fleetPending).toBe(true);

    state.connectableHostIds = ["host-a"];
    state.resolved = true;
    view.rerender(flow());

    expect(lastOpenDialog().fleetPending).toBe(false);
    expect(lastOpenDialog().hostClient).toBe(SURFACE_CLIENT);
    // Nothing was invested while pending, so this transition re-points
    // nothing - and a chip never appeared at any point.
    for (const call of captured.dialog) expect(call.hostChoice).toBeNull();
  });

  it("resolves a pending fleet of several hosts into the choice", () => {
    state.connectableHostIds = [];
    state.resolved = false;
    const view = render(flow());

    state.connectableHostIds = ["host-a", "host-b"];
    state.resolved = true;
    view.rerender(flow());

    expect(lastOpenDialog().fleetPending).toBe(false);
    expect(lastHostChoice().hostId).toBe("host-a");
    expect(lastOpenDialog().hostClient).toBe(SURFACE_CLIENT);
  });

  it("keeps an open confirmation pointed at its host when the fleet collapses", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    const view = render(flow());
    switchTo("host-b");
    expect(lastOpenDialogHostId()).toBe("host-b");

    // host-b dies mid-confirmation. Sweep's host id is frozen from the proof
    // that dialog already ran, so re-deriving the host here would re-point a
    // LIVE dialog at another machine.
    state.connectableHostIds = ["host-a"];
    view.rerender(flow());

    expect(lastOpenDialogHostId()).toBe("host-b");
    // And the chip does not vanish underneath it either: whether a person was
    // OFFERED a choice is latched with the choice itself.
    expect(lastHostChoice().hostId).toBe("host-b");
  });

  it("re-opens on the surface's host rather than resuming the last swept one", () => {
    state.connectableHostIds = ["host-a", "host-b"];
    const view = render(flow());
    switchTo("host-b");
    expect(lastOpenDialogHostId()).toBe("host-b");

    // Closing and re-opening on the same Task. "Which host did I sweep last
    // time" is not a preference worth remembering over a destructive action.
    view.rerender(
      <SweepWorktreesFlow
        epicIds={null}
        surfaceHostClient={SURFACE_CLIENT}
        surfaceHostId="host-a"
        taskTitle="Ship it"
        onOpenChange={() => undefined}
      />,
    );
    view.rerender(flow());

    expect(lastOpenDialog().hostClient).toBe(SURFACE_CLIENT);
    expect(lastHostChoice().hostId).toBe("host-a");
  });
});
