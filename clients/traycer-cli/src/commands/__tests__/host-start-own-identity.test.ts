import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isProcessStartIdentity } from "@traycer/protocol/host/lifecycle";

// HOME is redirected to a private temp dir BEFORE anything reads it:
// `store/paths` binds `homedir()` at module load, and importing `../host-
// start` below pulls that module in transitively. Without this the import
// binds to this machine's REAL `~/.traycer` home. Copied from the same
// pattern in `host-start.test.ts`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-host-start-own-identity-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

// A well-formed token per `isProcessStartIdentity`
// (protocol/src/host/lifecycle/process-start-identity.ts):
// "<platform>:<non-empty normalized payload>".
const VALID_ASYNC_IDENTITY = "linux:test-boot-id 100";

const ownProcessStartIdentityAsyncMock = vi.hoisted(() =>
  vi.fn(async () => VALID_ASYNC_IDENTITY),
);

// The supervisor stamps `supervisorStartIdentity` from the SYNC
// own-identity read (`ownProcessStartIdentity`), which caches a failed first
// probe for the whole life of the process. `ownProcessStartIdentity` below
// models exactly that failed first sync probe; `ownProcessStartIdentityAsync`
// is the retrying async reader the fix binds `lifecycle.ownStartIdentity` to.
// It does not exist on the real module today - it is added here as a mock
// override, standing in for the export the fix will add.
vi.mock("../../store/process-identity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/process-identity")>();
  return {
    ...actual,
    ownProcessStartIdentity: () => null,
    ownProcessStartIdentityAsync: ownProcessStartIdentityAsyncMock,
  };
});

import { defaultRunHostStartDeps } from "../host-start";
import { hostHomeDir } from "../../store/paths";

// Fail loudly, before the row runs, if the redirect above ever stops taking.
beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

describe("defaultRunHostStartDeps.lifecycle.ownStartIdentity", () => {
  it("uses the async reader's identity instead of a cached failed first sync probe", async () => {
    expect(isProcessStartIdentity(VALID_ASYNC_IDENTITY)).toBe(true);

    const identity = await defaultRunHostStartDeps.lifecycle.ownStartIdentity();

    // On head, `ownStartIdentity` is `() => ownProcessStartIdentity()`
    // (host-start.ts:843) - synchronous, and this mock's sync read always
    // fails (`null`). The fix binds it to the async reader instead, which
    // this mock resolves to a valid token.
    expect(identity).toBe(VALID_ASYNC_IDENTITY);
    expect(ownProcessStartIdentityAsyncMock).toHaveBeenCalledTimes(1);
  });
});
