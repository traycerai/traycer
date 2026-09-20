import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  EpicResourceSnapshotWireV15,
  OwnerResourceSnapshotWireV15,
  ResourceProcessSnapshotWireV15,
  ResourceOwnerKindWire,
} from "@traycer/protocol/host/resources/subscribe";
import type {
  ResourcesProjectionPayload,
  ResourcesStreamCallbacks,
} from "@traycer-clients/shared/host-transport/resources-stream-client";
import {
  EpicResourceChip,
  NavigatorResourceHotspotChip,
  OwnerResourceChip,
  ResourceUsageChip,
} from "@/components/resources/resource-usage-chip";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import { CustomizeOverlay } from "@/components/customize/customize-overlay";
import { useCustomizeStore } from "@/stores/customize/customize-store";

function process(
  over: Partial<ResourceProcessSnapshotWireV15>,
): ResourceProcessSnapshotWireV15 {
  return {
    pid: 1,
    parentPid: null,
    rootPid: 1,
    name: "bash",
    command: "/bin/bash",
    cpuPercent: 12,
    rssBytes: 357 * 1024 * 1024,
    pssBytes: null,
    privateBytes: null,
    descriptor: null,
    ...over,
  };
}

function owner(
  kind: ResourceOwnerKindWire,
  ownerId: string,
  over: Partial<OwnerResourceSnapshotWireV15>,
): OwnerResourceSnapshotWireV15 {
  return {
    owner: { kind, hostId: "host-1", epicId: "epic-1", ownerId },
    sampledAt: 1_000,
    rootPids: [1],
    harnessId: null,
    managedCommand: null,
    activeProcessName: "bash",
    processCount: 3,
    cpuPercent: 12,
    rssBytes: 357 * 1024 * 1024,
    pssBytes: null,
    privateBytes: null,
    processes: [process({})],
    ...over,
  };
}

function epicAggregate(
  over: Partial<EpicResourceSnapshotWireV15>,
): EpicResourceSnapshotWireV15 {
  return {
    hostId: "host-1",
    epicId: "epic-1",
    sampledAt: 1_000,
    ownerCount: 1,
    processCount: 3,
    cpuPercent: 40,
    rssBytes: 512 * 1024 * 1024,
    pssBytes: null,
    privateBytes: null,
    ...over,
  };
}

function projection(
  over: Partial<ResourcesProjectionPayload>,
): ResourcesProjectionPayload {
  return {
    epicId: "epic-1",
    sampledAt: 1_000,
    app: null,
    owners: [],
    epic: null,
    epics: [],
    hostTree: undefined,
    other: undefined,
    restricted: undefined,
    ...over,
  };
}

function installStubFactory(): { emit: () => ResourcesStreamCallbacks } {
  let captured: ResourcesStreamCallbacks | null = null;
  __setResourcesStreamClientFactoryForTests((_scope, callbacks) => {
    captured = callbacks;
    return { close: () => undefined, setDemand: () => undefined };
  });
  return {
    emit: () => {
      if (captured === null) throw new Error("stream callbacks not wired");
      return captured;
    },
  };
}

function startCustomizeSession(): void {
  useCustomizeStore.setState({
    session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
    instances: new Map(),
    history: { past: [], future: [] },
    announcement: "",
  });
}

// The fuller field set `CustomizeOverlay` itself reads (popoverKey, activeKey,
// disclosure, search, ...) - `startCustomizeSession` above is deliberately
// minimal for the ghost-only tests that were already here, but mounting the
// real overlay needs the same reset `customize-overlay.test.tsx` uses so a
// stray value from an earlier test in this file can't leak into it.
function startCustomizeSessionForOverlay(): void {
  useCustomizeStore.setState({
    session: {
      scene: "in-place",
      opener: { kind: "none" },
      startedAt: Date.now(),
    },
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    disclosure: null,
    pendingTarget: null,
    search: { query: "", activeIndex: -1 },
    history: { past: [], future: [] },
  });
}

