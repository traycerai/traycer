import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_HOST_LANE_NAMES,
  startLocalHostLanes,
  type LocalHostLaneName,
  type LocalHostLaneStarters,
} from "../local-host-lanes";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (cause: unknown) => String(cause),
}));

function recordingStarters(calls: LocalHostLaneName[]): LocalHostLaneStarters {
  return {
    "host-update-menu-state": () => {
      calls.push("host-update-menu-state");
    },
    "host-watcher": () => {
      calls.push("host-watcher");
    },
    "health-monitor": () => {
      calls.push("health-monitor");
    },
    "substrate-owner-backfill": () => {
      calls.push("substrate-owner-backfill");
    },
    "pending-login-item-revision-monitor": () => {
      calls.push("pending-login-item-revision-monitor");
    },
    "competing-registration-repair": () => {
      calls.push("competing-registration-repair");
    },
    "registry-probe": () => {
      calls.push("registry-probe");
    },
    "cli-reconcile": () => {
      calls.push("cli-reconcile");
    },
    "registry-periodic-refresh": () => {
      calls.push("registry-periodic-refresh");
    },
  };
}

describe("startLocalHostLanes", () => {
  it("starts no lane and returns [] in none mode", () => {
    const calls: LocalHostLaneName[] = [];
    const started = startLocalHostLanes("none", recordingStarters(calls));
    expect(calls).toEqual([]);
    expect(started).toEqual([]);
  });

  it("starts every lane exactly once, in declared order, when managed", () => {
    const calls: LocalHostLaneName[] = [];
    const started = startLocalHostLanes("managed", recordingStarters(calls));
    expect(calls).toEqual([...LOCAL_HOST_LANE_NAMES]);
    expect(started).toEqual([...LOCAL_HOST_LANE_NAMES]);
    expect(new Set(calls).size).toBe(LOCAL_HOST_LANE_NAMES.length);
  });
});
