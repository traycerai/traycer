/**
 * `writeTextAtomically` (`lifecycle-probe.ts`) now finishes its temp+rename
 * publish with `renameWithWindowsRetry(temporary, destination, 0)` instead of
 * a bare `rename`, so a transient win32 rename failure (a watcher holding the
 * destination open for its last read, antivirus, etc.) no longer loses the
 * write. This covers the mechanism directly, and through the one caller that
 * matters most for correctness - `lifecycle-files.ts`'s
 * `writeHostLifecyclePolicyFromCli`, the policy writer `traycer host
 * lifecycle set` uses.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `store/paths` binds its home root from `os.homedir()` at module load - see
// `lifecycle-files.test.ts`'s own comment on the same pattern. Every test
// below re-imports `../lifecycle-files` fresh (after `vi.resetModules()`) so
// each one picks up the current `mocks.homeDir`.
const mocks = vi.hoisted(() => ({
  homeDir: "",
  // When set to a path, the NEXT `rename(_, path)` call fails with EPERM and
  // this is reset to `null` - a ONE-TIME transient failure, never a second.
  armedEpermOnceForDestination: null as string | null,
  // Every `rename()` call, keyed by its destination path, regardless of
  // outcome.
  renameCallCountByDestination: new Map<string, number>(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mocks.homeDir };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (
      source: Parameters<typeof actual.rename>[0],
      destination: Parameters<typeof actual.rename>[1],
    ): Promise<void> => {
      const destinationPath = String(destination);
      mocks.renameCallCountByDestination.set(
        destinationPath,
        (mocks.renameCallCountByDestination.get(destinationPath) ?? 0) + 1,
      );
      if (mocks.armedEpermOnceForDestination === destinationPath) {
        mocks.armedEpermOnceForDestination = null;
        throw Object.assign(new Error("simulated EPERM"), { code: "EPERM" });
      }
      await actual.rename(source, destination);
    },
  };
});

// `process.platform` has an own, configurable property descriptor in every
// Node runtime this suite targets; captured once so the win32 simulation
// below restores the exact original rather than guessing a value.
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
if (ORIGINAL_PLATFORM_DESCRIPTOR === undefined) {
  throw new Error("process.platform has no own property descriptor");
}

function stubWin32Platform(): void {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
}

const ENVIRONMENT = "production";

let workHome: string;

beforeEach(async () => {
  workHome = await mkdtemp(
    join(tmpdir(), "lifecycle-probe-win32-rename-retry-"),
  );
  mocks.homeDir = workHome;
  mocks.armedEpermOnceForDestination = null;
  mocks.renameCallCountByDestination.clear();
  vi.resetModules();
});

afterEach(async () => {
  // Unconditional: a test that never stubbed the platform leaves it already
  // equal to the original descriptor, so redefining it here is a no-op for
  // that test and a genuine restore for one that did.
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
  expect(process.platform).toBe(ORIGINAL_PLATFORM_DESCRIPTOR.value);
  await rm(workHome, { recursive: true, force: true });
});

describe("writeTextAtomically - win32 rename retry", () => {
  it("recovers from one transient EPERM on the destination and commits the text", async () => {
    const { writeTextAtomically } = await import("../lifecycle-probe");
    const destination = join(workHome, "record.txt");

    stubWin32Platform();
    mocks.armedEpermOnceForDestination = destination;

    await writeTextAtomically(destination, "hello-world");

    expect(mocks.renameCallCountByDestination.get(destination)).toBe(2);
    expect(await readFile(destination, "utf8")).toBe("hello-world");
    expect(await readdir(workHome)).toEqual(["record.txt"]);
  });
});

describe("writeHostLifecyclePolicyFromCli - win32 rename retry", () => {
  it("recovers from one transient EPERM writing lifecycle-policy.json", async () => {
    const { writeHostLifecyclePolicyFromCli, hostLifecyclePolicyFilePath } =
      await import("../lifecycle-files");
    const destination = hostLifecyclePolicyFilePath(ENVIRONMENT);

    stubWin32Platform();
    mocks.armedEpermOnceForDestination = destination;

    const policy = await writeHostLifecyclePolicyFromCli(
      ENVIRONMENT,
      "linked",
      new Date("2026-09-24T00:00:00.000Z"),
    );

    expect(policy.mode).toBe("linked");
    expect(policy.rev).toBe(1);
    expect(mocks.renameCallCountByDestination.get(destination)).toBe(2);
    expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({
      mode: "linked",
    });
  });
});
