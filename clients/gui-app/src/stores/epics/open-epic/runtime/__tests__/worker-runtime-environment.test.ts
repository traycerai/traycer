import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeWorkerLogEntry } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import { createWorkerRuntimeEnvironment } from "../worker-runtime-environment";

describe("createWorkerRuntimeEnvironment", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules on the global timer and cancels idempotently after firing", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const environment = createWorkerRuntimeEnvironment(emit);
    const callback = vi.fn();

    const timer = environment.scheduler.schedule(25, callback);
    vi.advanceTimersByTime(25);
    timer.cancel();
    timer.cancel();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("runs a scheduled microtask before the next macrotask", async () => {
    vi.useFakeTimers();
    const environment = createWorkerRuntimeEnvironment(vi.fn());
    const order: string[] = [];

    environment.scheduler.scheduleMicrotask(() => order.push("microtask"));
    setTimeout(() => order.push("macrotask"), 0);

    await Promise.resolve();
    expect(order).toEqual(["microtask"]);
    vi.advanceTimersByTime(0);
    expect(order).toEqual(["microtask", "macrotask"]);
  });

  it("emits clonable structured log entries for every error shape", () => {
    const entries: RuntimeWorkerLogEntry[] = [];
    const emit = (entry: RuntimeWorkerLogEntry): void => {
      entries.push(entry);
    };
    const environment = createWorkerRuntimeEnvironment(emit);
    const fields = { source: "test" };
    const error = new Error("boom");

    environment.logger.debug("debug message", fields);
    environment.logger.warn("warn message", fields);
    environment.logger.error("error message", fields, error);
    environment.logger.error("string message", fields, "thrown string");
    environment.logger.error("object message", fields, { fn(): void {} });

    expect(entries[0]?.error).toBeNull();
    expect(entries[1]?.error).toBeNull();
    expect(entries[2]?.error).toContain(error.stack ?? "Error: boom");
    expect(entries[3]?.error).toBe("thrown string");
    expect(entries[4]?.error).toContain("Non-error thrown:");
    for (const entry of entries) {
      expect(() => structuredClone(entry)).not.toThrow();
    }
  });
});