// jsdom does no layout, so a plain node measures as an all-zero rect and the
// REAL `useHotspotRects` would (correctly) call it unreachable. Stub the two
// DOM reads the hook uses - same technique as `customize-overlay.test.tsx`.
function stubRect(
  node: HTMLElement,
  rect: { x: number; y: number; width: number; height: number },
): void {
  node.getBoundingClientRect = () =>
    new DOMRect(rect.x, rect.y, rect.width, rect.height);
  node.getClientRects = () => {
    const measured = new DOMRect(rect.x, rect.y, rect.width, rect.height);
    return Object.assign([measured], {
      item: (index: number) => (index === 0 ? measured : null),
    });
  };
}

afterEach(() => {
  cleanup();
  __setResourcesStreamClientFactoryForTests(null);
  resourcesRegistry.disposeAll();
  useCustomizeStore.setState({ session: null, instances: new Map() });
});

describe("ResourceUsageChip", () => {
  it("renders every picked value in chip order with the full breakdown on the accessible label", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["cpu", "memory", "processes"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 12% CPU, 357 MB RSS, 3 processes",
    );
    expect(chip.textContent).toBe("12%·357 MB RSS·3 procs");
  });

  it("prints CPU and memory only when the process count is not picked", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["cpu", "memory"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 12% CPU, 357 MB RSS, 3 processes",
    );
    // The process count is still carried by the label, just not printed.
    expect(chip.textContent).toBe("12%·357 MB RSS");
    expect(chip.querySelector('[data-metric="processes"]')).toBeNull();
  });

  it("singularises the process unit for a one-process row", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={1}
        metrics={["processes"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    expect(
      screen.getByLabelText("Resource usage: 12% CPU, 357 MB RSS, 1 process")
        .textContent,
    ).toBe("1 proc");
  });

  it("prints only the process count when that is the sole picked metric", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["processes"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 12% CPU, 357 MB RSS, 3 processes",
    );
    // Named on screen, not only in the label: alone beside the frame's CPU
    // glyph a bare `3` would read as a percentage that lost its sign.
    expect(chip.textContent).toBe("3 procs");
    expect(chip.querySelector('[data-metric="cpu"]')).toBeNull();
    expect(chip.querySelector('[data-metric="memory"]')).toBeNull();
  });

  it("prints only CPU when that is the sole picked metric", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["cpu"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 12% CPU, 357 MB RSS, 3 processes",
    );
    expect(chip.textContent).toBe("12%");
    expect(chip.querySelector('[data-metric="memory"]')).toBeNull();
  });

  it("prints only memory when that is the sole picked metric", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["memory"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 12% CPU, 357 MB RSS, 3 processes",
    );
    expect(chip.textContent).toBe("357 MB RSS");
    expect(chip.querySelector('[data-metric="cpu"]')).toBeNull();
  });

  it("prints the metrics in the order it is given", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["processes", "memory", "cpu"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    expect(screen.getByLabelText(/Resource usage/).textContent).toBe(
      "3 procs·357 MB RSS·12%",
    );
  });

  it("renders nothing at all when no metric is picked", () => {
    const { container } = render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={[]}
        label="Resource usage"
        className={undefined}
      />,
    );
    expect(container.innerHTML).toBe("");
    expect(screen.queryByLabelText(/Resource usage/)).toBeNull();
  });

  it("names PSS in the visible text so two chips stay comparable", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={120 * 1024 * 1024}
        processCount={3}
        metrics={["cpu", "memory"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 12% CPU, 120 MB PSS, 3 processes",
    );
    // The proportional reading wins, and it says so on screen rather than
    // looking like a smaller resident number.
    expect(chip.textContent).toContain("120 MB PSS");
    expect(chip.textContent).not.toContain("357 MB");
  });

  it("renders unavailable memory as an em dash, never as zero", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={null}
        pssBytes={null}
        processCount={3}
        metrics={["cpu", "memory"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 12% CPU, memory unavailable, 3 processes",
    );
    expect(chip.textContent).toContain("—");
    expect(chip.textContent).not.toContain("0 B");
  });
});

