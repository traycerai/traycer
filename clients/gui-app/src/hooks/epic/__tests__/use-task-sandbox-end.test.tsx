import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import { useTaskSandboxHost } from "@/hooks/epic/use-task-sandbox-end";

const view = vi.hoisted(() => ({
  current: { kind: "none" } as TaskHostsView,
}));

vi.mock("@/hooks/epic/use-task-hosts-view", () => ({
  useTaskHostsView: () => view.current,
}));

const END = {
  state: "destroyed" as const,
  destroyedAt: Date.UTC(2026, 9, 27, 6, 21),
  cause: "resting",
  actor: null,
  idleMinutes: null,
};

function row(overrides: Partial<TaskHostRow>): TaskHostRow {
  return {
    hostId: "host-a",
    label: "e2e-sbx-stop3",
    principal: { kind: "team", id: "team-1" },
    reach: "same_principal",
    sandboxEnd: null,
    ...overrides,
  };
}

function hostOf(hostId: string | null) {
  return renderHook(() => useTaskSandboxHost("epic-1", hostId)).result.current;
}

beforeEach(() => {
  view.current = { kind: "none" };
});

describe("useTaskSandboxHost", () => {
  it("answers the host's label and end for a destroyed sandbox", () => {
    view.current = {
      kind: "hosts",
      hosts: [row({ hostId: "host-b" }), row({ sandboxEnd: END })],
    };

    expect(hostOf("host-a")).toEqual({
      kind: "ended",
      ended: { name: "e2e-sbx-stop3", end: END },
    });
  });

  it("names a live sandbox the task lists", () => {
    view.current = { kind: "hosts", hosts: [row({})] };

    expect(hostOf("host-a")).toEqual({
      kind: "sandbox",
      name: "e2e-sbx-stop3",
    });
  });

  it("says loading while the task's hosts have not answered", () => {
    view.current = { kind: "loading" };

    expect(hostOf("host-a")).toEqual({ kind: "loading" });
  });

  it("answers other for a person's host, an unlisted host, no host and a view with no hosts", () => {
    view.current = {
      kind: "hosts",
      hosts: [row({ label: null, sandboxEnd: END })],
    };
    expect(hostOf("host-a")).toEqual({ kind: "other" });
    expect(hostOf("elsewhere")).toEqual({ kind: "other" });
    expect(hostOf(null)).toEqual({ kind: "other" });

    view.current = { kind: "none" };
    expect(hostOf("host-a")).toEqual({ kind: "other" });
  });
});
