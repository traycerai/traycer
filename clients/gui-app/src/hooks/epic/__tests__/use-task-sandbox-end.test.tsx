import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import { useTaskSandboxEnd } from "@/hooks/epic/use-task-sandbox-end";

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

beforeEach(() => {
  view.current = { kind: "none" };
});

describe("useTaskSandboxEnd", () => {
  it("answers the host's label and end for a destroyed sandbox", () => {
    view.current = {
      kind: "hosts",
      hosts: [row({ hostId: "host-b" }), row({ sandboxEnd: END })],
    };

    const { result } = renderHook(() => useTaskSandboxEnd("epic-1", "host-a"));

    expect(result.current).toEqual({ name: "e2e-sbx-stop3", end: END });
  });

  it("answers null for a live host, an unknown host and a view with no hosts", () => {
    view.current = { kind: "hosts", hosts: [row({})] };
    expect(
      renderHook(() => useTaskSandboxEnd("epic-1", "host-a")).result.current,
    ).toBeNull();
    expect(
      renderHook(() => useTaskSandboxEnd("epic-1", "other")).result.current,
    ).toBeNull();

    view.current = { kind: "none" };
    expect(
      renderHook(() => useTaskSandboxEnd("epic-1", "host-a")).result.current,
    ).toBeNull();
  });

  it("answers null for an ended host that has no label to name", () => {
    view.current = {
      kind: "hosts",
      hosts: [row({ label: null, sandboxEnd: END })],
    };

    expect(
      renderHook(() => useTaskSandboxEnd("epic-1", "host-a")).result.current,
    ).toBeNull();
  });
});
