import { describe, expect, it } from "vitest";
import {
  resourceMemoryBytes,
  resourceMemoryLabel,
  selectResourceMemoryMetric,
  sumCompleteMemoryBytes,
  type ResourceMemoryProjection,
} from "../memory-metric";
import type { OwnerResourceUsage } from "@/stores/resources/resources-store";

function detail(pssBytes: number | null): {
  readonly rssBytes: number;
  readonly pssBytes: number | null;
  readonly privateBytes: number | null;
} {
  return { rssBytes: 100, pssBytes, privateBytes: pssBytes };
}

function process(pssBytes: number | null) {
  return {
    pid: 1,
    parentPid: null,
    rootPid: 1,
    name: "bash",
    command: "/bin/bash",
    cpuPercent: 1,
    ...detail(pssBytes),
    descriptor: null,
  };
}

function owner(pssBytes: number | null): OwnerResourceUsage {
  return {
    owner: {
      kind: "terminal",
      hostId: "host-1",
      epicId: "epic-1",
      ownerId: "s1",
    },
    sampledAt: 1_000,
    rootPids: [1],
    activeProcessName: "bash",
    harnessId: null,
    managedCommand: null,
    processCount: 1,
    cpuPercent: 1,
    ...detail(pssBytes),
    processes: [process(pssBytes)],
  };
}

function projection(pssBytes: number | null): ResourceMemoryProjection {
  return {
    app: {
      sampledAt: 1_000,
      hostTotalMemoryBytes: 16_000,
      processCount: 1,
      cpuPercent: 1,
      ...detail(pssBytes),
      process: process(pssBytes),
    },
    hostTree: {
      sampledAt: 1_000,
      processCount: 1,
      cpuPercent: 1,
      ...detail(pssBytes),
    },
    other: {
      sampledAt: 1_000,
      rootPids: [1],
      processCount: 1,
      cpuPercent: 1,
      ...detail(pssBytes),
      processes: [process(pssBytes)],
    },
    restricted: null,
    owners: [owner(pssBytes)],
  };
}

describe("resource memory metric selection", () => {
  it("uses PSS consistently only for a complete host-only scope", () => {
    const complete = projection(40);
    const metric = selectResourceMemoryMetric(complete, false);
    expect(metric).toBe("pss");
    expect(resourceMemoryBytes(owner(40), metric)).toBe(40);
    expect(resourceMemoryLabel(metric, false)).toContain("PSS");
  });

  it("falls back to RSS for incomplete detail and mixed Desktop/Host views", () => {
    expect(selectResourceMemoryMetric(projection(null), false)).toBe("rss");
    expect(selectResourceMemoryMetric(projection(40), true)).toBe("rss");
    expect(resourceMemoryLabel("rss", true)).toContain("working-set");
    expect(
      resourceMemoryBytes(
        { rssBytes: null, pssBytes: null, privateBytes: null },
        "rss",
      ),
    ).toBeNull();
  });

  it("falls back to RSS when a single leaf is missing its PSS reading", () => {
    const complete = projection(40);
    const oneBlindLeaf: ResourceMemoryProjection = {
      ...complete,
      owners: [{ ...complete.owners[0], processes: [process(null)] }],
    };
    expect(selectResourceMemoryMetric(oneBlindLeaf, false)).toBe("rss");
  });

  it("makes a containing memory sum unavailable when any reading is unavailable", () => {
    expect(sumCompleteMemoryBytes([10, 20, 30])).toBe(60);
    expect(sumCompleteMemoryBytes([10, null, 30])).toBeNull();
  });
});
