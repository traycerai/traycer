import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
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
  OwnerResourceChip,
  ResourceUsageChip,
} from "@/components/resources/resource-usage-chip";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";

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

afterEach(() => {
  cleanup();
  __setResourcesStreamClientFactoryForTests(null);
  resourcesRegistry.disposeAll();
});

describe("ResourceUsageChip", () => {
  it("renders formatted CPU / memory / process values with an accessible label", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={null}
        processCount={3}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 12% CPU, 357 MB RSS, 3 processes",
    );
    expect(chip.textContent).toContain("12%");
    expect(chip.textContent).toContain("357 MB RSS");
    expect(chip.textContent).toContain("3");
  });

  it("names PSS in the visible text so two chips stay comparable", () => {
    render(
      <ResourceUsageChip
        cpuPercent={12}
        rssBytes={357 * 1024 * 1024}
        pssBytes={120 * 1024 * 1024}
        processCount={3}
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
        <EpicResourceChip epicId="epic-1" className={undefined} />
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
