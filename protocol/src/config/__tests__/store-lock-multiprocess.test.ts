import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stress test: several real processes and this one all mutate the same
// config.json at once. On an unlocked store this loses keys, but only
// sometimes, so it proves nothing deterministic; the deterministic proofs are
// in store-concurrent-writes.test.ts and store-lock-processes.test.ts. This
// one also runs on a real Windows runner, where link, rename and unlink behave
// differently from POSIX.
const h = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home };
});

import { setCliConfigLockTimingForTests } from "../cli-config-lock";
import { readCliConfig, setEnvOverride } from "../store";

const WRITER_CHILD = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "config-writer-child.ts",
);
const CHILD_PREFIXES = ["A", "B", "C"] as const;
const WRITES_PER_WRITER = 25;

interface ChildResult {
  readonly prefix: string;
  readonly code: number | null;
  readonly stderr: string;
}

function runWriter(prefix: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [WRITER_CHILD], {
      env: {
        ...process.env,
        HOME: h.home,
        USERPROFILE: h.home,
        PREFIX: prefix,
        COUNT: String(WRITES_PER_WRITER),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ prefix, code, stderr });
    });
  });
}

async function parentWrites(): Promise<void> {
  for (let i = 0; i < WRITES_PER_WRITER; i += 1) {
    await setEnvOverride(`P_${i}`, String(i));
  }
}

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-config-multiproc-"));
  // Four writers contend for one lock; the default wait is sized for a
  // person's settings click, not for this burst.
  setCliConfigLockTimingForTests({
    waitMs: 60_000,
    pollMs: 10,
    staleAgeMs: 30_000,
  });
});

afterEach(async () => {
  setCliConfigLockTimingForTests(null);
  await rm(h.home, { recursive: true, force: true });
});

describe("config writers in several processes", () => {
  it("keeps every key written by three child processes and this one", async () => {
    const [results] = await Promise.all([
      Promise.all(CHILD_PREFIXES.map((prefix) => runWriter(prefix))),
      parentWrites(),
    ]);

    for (const result of results) {
      expect(result.code, `${result.prefix}: ${result.stderr}`).toBe(0);
    }
    const expectedKeys = [...CHILD_PREFIXES, "P"].flatMap((prefix) =>
      Array.from(
        { length: WRITES_PER_WRITER },
        (_unused, i) => `${prefix}_${i}`,
      ),
    );
    const { envOverrides } = await readCliConfig();
    expect(Object.keys(envOverrides).sort()).toEqual(expectedKeys.sort());
    for (const key of expectedKeys) {
      expect(envOverrides[key]).toBe(key.slice(key.indexOf("_") + 1));
    }
  }, 120_000);
});
