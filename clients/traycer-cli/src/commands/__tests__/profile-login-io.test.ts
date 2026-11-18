import { PassThrough } from "node:stream";
import { createInterface, type Interface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROCESS_PROFILE_LOGIN_IO } from "../profile-login";

// Each interface the code under test opens is a real readline interface over
// an input of its own, so the test drives the real "line" and "close" events
// without touching the process's stdin.
vi.mock("node:readline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:readline")>();
  return {
    ...actual,
    createInterface: vi.fn(() =>
      actual.createInterface({ input: new PassThrough() }),
    ),
  };
});

const createInterfaceMock = vi.mocked(createInterface);

function openedInterface(): Interface {
  const result = createInterfaceMock.mock.results[0];
  if (result === undefined || result.type !== "return") {
    throw new Error("readLines opened no interface");
  }
  return result.value;
}

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

function stubStdinIsTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  createInterfaceMock.mockClear();
});

afterEach(() => {
  if (originalIsTTY === undefined) {
    Reflect.deleteProperty(process.stdin, "isTTY");
  } else {
    Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
  }
});

describe("PROCESS_PROFILE_LOGIN_IO.readLines", () => {
  it("returns null, and opens nothing, when stdin is not a terminal", () => {
    stubStdinIsTTY(false);
    const onLine = vi.fn<(line: string) => void>();
    const onInterrupt = vi.fn<() => void>();

    const stop = PROCESS_PROFILE_LOGIN_IO.readLines(onLine, onInterrupt);

    expect(stop).toBeNull();
    expect(createInterfaceMock).not.toHaveBeenCalled();
  });

  it("hands each typed line to onLine", () => {
    stubStdinIsTTY(true);
    const onLine = vi.fn<(line: string) => void>();
    const onInterrupt = vi.fn<() => void>();

    const stop = PROCESS_PROFILE_LOGIN_IO.readLines(onLine, onInterrupt);
    const lines = openedInterface();
    lines.emit("line", "code-123");
    lines.emit("line", "second");

    expect(onLine.mock.calls).toEqual([["code-123"], ["second"]]);
    expect(onInterrupt).not.toHaveBeenCalled();
    stop?.();
  });

  it("reports an interrupt when the input closes on its own", () => {
    stubStdinIsTTY(true);
    const onLine = vi.fn<(line: string) => void>();
    const onInterrupt = vi.fn<() => void>();

    const stop = PROCESS_PROFILE_LOGIN_IO.readLines(onLine, onInterrupt);
    expect(stop).not.toBeNull();
    openedInterface().emit("close");

    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("closes the interface without reporting an interrupt when stopped", () => {
    stubStdinIsTTY(true);
    const onLine = vi.fn<(line: string) => void>();
    const onInterrupt = vi.fn<() => void>();

    const stop = PROCESS_PROFILE_LOGIN_IO.readLines(onLine, onInterrupt);
    const lines = openedInterface();
    const closed = vi.fn<() => void>();
    lines.on("close", closed);
    stop?.();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("reports an interrupt when readline reports Ctrl+C itself", () => {
    stubStdinIsTTY(true);
    const onInterrupt = vi.fn<() => void>();

    const stop = PROCESS_PROFILE_LOGIN_IO.readLines(vi.fn(), onInterrupt);
    openedInterface().emit("SIGINT");

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    stop?.();
  });
});
