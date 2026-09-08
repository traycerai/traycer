import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../runner/environment";

const mocks = vi.hoisted(() => ({
  hostHomeDirMock: vi.fn(),
  hostDevHomeDirMock: vi.fn(),
  hostDevIdentityPoolRootMock: vi.fn(),
}));

// `resolveChatStoreSurveyRoots` resolves every path itself through
// `store/paths` - genuine filesystem I/O against the operator's real
// `~/.traycer` if left unmocked, the same hazard every other floor-adjacent
// suite in this file sandboxes against.
vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    hostHomeDir: (environment: Environment) =>
      mocks.hostHomeDirMock(environment),
    hostDevHomeDir: () => mocks.hostDevHomeDirMock(),
    hostDevIdentityPoolRoot: () => mocks.hostDevIdentityPoolRootMock(),
  };
});

import {
  resolveChatStoreSurveyRoots,
  singleChatStoreSurveyRoot,
} from "../chat-store-survey-roots";

let sandboxRoot: string;

function productionHome(): string {
  return join(sandboxRoot, "host", "production");
}
function devSlotHome(): string {
  return join(sandboxRoot, "host", "dev-runs", "slot-a");
}
function devHome(): string {
  return join(sandboxRoot, "host", "dev");
}
function poolRoot(): string {
  return join(sandboxRoot, "host", "dev", "identities");
}

beforeEach(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "chat-store-survey-roots-test-"));
  mocks.hostHomeDirMock.mockImplementation((environment: Environment) =>
    environment === "dev" ? devSlotHome() : productionHome(),
  );
  mocks.hostDevHomeDirMock.mockImplementation(() => devHome());
  mocks.hostDevIdentityPoolRootMock.mockImplementation(() => poolRoot());
});

afterEach(async () => {
  await rm(sandboxRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("resolveChatStoreSurveyRoots", () => {
  it("production is exactly one root", async () => {
    await expect(resolveChatStoreSurveyRoots("production")).resolves.toEqual({
      roots: [{ path: productionHome(), label: "host" }],
      enumerationFailed: false,
    });
  });

  it("dev with no pool is the slot plus the unslotted dev home, enumerationFailed: false", async () => {
    // No pool directory created at all - the ordinary state of a dev
    // machine that has never run the identity-pool walk.
    await expect(resolveChatStoreSurveyRoots("dev")).resolves.toEqual({
      roots: [
        { path: devSlotHome(), label: "host" },
        { path: devHome(), label: "dev" },
      ],
      enumerationFailed: false,
    });
  });

  it("dev with a pool is one root per identity, sorted, primary first", async () => {
    await mkdir(join(poolRoot(), "identity-b"), { recursive: true });
    await mkdir(join(poolRoot(), "identity-a"), { recursive: true });

    await expect(resolveChatStoreSurveyRoots("dev")).resolves.toEqual({
      roots: [
        { path: devSlotHome(), label: "host" },
        { path: devHome(), label: "dev" },
        { path: join(poolRoot(), "identity-a"), label: "identity-a" },
        { path: join(poolRoot(), "identity-b"), label: "identity-b" },
      ],
      enumerationFailed: false,
    });
  });

  // Root cause is `os.access`, permission bits don't restrict `root` (nor,
  // reliably, Windows) - see the same guard in `chat-store-survey.test.ts`.
  const canSimulateEacces = platform !== "win32" && process.getuid?.() !== 0;
  (canSimulateEacces ? it : it.skip)(
    "a pool that exists but will not enumerate reports enumerationFailed: true, WITH the roots found so far",
    async () => {
      await mkdir(poolRoot(), { recursive: true });
      await chmod(poolRoot(), 0o000);

      try {
        await expect(resolveChatStoreSurveyRoots("dev")).resolves.toEqual({
          roots: [
            { path: devSlotHome(), label: "host" },
            { path: devHome(), label: "dev" },
          ],
          enumerationFailed: true,
        });
      } finally {
        await chmod(poolRoot(), 0o755);
      }
    },
  );
});

describe("singleChatStoreSurveyRoot", () => {
  it("wraps a bare path as the one-root, never-failed case", () => {
    expect(singleChatStoreSurveyRoot("/some/path")).toEqual({
      roots: [{ path: "/some/path", label: "host" }],
      enumerationFailed: false,
    });
  });
});
