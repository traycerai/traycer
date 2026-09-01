const convergeMock = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));
vi.mock("@/hooks/runner/use-runner-converge-ready-mutation", () => ({
  useRunnerConvergeReady: () => convergeMock,
}));

const appVersion = vi.hoisted((): { current: string | null } => ({
  current: "1.5.0",
}));
vi.mock("@/lib/app-version", () => ({
  getClientAppVersion: () => appVersion.current,
  getClientAppVersionLabel: () => "v1.5.0",
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { HostUpdateRequiredSlot } from "@/components/settings/panels/host-overview-panel";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * The CONJUNCTION that decides whether Settings offers "Update host": the
 * rendered health state AND the lease's dead reason must agree.
 *
 * Either half alone is wrong in a way a user would see. `health.state` respects
 * the derivation precedence — this machine's own stopped service outranks the
 * authority's verdict — so a local host that is both incompatible and not
 * running reads "Stopped"; a slot keyed on the lease alone would put an
 * "Update host" button beside that word, answering a question the card is not
 * asking. And the lease alone is what carries the structured skew the action
 * needs, which `health` deliberately does not.
 *
 * The store is seeded through the real chain (`applyKernelSnapshot` + `reset`)
 * rather than by mocking `useHostLease`: mutating what a hook EMITS cannot
 * reach a suite that fakes the hook's output, which is exactly how sealed probe
 * P2 measured a coverage separation instead of a defect.
 */

const INCOMPATIBLE: HostLeaseSnapshot = {
  hostId: "host-a",
  status: "dead",
  dead: {
    reason: "incompatible",
    detail: {
      code: "PROTOCOL_MAJOR_MISMATCH",
      hostVersion: "1.1.4",
      minSupportedVersion: "1.2.0",
      clientCompatibility: null,
    },
  },
};

function seedLeases(leases: readonly HostLeaseSnapshot[]): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: "host-a",
    targetHostId: "host-a",
    effectiveHostId: "host-a",
    leases,
    selectionRevision: 1,
  });
}

function renderSlot(options: {
  readonly state: HostHealthState;
  readonly canManageHost?: boolean;
}): void {
  render(
    <HostUpdateRequiredSlot
      host={hostScopeOptionFixture({
        hostId: "host-a",
        name: "Studio Mac",
        isLocalMachine: true,
        health: {
          state: options.state,
          label: "irrelevant to the gate",
          detail: null,
          tone: "warn",
          live: false,
        },
      })}
      canManageHost={options.canManageHost ?? true}
    />,
  );
}

beforeEach(() => {
  convergeMock.mutate = vi.fn();
  convergeMock.isPending = false;
  appVersion.current = "1.5.0";
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
});

describe("<HostUpdateRequiredSlot />", () => {
  it("offers the update when the card says Update required and the lease says incompatible", () => {
    seedLeases([INCOMPATIBLE]);
    renderSlot({ state: "update-required" });

    expect(screen.getByTestId("host-scope-update-host")).not.toBeNull();
  });

  /**
   * The precedence case. The lease still says incompatible — but this machine's
   * own service read outranks it, so the card reads "Stopped", and a remedy for
   * a different problem must not appear beside that word.
   */
  it("withholds the update when a higher-precedence state is what the card shows", () => {
    seedLeases([INCOMPATIBLE]);
    renderSlot({ state: "stopped" });

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });

  it("withholds the update when no lease carries an incompatibility", () => {
    seedLeases([{ hostId: "host-a", status: "ready", dead: null }]);
    renderSlot({ state: "update-required" });

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });

  /**
   * The lease is looked up BY ID. Seeded with another host's incompatibility,
   * this row has no verdict of its own and must not borrow one — the P12 shape,
   * at the surface that would show a button because of it.
   */
  it("does not borrow another host's incompatibility", () => {
    seedLeases([{ ...INCOMPATIBLE, hostId: "host-b" }]);
    renderSlot({ state: "update-required" });

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });

  it("drives the shared converge lane with force, not a lane of its own", () => {
    seedLeases([INCOMPATIBLE]);
    renderSlot({ state: "update-required" });

    fireEvent.click(screen.getByTestId("host-scope-update-host"));

    // `{ force: true }` IS the modal's `forceProvisioning`: same mutation, same
    // `runnerMutationKeys.hostConvergeReady()` key, so P3.1's progress
    // narration already covers a click made from here.
    expect(convergeMock.mutate).toHaveBeenCalledTimes(1);
    expect(convergeMock.mutate.mock.calls[0]?.[0]).toEqual({ force: true });
  });

  it("withholds the update for a machine this app cannot manage", () => {
    seedLeases([INCOMPATIBLE]);
    renderSlot({ state: "update-required", canManageHost: false });

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });
});
