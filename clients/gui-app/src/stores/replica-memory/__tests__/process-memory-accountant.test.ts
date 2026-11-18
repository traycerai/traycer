/**
 * LOW-13: the process runtime is injected, not welded to the renderer
 * environment. Tests reset the singleton so one store cannot walk another's
 * `set()`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import {
  createProcessMemoryRuntime,
  ensureProcessMemoryRuntime,
  getProcessMemoryAccountant,
  getProcessMemoryRuntime,
  resetProcessMemoryRuntimeForTests,
  setProcessMemoryRuntimeForTests,
} from "@/stores/replica-memory/process-memory-accountant";

function fakeEnvironment(nowMs: number): RuntimeEnvironment {
  return {
    clock: { now: () => nowMs },
    scheduler: {
      schedule() {
        return { cancel(): void {} };
      },
      scheduleMicrotask(): void {},
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

afterEach(() => {
  resetProcessMemoryRuntimeForTests();
});

describe("process memory runtime injection", () => {
  it("throws until ensureProcessMemoryRuntime installs an injected environment", () => {
    expect(() => getProcessMemoryRuntime()).toThrow(/not installed/);
    expect(() => getProcessMemoryAccountant()).toThrow(/not installed/);
  });

  it("stamps snapshot.takenAtMs from the injected clock, not window", () => {
    const runtime = ensureProcessMemoryRuntime(fakeEnvironment(77));
    expect(runtime.accountant.snapshot().takenAtMs).toBe(77);
    expect(getProcessMemoryRuntime()).toBe(runtime);
    expect(getProcessMemoryAccountant()).toBe(runtime.accountant);
  });

  it("ensure is idempotent until reset, then a new runtime is installed", () => {
    const first = ensureProcessMemoryRuntime(fakeEnvironment(1));
    const second = ensureProcessMemoryRuntime(fakeEnvironment(2));
    expect(second).toBe(first);
    expect(second.accountant.snapshot().takenAtMs).toBe(1);
    resetProcessMemoryRuntimeForTests();
    const third = ensureProcessMemoryRuntime(fakeEnvironment(3));
    expect(third).not.toBe(first);
    expect(third.accountant.snapshot().takenAtMs).toBe(3);
  });

  it("setProcessMemoryRuntimeForTests installs a constructed runtime", () => {
    const constructed = createProcessMemoryRuntime(fakeEnvironment(9));
    setProcessMemoryRuntimeForTests(constructed);
    expect(getProcessMemoryRuntime()).toBe(constructed);
  });

  it("nextRuntimeToken and stampChatRecency are process-wide counters", () => {
    const runtime = createProcessMemoryRuntime(fakeEnvironment(0));
    const firstToken = runtime.nextRuntimeToken();
    const secondToken = runtime.nextRuntimeToken();
    expect(firstToken).not.toBe(secondToken);
    const firstStamp = runtime.stampChatRecency();
    const secondStamp = runtime.stampChatRecency();
    expect(secondStamp).toBeGreaterThan(firstStamp);
  });

  it("registers the three known planes", () => {
    const runtime = createProcessMemoryRuntime(fakeEnvironment(0));
    expect(
      runtime.accountant.snapshot().planes.map((plane) => plane.planeId),
    ).toEqual([
      BUDGET_PLANE_IDS.chatWindows,
      BUDGET_PLANE_IDS.hotDocs,
      BUDGET_PLANE_IDS.epicReplicas,
    ]);
  });
});