describe("OwnerResourceChip", () => {
  it("renders nothing until a live owner snapshot arrives, then reflects it", () => {
    const stub = installStubFactory();
    render(
      <>
        <ResourcesStreamMount epicId="epic-1" />
        <OwnerResourceChip
          epicId="epic-1"
          kind="terminal"
          ownerId="s1"
          hostId="host-1"
          metrics={["cpu", "memory", "processes"]}
          className={undefined}
        />
      </>,
    );

    // Absent snapshot -> nothing rendered (unknown, not zero).
    expect(screen.queryByLabelText(/Resource usage/)).toBeNull();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner("terminal", "s1", { cpuPercent: 12 })],
        }),
      );
    });

    expect(screen.getByLabelText(/Resource usage: 12% CPU/)).not.toBeNull();
  });

  it("stays absent for an owner with no snapshot even when others are tracked", () => {
    const stub = installStubFactory();
    render(
      <>
        <ResourcesStreamMount epicId="epic-1" />
        <OwnerResourceChip
          epicId="epic-1"
          kind="terminal"
          ownerId="missing"
          hostId="host-1"
          metrics={["cpu", "memory", "processes"]}
          className={undefined}
        />
      </>,
    );
    act(() => {
      stub
        .emit()
        .onSnapshot(projection({ owners: [owner("terminal", "s1", {})] }));
    });
    expect(screen.queryByLabelText(/Resource usage/)).toBeNull();
  });

  it("selects the matching host when two terminals share an owner id", () => {
    const stub = installStubFactory();
    render(
      <>
        <ResourcesStreamMount epicId="epic-1" />
        <OwnerResourceChip
          epicId="epic-1"
          kind="terminal"
          ownerId="shared"
          hostId="host-b"
          metrics={["cpu", "memory", "processes"]}
          className={undefined}
        />
      </>,
    );
    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner("terminal", "shared", {
              owner: {
                kind: "terminal",
                hostId: "host-a",
                epicId: "epic-1",
                ownerId: "shared",
              },
              cpuPercent: 12,
            }),
            owner("terminal", "shared", {
              owner: {
                kind: "terminal",
                hostId: "host-b",
                epicId: "epic-1",
                ownerId: "shared",
              },
              cpuPercent: 88,
            }),
          ],
        }),
      );
    });
    expect(screen.getByLabelText(/Resource usage: 88% CPU/)).not.toBeNull();
    expect(screen.queryByLabelText(/Resource usage: 12% CPU/)).toBeNull();
  });
});

describe("EpicResourceChip", () => {
  it("renders nothing when the epic aggregate is null and appears once it lands", () => {
    const stub = installStubFactory();
    render(
      <>
        <ResourcesStreamMount epicId="epic-1" />
        <EpicResourceChip
          epicId="epic-1"
          metrics={["cpu", "memory", "processes"]}
          className={undefined}
        />
      </>,
    );
    expect(screen.queryByLabelText(/Epic resource usage/)).toBeNull();

    act(() => {
      stub
        .emit()
        .onSnapshot(projection({ epic: epicAggregate({ cpuPercent: 40 }) }));
    });

    expect(
      screen.getByLabelText(/Epic resource usage: 40% CPU/),
    ).not.toBeNull();
  });
});

