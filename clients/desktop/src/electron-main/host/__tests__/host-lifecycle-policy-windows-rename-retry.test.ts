/**
 * `HostLifecyclePolicyStore`'s private `writeTextAtomically` now finishes its
 * temp+rename publish with `renameWithWindowsRetry(temporary, destination, 0)`
 * instead of a bare `rename`, so a transient win32 rename failure (a watcher
 * holding the destination open for its last read, antivirus, etc.) no longer
 * loses a policy or presence write. Covered through the store's public write
 * API - `writePolicy` and `writePresence` - the only way a caller reaches
 * this writer.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDesktopPresenceText } from "@traycer/protocol/config/desktop-presence";
import { parseHostLifecyclePolicyText } from "@traycer/protocol/config/host-lifecycle-policy";
import {
  formatDarwinProcessStartIdentity,
  type ProcessStartIdentity,
} from "@traycer/protocol/host/lifecycle/process-start-identity";
import { HostLifecyclePolicyStore } from "../host-lifecycle-policy";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (cause: unknown) => String(cause),
}));

const mocks = vi.hoisted(() => ({
  // When set to a path, the NEXT `rename(_, path)` call fails with EPERM and
  // this is reset to `null` - a ONE-TIME transient failure, never a second.
  armedEpermOnceForDestination: null as string | null,
  // Every `rename()` call, keyed by its destination path, regardless of
  // outcome.
  renameCallCountByDestination: new Map<string, number>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename = async (
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
  };
  // The desktop package's vitest config (jsdom environment) resolves a
  // Node-core named import through the module's synthetic `default` export
  // rather than Node's own dual ESM exports - see
  // `host-lifecycle-records-watch.test.ts`'s identical `default` override.
  // Without also replacing it here, `renameWithWindowsRetry`'s `import {
  // rename } from "node:fs/promises"` would keep resolving to the REAL
  // rename, and this mock would silently never fire.
  return { ...actual, rename, default: { ...actual, rename } };
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

const OWN_PID = 4242;
const NOW = new Date("2026-09-24T10:00:00.000Z");

function requireIdentity(
  value: ProcessStartIdentity | null,
): ProcessStartIdentity {
  if (value === null) throw new Error("test fixture: identity was null");
  return value;
}

const OWN_IDENTITY = requireIdentity(
  formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026"),
);

let root: string;
let hostHome: string;
let pidFile: string;

function makeStore(): HostLifecyclePolicyStore {
  return new HostLifecyclePolicyStore({
    hostHomeDir: hostHome,
    pidMetadataFile: pidFile,
    ownPid: OWN_PID,
    readOwnStartIdentity: () => Promise.resolve(OWN_IDENTITY),
    now: () => NOW,
  });
}

beforeEach(async () => {
  root = await mkdtemp(
    join(tmpdir(), "host-lifecycle-policy-win32-rename-retry-"),
  );
  hostHome = join(root, "nested", "host-home");
  pidFile = join(hostHome, "pid.json");
  mocks.armedEpermOnceForDestination = null;
  mocks.renameCallCountByDestination.clear();
});

afterEach(async () => {
  // Unconditional: a test that never stubbed the platform leaves it already
  // equal to the original descriptor, so redefining it here is a no-op for
  // that test and a genuine restore for one that did.
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
  expect(process.platform).toBe(ORIGINAL_PLATFORM_DESCRIPTOR.value);
  await rm(root, { recursive: true, force: true });
});

describe("HostLifecyclePolicyStore - win32 rename retry", () => {
  it("writePolicy recovers from one transient EPERM and commits the new record", async () => {
    const store = makeStore();

    stubWin32Platform();
    mocks.armedEpermOnceForDestination = store.policyPath;

    const written = await store.writePolicy("linked");

    expect(written.mode).toBe("linked");
    expect(mocks.renameCallCountByDestination.get(store.policyPath)).toBe(2);
    const onDisk = parseHostLifecyclePolicyText(
      await readFile(store.policyPath, "utf8"),
    );
    expect(onDisk).toEqual(written);
  });

  it("writePresence recovers from one transient EPERM and commits the new record", async () => {
    const store = makeStore();

    stubWin32Platform();
    mocks.armedEpermOnceForDestination = store.presencePath;

    const outcome = await store.writePresence("keep", 4);

    expect(outcome).toBe("written");
    expect(mocks.renameCallCountByDestination.get(store.presencePath)).toBe(2);
    const onDisk = parseDesktopPresenceText(
      await readFile(store.presencePath, "utf8"),
    );
    expect(onDisk?.onExit).toBe("keep");
    expect(onDisk?.pid).toBe(OWN_PID);
  });
});
