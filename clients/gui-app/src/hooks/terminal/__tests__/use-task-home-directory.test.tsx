import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useTaskHomeDirectory,
  useTaskHomeDirectoryFor,
} from "@/hooks/terminal/use-task-home-directory";

const labels = vi.hoisted(() => ({
  byHostId: new Map<string, string>(),
}));

// The host directory's rows are the boundary: a host is named by its label.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null) => {
    const label = hostId === null ? undefined : labels.byHostId.get(hostId);
    return label === undefined ? null : { hostId, label };
  },
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostDirectory: () => ({
    findById: (hostId: string) => {
      const label = labels.byHostId.get(hostId);
      return label === undefined ? null : { hostId, label };
    },
  }),
}));

describe("useTaskHomeDirectory", () => {
  it("names the task's directory by its host's label", () => {
    labels.byHostId = new Map([["host-1", "e2e-sbx-p1"]]);

    const { result } = renderHook(() =>
      useTaskHomeDirectory("epic-7", "host-1"),
    );

    expect(result.current).toEqual({
      epicId: "epic-7",
      hostName: "e2e-sbx-p1",
    });
  });

  it("is null outside a task, for an unknown host and for an unnamed one", () => {
    labels.byHostId = new Map([
      ["host-1", "e2e-sbx-p1"],
      ["host-blank", ""],
    ]);

    expect(
      renderHook(() => useTaskHomeDirectory(null, "host-1")).result.current,
    ).toBeNull();
    expect(
      renderHook(() => useTaskHomeDirectory("epic-7", "host-2")).result.current,
    ).toBeNull();
    expect(
      renderHook(() => useTaskHomeDirectory("epic-7", "host-blank")).result
        .current,
    ).toBeNull();
  });
});

describe("useTaskHomeDirectoryFor", () => {
  it("resolves each host a row names when the row is opened", () => {
    labels.byHostId = new Map([
      ["host-1", "e2e-sbx-p1"],
      ["host-2", "e2e-sbx-p2"],
    ]);

    const { result } = renderHook(() => useTaskHomeDirectoryFor("epic-7"));

    expect(result.current("host-2")).toEqual({
      epicId: "epic-7",
      hostName: "e2e-sbx-p2",
    });
    expect(result.current("host-3")).toBeNull();
  });
});