describe("NavigatorResourceHotspotChip", () => {
  it("is passive outside a session, exactly like OwnerResourceChip", () => {
    const stub = installStubFactory();
    render(
      <>
        <ResourcesStreamMount epicId="epic-1" />
        <NavigatorResourceHotspotChip
          owner={{
            epicId: "epic-1",
            kind: "terminal",
            ownerId: "s1",
            hostId: "host-1",
          }}
          metrics={["cpu"]}
          className={undefined}
          registersHotspot
        />
      </>,
    );
    expect(screen.queryByLabelText(/Resource usage/)).toBeNull();
    act(() => {
      stub
        .emit()
        .onSnapshot(
          projection({ owners: [owner("terminal", "s1", { cpuPercent: 12 })] }),
        );
    });
    expect(screen.getByLabelText(/Resource usage: 12% CPU/)).not.toBeNull();
  });

  it("renders nothing for a non-hotspot row with no metrics selected", () => {
    const { container } = render(
      <NavigatorResourceHotspotChip
        owner={{
          epicId: "epic-1",
          kind: "terminal",
          ownerId: "s1",
          hostId: "host-1",
        }}
        metrics={[]}
        className={undefined}
        registersHotspot={false}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("ghosts the hotspot row while editing with no metrics selected", () => {
    startCustomizeSession();
    render(
      <NavigatorResourceHotspotChip
        owner={{
          epicId: "epic-1",
          kind: "terminal",
          ownerId: "s1",
          hostId: "host-1",
        }}
        metrics={[]}
        className={undefined}
        registersHotspot
      />,
    );
    expect(screen.getByTestId("sidebar-resource-chip-ghost")).not.toBeNull();
  });

  it("ghosts the hotspot row while editing when this row owns no tracked process", () => {
    startCustomizeSession();
    render(
      <NavigatorResourceHotspotChip
        owner={null}
        metrics={["cpu"]}
        className={undefined}
        registersHotspot
      />,
    );
    expect(screen.getByTestId("sidebar-resource-chip-ghost")).not.toBeNull();
  });

  it("registers the sidebar.resourceChips hotspot instance while editing", () => {
    startCustomizeSession();
    render(
      <NavigatorResourceHotspotChip
        owner={null}
        metrics={[]}
        className={undefined}
        registersHotspot
      />,
    );
    const instance = [...useCustomizeStore.getState().instances.values()].find(
      (candidate) => candidate.settingId === "sidebar.resourceChips",
    );
    expect(instance).toBeDefined();
    expect(instance?.ghost).toBe(true);
    expect(instance?.condition).toBe("No metrics selected");
  });

  it("renders nothing when not the hotspot row and not editing, even with no owner", () => {
    const { container } = render(
      <NavigatorResourceHotspotChip
        owner={null}
        metrics={["cpu"]}
        className={undefined}
        registersHotspot={false}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  // R2: `NavigatorOwnerResourceHotspotChip` now distinguishes "no owner at
  // all" (should-fix condition "This row has no resource usage to show",
  // covered above) from "a real, tracked owner that just hasn't reported a
  // snapshot yet" - the everyday state right after a terminal/agent starts
  // and before its first sample streams in. That row must ghost with "No
  // reading yet" while editing, and stay silent outside a session exactly
  // like the plain `OwnerResourceChip` does, then become the real chip the
  // moment a snapshot lands - the same registered `sidebar.resourceChips`
  // instance throughout, not a remount.
  describe("owner with metrics selected but no snapshot yet", () => {
    it("ghosts with 'No reading yet' while editing, then swaps to the real chip once a snapshot arrives", () => {
      const stub = installStubFactory();
      startCustomizeSession();
      render(
        <>
          <ResourcesStreamMount epicId="epic-1" />
          <NavigatorResourceHotspotChip
            owner={{
              epicId: "epic-1",
              kind: "terminal",
              ownerId: "s1",
              hostId: "host-1",
            }}
            metrics={["cpu"]}
            className={undefined}
            registersHotspot
          />
        </>,
      );

      expect(screen.getByTestId("sidebar-resource-chip-ghost")).not.toBeNull();
      expect(screen.queryByLabelText(/Resource usage/)).toBeNull();
      const ghostInstance = [
        ...useCustomizeStore.getState().instances.values(),
      ].find((candidate) => candidate.settingId === "sidebar.resourceChips");
      expect(ghostInstance?.ghost).toBe(true);
      expect(ghostInstance?.condition).toBe("No reading yet");

      act(() => {
        stub.emit().onSnapshot(
          projection({
            owners: [owner("terminal", "s1", { cpuPercent: 12 })],
          }),
        );
      });

      expect(screen.queryByTestId("sidebar-resource-chip-ghost")).toBeNull();
      expect(screen.getByLabelText(/Resource usage: 12% CPU/)).not.toBeNull();
      const liveInstance = [
        ...useCustomizeStore.getState().instances.values(),
      ].find((candidate) => candidate.settingId === "sidebar.resourceChips");
      expect(liveInstance?.ghost).toBe(false);
      expect(liveInstance?.condition).toBeNull();
    });

    it("renders nothing outside a session while no snapshot has arrived", () => {
      installStubFactory();
      render(
        <>
          <ResourcesStreamMount epicId="epic-1" />
          <NavigatorResourceHotspotChip
            owner={{
              epicId: "epic-1",
              kind: "terminal",
              ownerId: "s1",
              hostId: "host-1",
            }}
            metrics={["cpu"]}
            className={undefined}
            registersHotspot
          />
        </>,
      );
      expect(screen.queryByTestId("sidebar-resource-chip-ghost")).toBeNull();
      expect(screen.queryByLabelText(/Resource usage/)).toBeNull();
    });

    // R2S3: the non-ghost wrapper is `contents` outside editing (no box of
    // its own - the real chip, once it exists, is the only thing that should
    // measure) and a real `inline-flex` box only while editing, so the
    // Customize overlay has something to anchor a proxy to.
    it("the chip's wrapper is `contents` outside editing", () => {
      const stub = installStubFactory();
      render(
        <>
          <ResourcesStreamMount epicId="epic-1" />
          <NavigatorResourceHotspotChip
            owner={{
              epicId: "epic-1",
              kind: "terminal",
              ownerId: "s1",
              hostId: "host-1",
            }}
            metrics={["cpu"]}
            className={undefined}
            registersHotspot
          />
        </>,
      );
      act(() => {
        stub.emit().onSnapshot(
          projection({
            owners: [owner("terminal", "s1", { cpuPercent: 12 })],
          }),
        );
      });
      const chip = screen.getByLabelText(/Resource usage: 12% CPU/);
      expect(chip.parentElement?.className).toBe("contents");
    });

    it("the chip's wrapper is a measurable `inline-flex` box while editing", () => {
      const stub = installStubFactory();
      startCustomizeSession();
      render(
        <>
          <ResourcesStreamMount epicId="epic-1" />
          <NavigatorResourceHotspotChip
            owner={{
              epicId: "epic-1",
              kind: "terminal",
              ownerId: "s1",
              hostId: "host-1",
            }}
            metrics={["cpu"]}
            className={undefined}
            registersHotspot
          />
        </>,
      );
      act(() => {
        stub.emit().onSnapshot(
          projection({
            owners: [owner("terminal", "s1", { cpuPercent: 12 })],
          }),
        );
      });
      const chip = screen.getByLabelText(/Resource usage: 12% CPU/);
      expect(chip.parentElement?.className).toMatch(/\binline-flex\b/);
      expect(chip.parentElement?.className).not.toMatch(/\bcontents\b/);
    });

    // "measurable box/proxy if harness cheap": the real `CustomizeOverlay`,
    // not just the wrapper class name - the ghost must not be self-rejected
    // by `useHotspotRects`' own `aria-hidden` check, and must become an
    // actual reachable proxy once it has geometry.
    it("the 'No reading yet' ghost becomes a reachable Customize proxy through the real overlay", async () => {
      startCustomizeSessionForOverlay();
      render(
        <>
          <NavigatorResourceHotspotChip
            owner={{
              epicId: "epic-1",
              kind: "terminal",
              ownerId: "s1",
              hostId: "host-1",
            }}
            metrics={["cpu"]}
            className={undefined}
            registersHotspot
          />
          <CustomizeOverlay />
        </>,
      );
      const ghost = screen.getByTestId("sidebar-resource-chip-ghost");
      expect(ghost.getAttribute("aria-hidden")).not.toBe("true");
      stubRect(ghost, { x: 0, y: 0, width: 40, height: 12 });
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });

      const key = [...useCustomizeStore.getState().instances.keys()].find(
        (candidate) => candidate.startsWith("sidebar.resourceChips@"),
      );
      expect(key).toBeDefined();
      await waitFor(() =>
        expect(
          document.querySelector(`[data-customize-proxy="${key}"]`),
        ).not.toBeNull(),
      );
    });
  });
});
