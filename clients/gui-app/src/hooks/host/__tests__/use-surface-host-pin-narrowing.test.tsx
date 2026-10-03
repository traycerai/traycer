/**
 * Pins the narrowed `useSurfaceHostPin` selector: an unrelated fleet publish
 * must not re-render, only a real dead/return transition on the pinned host
 * should. Tier-precedence correctness stays owned by `use-surface-host-pin.test.tsx`.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";

const boundary = vi.hoisted(() => ({
  nodeHostIds: new Set<string>(),
  effectiveHostId: "effective-host" as string | null,
}));

vi.mock("@/hooks/epic/use-epic-node-host-ids", () => ({
  useEpicNodeHostIds: () => boundary.nodeHostIds,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => boundary.effectiveHostId,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

import { useSurfaceHostPin } from "@/hooks/host/use-surface-host-pin";
import {
  tabSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

function ready(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "ready", dead: null };
}
function dead(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "dead", dead: { reason: "offline" } };
}

const SURFACE_KEY = tabSurfaceKey("git-diff", "tile-1");

const renders = { count: 0 };
const onRenderProbe: ProfilerOnRenderCallback = () => {
  renders.count += 1;
};

function Probe(): ReactNode {
  const pin = useSurfaceHostPin(SURFACE_KEY);
  return <span data-testid="resolved">{pin.resolvedHostId ?? "none"}</span>;
}

function resolvedText(): string {
  return screen.getByTestId("resolved").textContent;
}

beforeEach(() => {
  boundary.nodeHostIds = new Set();
  boundary.effectiveHostId = "effective-host";
  useSurfaceHostSelectionStore.getState().resetForTests();
  useSelectionAuthorityStore.getState().reset();
  useSurfaceHostSelectionStore
    .getState()
    .setSelection(SURFACE_KEY, "pinned-host");
  useSelectionAuthorityStore.setState({
    attached: true,
    leases: [ready("pinned-host"), ready("unrelated-host")],
  });
  renders.count = 0;
});

afterEach(() => {
  cleanup();
  useSurfaceHostSelectionStore.getState().resetForTests();
  useSelectionAuthorityStore.getState().reset();
});

describe("useSurfaceHostPin render isolation", () => {
  it("ignores an unrelated fleet publish and re-renders only on the pinned host's own dead/return transitions", () => {
    render(
      <Profiler id="probe" onRender={onRenderProbe}>
        <Probe />
      </Profiler>,
    );
    expect(resolvedText()).toBe("pinned-host");
    const afterMount = renders.count;

    // Unrelated hosts changing - no derived primitive moves.
    act(() => {
      useSelectionAuthorityStore.setState({
        leases: [
          ready("pinned-host"),
          ready("unrelated-host"),
          dead("also-unrelated"),
        ],
      });
    });
    expect(renders.count).toBe(afterMount);
    expect(resolvedText()).toBe("pinned-host");

    // Pinned host dies - re-renders, falls back to effective.
    act(() => {
      useSelectionAuthorityStore.setState({
        leases: [dead("pinned-host"), ready("unrelated-host")],
      });
    });
    expect(renders.count).toBeGreaterThan(afterMount);
    expect(resolvedText()).toBe("effective-host");
    const afterDeath = renders.count;

    // Still deposed, unrelated host changing - stays quiet.
    act(() => {
      useSelectionAuthorityStore.setState({
        leases: [dead("pinned-host"), dead("unrelated-host")],
      });
    });
    expect(renders.count).toBe(afterDeath);
    expect(resolvedText()).toBe("effective-host");

    // Pinned host revives - returns to the pin with no user action.
    act(() => {
      useSelectionAuthorityStore.setState({
        leases: [ready("pinned-host"), dead("unrelated-host")],
      });
    });
    expect(renders.count).toBeGreaterThan(afterDeath);
    expect(resolvedText()).toBe("pinned-host");
  });
});
