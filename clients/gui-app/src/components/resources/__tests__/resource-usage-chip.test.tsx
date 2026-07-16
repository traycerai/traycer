import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type {
  EpicResourceSnapshotWire,
  OwnerResourceSnapshotWire,
  ResourceProcessSnapshotWire,
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
  over: Partial<ResourceProcessSnapshotWire>,
): ResourceProcessSnapshotWire {
  return {
    pid: 1,
    parentPid: null,
    rootPid: 1,
    name: "bash",
    command: "/bin/bash",
    cpuPercent: 12,
    rssBytes: 357 * 1024 * 1024,
    ...over,
  };
}

function owner(
  kind: ResourceOwnerKindWire,
  ownerId: string,
  over: Partial<OwnerResourceSnapshotWire>,
): OwnerResourceSnapshotWire {
  return {
    owner: { kind, hostId: "host-1", epicId: "epic-1", ownerId },
    sampledAt: 1_000,
    rootPids: [1],
    activeProcessName: "bash",
    processCount: 3,
    cpuPercent: 12,
    rssBytes: 357 * 1024 * 1024,
    processes: [process({})],
    ...over,
  };
}

function epicAggregate(
  over: Partial<EpicResourceSnapshotWire>,
): EpicResourceSnapshotWire {
  return {
    hostId: "host-1",
    epicId: "epic-1",
    sampledAt: 1_000,
    ownerCount: 1,
    processCount: 3,
    cpuPercent: 40,
    rssBytes: 512 * 1024 * 1024,
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
    ...over,
  };
}

function installStubFactory(): { emit: () => ResourcesStreamCallbacks } {
  let captured: ResourcesStreamCallbacks | null = null;
  __setResourcesStreamClientFactoryForTests((_scope, callbacks) => {
    captured = callbacks;
    return { close: () => undefined };
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
        processCount={3}
        label="Resource usage"
        className={undefined}
      />,
    );
    const chip = screen.getByLabelText(
      "Resource usage: 12% CPU, 357 MB memory, 3 processes",
    );
    expect(chip.textContent).toContain("12%");
    expect(chip.textContent).toContain("357 MB");
    expect(chip.textContent).toContain("3");
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
