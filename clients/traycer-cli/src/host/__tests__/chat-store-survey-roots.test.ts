import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../runner/environment";

const mocks = vi.hoisted(() => ({
  hostHomeDirMock: vi.fn(),
  hostDevHomeDirMock: vi.fn(),
  hostDevIdentityPoolRootMock: vi.fn(),
  // Path to make `lstat` reject with ENOENT for, simulating a pool entry
  // that vanished between the `readdir` and the `lstat` - `null` (the
  // default) lets every `lstat` through to the real filesystem.
  lstatEnoentForPath: null as string | null,
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

// Only `lstat` is intercepted, and only for one path at a time - everything
// else (including this test file's own `mkdir`/`writeFile`/`symlink`/`rm`
// calls) passes straight through to the real filesystem.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (path: Parameters<typeof actual.lstat>[0]) => {
      if (path === mocks.lstatEnoentForPath) {
        return Promise.reject(
          Object.assign(new Error("simulated ENOENT"), { code: "ENOENT" }),
        );
      }
      return actual.lstat(path);
    },
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
  mocks.lstatEnoentForPath = null;
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

  describe("pool-entry classification (lstat, not readdir Dirent)", () => {
    // The bug this whole describe block guards: a stray `.DS_Store` in
    // `host/dev/identities` became a survey root, `listEpicDirs` failed with
    // ENOTDIR, and the floor refused every downgrade on an otherwise healthy
    // dev machine - one Finder visit to that directory was enough.

    it("skips a regular file among the identities - it never was an identity home, enumerationFailed stays false", async () => {
      await mkdir(join(poolRoot(), "identity-real"), { recursive: true });
      await writeFile(join(poolRoot(), ".DS_Store"), "", "utf8");

      await expect(resolveChatStoreSurveyRoots("dev")).resolves.toEqual({
        roots: [
          { path: devSlotHome(), label: "host" },
          { path: devHome(), label: "dev" },
          { path: join(poolRoot(), "identity-real"), label: "identity-real" },
        ],
        enumerationFailed: false,
      });
    });

    // `symlink()` is EPERM for a Windows developer without the create-
    // symbolic-link privilege - see `chat-store-survey.test.ts`'s same guard.
    const canSymlink = platform !== "win32";
    (canSymlink ? it : it.skip)(
      "a symlink among the identities is NOT a root, AND sets enumerationFailed: true - the one case that is easy to get wrong by pattern-matching the regular-file case",
      async () => {
        const realTarget = await mkdtemp(
          join(tmpdir(), "chat-store-survey-roots-test-link-target-"),
        );
        try {
          await mkdir(join(poolRoot(), "identity-real"), {
            recursive: true,
          });
          await symlink(realTarget, join(poolRoot(), "identity-linked"));

          const result = await resolveChatStoreSurveyRoots("dev");

          // Both halves: absent from `roots` AND the flag is set. Skipping
          // it silently would be wrong in both directions - followed, it
          // could point the survey at a tree that is not an identity home;
          // ignored, it could hide one that is. The resolver cannot tell
          // which, and that is exactly what `enumerationFailed` means.
          expect(
            result.roots.some((root) => root.label === "identity-linked"),
          ).toBe(false);
          expect(result.enumerationFailed).toBe(true);
          expect(result.roots).toEqual([
            { path: devSlotHome(), label: "host" },
            { path: devHome(), label: "dev" },
            {
              path: join(poolRoot(), "identity-real"),
              label: "identity-real",
            },
          ]);
        } finally {
          await rm(realTarget, { recursive: true, force: true });
        }
      },
    );

    it("skips an entry that vanishes between readdir and lstat (ENOENT) - nothing is there, so there is nothing to be blind to", async () => {
      await mkdir(join(poolRoot(), "identity-real"), { recursive: true });
      await mkdir(join(poolRoot(), "identity-vanishing"), {
        recursive: true,
      });
      mocks.lstatEnoentForPath = join(poolRoot(), "identity-vanishing");

      await expect(resolveChatStoreSurveyRoots("dev")).resolves.toEqual({
        roots: [
          { path: devSlotHome(), label: "host" },
          { path: devHome(), label: "dev" },
          { path: join(poolRoot(), "identity-real"), label: "identity-real" },
        ],
        enumerationFailed: false,
      });
    });
  });
});

describe("singleChatStoreSurveyRoot", () => {
  it("wraps a bare path as the one-root, never-failed case", () => {
    expect(singleChatStoreSurveyRoot("/some/path")).toEqual({
      roots: [{ path: "/some/path", label: "host" }],
      enumerationFailed: false,
    });
  });
});
