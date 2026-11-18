import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exitMock = vi.hoisted(() => ({ codes: [] as number[] }));

vi.mock("../../../runner/exit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../runner/exit")>();
  return {
    ...actual,
    finishAndExit: async (exitCode: number): Promise<void> => {
      exitMock.codes.push(exitCode);
    },
  };
});

import { runDataControlEntry } from "../data-control-entry";

type FatalEvent = "unhandledRejection" | "uncaughtException";
const FATAL_EVENTS: readonly FatalEvent[] = [
  "unhandledRejection",
  "uncaughtException",
];

function replaceWrite(
  stream: NodeJS.WriteStream,
  write: (
    chunk: unknown,
    encodingOrCallback: unknown,
    callback: unknown,
  ) => boolean,
): PropertyDescriptor | undefined {
  const original = Object.getOwnPropertyDescriptor(stream, "write");
  Object.defineProperty(stream, "write", {
    value: write,
    configurable: true,
    writable: true,
  });
  return original;
}

function restoreWrite(
  stream: NodeJS.WriteStream,
  original: PropertyDescriptor | undefined,
): void {
  if (original === undefined) {
    Reflect.deleteProperty(stream, "write");
    return;
  }
  Object.defineProperty(stream, "write", original);
}

describe("runDataControlEntry when the stdout reader closed first", () => {
  let home = "";
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let stdoutWrite: PropertyDescriptor | undefined;
  let stderrWrite: PropertyDescriptor | undefined;
  let stderrText = "";
  const listenerCounts = new Map<FatalEvent, number>();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "traycer-data-stdio-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    exitMock.codes = [];
    stderrText = "";
    for (const event of FATAL_EVENTS) {
      listenerCounts.set(event, process.listenerCount(event));
    }
    // A closed reader: the write's own callback reports EPIPE and the stream
    // emits `error` on a later tick, as a real pipe does.
    stdoutWrite = replaceWrite(
      process.stdout,
      (_chunk, encodingOrCallback, callback) => {
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        const error = Object.assign(new Error("write EPIPE"), {
          code: "EPIPE",
        });
        if (typeof done === "function") done(error);
        process.nextTick(() => {
          process.stdout.emit("error", error);
        });
        return false;
      },
    );
    stderrWrite = replaceWrite(
      process.stderr,
      (chunk, encodingOrCallback, callback) => {
        stderrText += String(chunk);
        const done =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        if (typeof done === "function") done(null);
        return true;
      },
    );
  });

  afterEach(() => {
    restoreWrite(process.stdout, stdoutWrite);
    restoreWrite(process.stderr, stderrWrite);
    for (const event of FATAL_EVENTS) {
      const added = process
        .listeners(event)
        .slice(listenerCounts.get(event) ?? 0);
      for (const listener of added) process.off(event, listener);
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it("data status --json exits 0 and never reports an unexpected failure", async () => {
    await runDataControlEntry(["node", "traycer", "data", "status", "--json"]);
    // The `error` event is emitted on a later tick.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(exitMock.codes, stderrText).toEqual([0]);
    expect(stderrText).not.toContain("unexpected failure");
  });
});
