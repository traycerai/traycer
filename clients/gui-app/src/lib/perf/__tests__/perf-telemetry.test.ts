import { afterEach, describe, expect, it, vi } from "vitest";
import { logPerfEvent } from "@/lib/perf/perf-telemetry";

const FLAG_KEY = "traycer:perf:telemetry";

interface PerfLine {
  readonly name: string;
  readonly tsMs: number;
  readonly fields: Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("logPerfEvent", () => {
  it("emits a single [traycer-perf] console.warn line with name/tsMs/fields", () => {
    window.localStorage.setItem(FLAG_KEY, "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logPerfEvent("worktree.list_query", {
      worktreeCount: 12,
      submoduleCount: 3,
      fromCache: false,
      note: "hello",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line.startsWith("[traycer-perf] ")).toBe(true);

    const payload = JSON.parse(
      line.slice("[traycer-perf] ".length),
    ) as PerfLine;
    expect(payload.name).toBe("worktree.list_query");
    expect(typeof payload.tsMs).toBe("number");
    expect(payload.fields).toEqual({
      worktreeCount: 12,
      submoduleCount: 3,
      fromCache: false,
      note: "hello",
    });
  });

  it("no-ops when the flag is explicitly off", () => {
    window.localStorage.setItem(FLAG_KEY, "0");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logPerfEvent("main_thread_block", { blockedMs: 120 });

    expect(warn).not.toHaveBeenCalled();
  });

  it("no-ops under test mode when no flag is set", () => {
    // MODE === "test" defaults off; without an explicit "1" nothing is emitted.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logPerfEvent("main_thread_block", { blockedMs: 120 });

    expect(warn).not.toHaveBeenCalled();
  });
});
