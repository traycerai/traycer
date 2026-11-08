import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
import { useEpicResourcesLease } from "@/hooks/resources/use-epic-resources-lease";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import type { AppResourceUsage } from "@/stores/resources/resources-store";

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

/** A 16-processor host's app snapshot, as the stream carries it. */
function appUsage(over: Partial<AppResourceUsage>): AppResourceUsage {
  return {
    sampledAt: 1_000,
    hostTotalMemoryBytes: 16 * 1024 * 1024 * 1024,
    hostCpuCount: 16,
    process: null,
    processCount: 1,
    cpuPercent: 1,
    rssBytes: 20 * 1024 * 1024,
    pssBytes: null,
    privateBytes: null,
    ...over,
  };
}

const SIXTEEN_CORE_HOST = appUsage({});

/** A host older than @1.6: its app snapshot carries no processor count. */
const NO_COUNT_HOST = appUsage({ hostCpuCount: undefined });

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
    app: SIXTEEN_CORE_HOST,
    owners: [],
    epic: null,
    epics: [],
    hostTree: undefined,
    other: undefined,
    restricted: undefined,
    ...over,
  };
}

/** Holds one epic's stream lease, as a chip or the pane's fallback would. */
function EpicLease(props: { readonly epicId: string }): null {
  useEpicResourcesLease(props.epicId, true);
  return null;
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

afterEach(() => {
  cleanup();
  __setResourcesStreamClientFactoryForTests(null);
  resourcesRegistry.disposeAll();
});

describe("ResourceUsageChip", () => {
  it("renders every picked value in chip order with the full breakdown on the accessible label", () => {
    render(
      <ResourceUsageChip
        app={SIXTEEN_CORE_HOST}
        cpuPercent={100}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["cpu", "memory", "processes"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 6.3% CPU (1.0 of 16 cores), 357 MB RSS, 3 processes",
    );
    expect(chip.textContent).toBe("6.3%·357 MB RSS·3 procs");
  });

  it("prints CPU and memory only when the process count is not picked", () => {
    render(
      <ResourceUsageChip
        app={SIXTEEN_CORE_HOST}
        cpuPercent={100}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["cpu", "memory"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 6.3% CPU (1.0 of 16 cores), 357 MB RSS, 3 processes",
    );
    // The process count is still carried by the label, just not printed.
    expect(chip.textContent).toBe("6.3%·357 MB RSS");
    expect(chip.querySelector('[data-metric="processes"]')).toBeNull();
  });

  it("singularises the process unit for a one-process row", () => {
    render(
      <ResourceUsageChip
        app={SIXTEEN_CORE_HOST}
        cpuPercent={100}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={1}
        metrics={["processes"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    expect(
      screen.getByLabelText(
        "Resource usage: 6.3% CPU (1.0 of 16 cores), 357 MB RSS, 1 process",
      ).textContent,
    ).toBe("1 proc");
  });

  it("prints only the process count when that is the sole picked metric", () => {
    render(
      <ResourceUsageChip
        app={SIXTEEN_CORE_HOST}
        cpuPercent={100}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["processes"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 6.3% CPU (1.0 of 16 cores), 357 MB RSS, 3 processes",
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
        app={SIXTEEN_CORE_HOST}
        cpuPercent={100}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["cpu"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 6.3% CPU (1.0 of 16 cores), 357 MB RSS, 3 processes",
    );
    expect(chip.textContent).toBe("6.3%");
    expect(chip.querySelector('[data-metric="memory"]')).toBeNull();
  });

  it("prints only memory when that is the sole picked metric", () => {
    render(
      <ResourceUsageChip
        app={SIXTEEN_CORE_HOST}
        cpuPercent={100}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["memory"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 6.3% CPU (1.0 of 16 cores), 357 MB RSS, 3 processes",
    );
    expect(chip.textContent).toBe("357 MB RSS");
    expect(chip.querySelector('[data-metric="cpu"]')).toBeNull();
  });

  it("prints the metrics in the order it is given", () => {
    render(
      <ResourceUsageChip
        app={SIXTEEN_CORE_HOST}
        cpuPercent={100}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        metrics={["processes", "memory", "cpu"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    expect(screen.getByLabelText(/Resource usage/).textContent).toBe(
      "3 procs·357 MB RSS·6.3%",
    );
  });

  it("renders nothing at all when no metric is picked", () => {
    const { container } = render(
      <ResourceUsageChip
        app={SIXTEEN_CORE_HOST}
        cpuPercent={100}
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
        app={SIXTEEN_CORE_HOST}
        cpuPercent={100}
        rssBytes={357 * 1024 * 1024}
        pssBytes={120 * 1024 * 1024}
        processCount={3}
        metrics={["cpu", "memory"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 6.3% CPU (1.0 of 16 cores), 120 MB PSS, 3 processes",
    );
    // The proportional reading wins, and it says so on screen rather than
    // looking like a smaller resident number.
    expect(chip.textContent).toContain("120 MB PSS");
    expect(chip.textContent).not.toContain("357 MB");
  });

  it("renders unavailable memory as an em dash, never as zero", () => {
    render(
      <ResourceUsageChip
        app={SIXTEEN_CORE_HOST}
        cpuPercent={100}
        rssBytes={null}
        pssBytes={null}
        processCount={3}
        metrics={["cpu", "memory"]}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 6.3% CPU (1.0 of 16 cores), memory unavailable, 3 processes",
    );
    expect(chip.textContent).toContain("—");
    expect(chip.textContent).not.toContain("0 B");
  });
});

describe("OwnerResourceChip", () => {
  function renderChip(ownerId: string) {
    return render(
      <OwnerResourceChip
        epicId="epic-1"
        kind="terminal"
        ownerId={ownerId}
        hostId="host-1"
        metrics={["cpu"]}
        className={undefined}
      />,
    );
  }

  /**
   * The chip is what draws an epic's numbers, so it is what holds the epic's
   * stream: open while one is mounted, shared by every chip on the epic, and
   * closed with the last of them.
   */
  it("holds one shared stream for its epic while any chip is mounted", () => {
    let opened = 0;
    let closed = 0;
    __setResourcesStreamClientFactoryForTests(() => {
      opened += 1;
      return {
        close: () => {
          closed += 1;
        },
        setDemand: () => undefined,
      };
    });

    const first = renderChip("s1");
    const second = renderChip("s2");
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
    expect(opened).toBe(1);

    first.unmount();
    expect(resourcesRegistry.get("epic-1")).not.toBeNull();
    expect(closed).toBe(0);

    second.unmount();
    expect(resourcesRegistry.get("epic-1")).toBeNull();
    expect(closed).toBe(1);
  });

  it("opens nothing when it has no metric to draw", () => {
    installStubFactory();
    render(
      <OwnerResourceChip
        epicId="epic-1"
        kind="terminal"
        ownerId="s1"
        hostId="host-1"
        metrics={[]}
        className={undefined}
      />,
    );
    expect(resourcesRegistry.get("epic-1")).toBeNull();
  });

  it("renders nothing until a live owner snapshot arrives, then reflects it", () => {
    const stub = installStubFactory();
    render(
      <OwnerResourceChip
        epicId="epic-1"
        kind="terminal"
        ownerId="s1"
        hostId="host-1"
        metrics={["cpu", "memory", "processes"]}
        className={undefined}
      />,
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

    expect(
      screen.getByLabelText(/Resource usage: 0\.75% CPU \(0\.1 of 16 cores\)/),
    ).not.toBeNull();
  });

  it("stays absent for an owner with no snapshot even when others are tracked", () => {
    const stub = installStubFactory();
    render(
      <OwnerResourceChip
        epicId="epic-1"
        kind="terminal"
        ownerId="missing"
        hostId="host-1"
        metrics={["cpu", "memory", "processes"]}
        className={undefined}
      />,
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
      <OwnerResourceChip
        epicId="epic-1"
        kind="terminal"
        ownerId="shared"
        hostId="host-b"
        metrics={["cpu", "memory", "processes"]}
        className={undefined}
      />,
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
    expect(
      screen.getByLabelText(/Resource usage: 5\.5% CPU \(0\.9 of 16 cores\)/),
    ).not.toBeNull();
    expect(screen.queryByLabelText(/Resource usage: 0\.75% CPU/)).toBeNull();
  });

  it("renders one busy core on a 16-processor host as 6.3% and names the core on hover", async () => {
    const stub = installStubFactory();
    render(
      <OwnerResourceChip
        epicId="epic-1"
        kind="terminal"
        ownerId="s1"
        hostId="host-1"
        metrics={["cpu"]}
        className={undefined}
      />,
    );
    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner("terminal", "s1", { cpuPercent: 100 })],
        }),
      );
    });

    const chip = screen.getByLabelText(
      "Resource usage: 6.3% CPU (1.0 of 16 cores), 357 MB RSS, 3 processes",
    );
    expect(chip.textContent).toBe("6.3%");
    fireEvent.focus(chip);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "6.3% CPU (1.0 of 16 cores)",
    );
  });

  it("keeps two decimals for a small share so a light row never reads 0.0%", () => {
    const stub = installStubFactory();
    render(
      <OwnerResourceChip
        epicId="epic-1"
        kind="terminal"
        ownerId="s1"
        hostId="host-1"
        metrics={["cpu"]}
        className={undefined}
      />,
    );
    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner("terminal", "s1", { cpuPercent: 5 })],
        }),
      );
    });

    expect(
      screen.getByLabelText(/Resource usage: 0\.31% CPU \(0\.1 of 16 cores\)/)
        .textContent,
    ).toBe("0.31%");
  });

  it("shows a dash and says why when the host sent no processor count, never the per-core figure", () => {
    const stub = installStubFactory();
    render(
      <OwnerResourceChip
        epicId="epic-1"
        kind="terminal"
        ownerId="s1"
        hostId="host-1"
        metrics={["cpu", "memory", "processes"]}
        className={undefined}
      />,
    );
    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: NO_COUNT_HOST,
          owners: [owner("terminal", "s1", { cpuPercent: 100 })],
        }),
      );
    });

    const chip = screen.getByLabelText(
      "Resource usage: CPU unavailable: This host doesn't report how many processors it has, so there is no total to take a CPU share of., 357 MB RSS, 3 processes",
    );
    expect(chip.textContent).toBe("—·357 MB RSS·3 procs");
    expect(chip.textContent).not.toContain("100");
  });
});

describe("EpicResourceChip", () => {
  it("renders nothing when the epic aggregate is null and appears once it lands", () => {
    const stub = installStubFactory();
    render(
      <>
        <EpicLease epicId="epic-1" />
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
      screen.getByLabelText(
        /Epic resource usage: 2\.5% CPU \(0\.4 of 16 cores\)/,
      ),
    ).not.toBeNull();
  });

  it("shows a dash for an epic on a host that sent no processor count", () => {
    const stub = installStubFactory();
    render(
      <>
        <EpicLease epicId="epic-1" />
        <EpicResourceChip
          epicId="epic-1"
          metrics={["cpu"]}
          className={undefined}
        />
      </>,
    );
    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: NO_COUNT_HOST,
          epic: epicAggregate({ cpuPercent: 40 }),
        }),
      );
    });

    const chip = screen.getByLabelText(/Epic resource usage: CPU unavailable/);
    expect(chip.textContent).toBe("—");
  });
});

// The overlay/ghost technique (`registersHotspot`, the Customize session, the
// hotspot proxy) is gone: the component is now a plain gate over
// `OwnerResourceChip`, so its own coverage is just the null-owner short
// circuit plus the delegation - `OwnerResourceChip`'s own suite above owns
// everything about the reading itself.
describe("NavigatorResourceHotspotChip", () => {
  it("renders nothing when there is no owner", () => {
    const { container } = render(
      <NavigatorResourceHotspotChip
        owner={null}
        metrics={["cpu"]}
        className={undefined}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("delegates to OwnerResourceChip once given an owner: nothing until a snapshot arrives, then the reading", () => {
    const stub = installStubFactory();
    render(
      <NavigatorResourceHotspotChip
        owner={{
          epicId: "epic-1",
          kind: "terminal",
          ownerId: "s1",
          hostId: "host-1",
        }}
        metrics={["cpu"]}
        className={undefined}
      />,
    );
    expect(screen.queryByLabelText(/Resource usage/)).toBeNull();
    act(() => {
      stub
        .emit()
        .onSnapshot(
          projection({ owners: [owner("terminal", "s1", { cpuPercent: 12 })] }),
        );
    });
    expect(screen.getByLabelText(/Resource usage: 0\.75% CPU/)).not.toBeNull();
  });
});
