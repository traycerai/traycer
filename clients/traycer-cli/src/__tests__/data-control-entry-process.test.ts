import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INDEX_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const BUN_AVAILABLE = spawnSync("bun", ["--version"]).status === 0;
const SKIP = process.platform === "win32" || !BUN_AVAILABLE;
const TIMEOUT = 60_000;

type CliRun = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runCli(home: string, args: readonly string[]): Promise<CliRun> {
  // `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`: Bun's own transpiler cache would
  // otherwise land under the temp HOME (Library/Caches/bun) - the runtime's
  // write, not Traycer's, and it would hide a real one in the tree diff.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  delete env.TRAYCER_DATA_DIR;
  delete env.TRAYCER_AGENT_CLI_SURFACE;
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [INDEX_PATH, ...args], {
      env,
      cwd: home,
      timeout: 50_000,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

/** Every path below `root`, relative and sorted; empty when `root` does not exist. */
function listTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      out.push(relative(root, path));
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
}

function singleEnvelope(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  return record(JSON.parse(lines[0] ?? ""));
}

describe.skipIf(SKIP)(
  "traycer data (real process)",
  { timeout: TIMEOUT },
  () => {
    let home: string;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "traycer-data-process-"));
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    function expectNoSideEffects(): void {
      expect(existsSync(join(home, ".traycer"))).toBe(false);
      const files = listTree(home);
      expect(
        files.filter(
          (path) =>
            path.endsWith(".log") || path.toLowerCase().includes("cli.log"),
        ),
      ).toEqual([]);
      expect(
        files.filter(
          (path) => path.includes("admission-") || path.endsWith(".lock"),
        ),
      ).toEqual([]);
    }

    it("data status --json on an empty home prints one ok result and creates nothing", async () => {
      const result = await runCli(home, ["data", "status", "--json"]);

      expect(result.code, result.stderr).toBe(0);
      const envelope = singleEnvelope(result.stdout);
      expect(envelope.type).toBe("result");
      expect(envelope.status).toBe("ok");
      expect(record(record(envelope.data).location).kind).toBe("default");
      expect(existsSync(join(home, ".traycer-bootstrap"))).toBe(false);
      expect(listTree(home)).toEqual([]);
      expectNoSideEffects();
    });

    it("data status --json with a malformed location.json reports the error as an ok result and writes nothing", async () => {
      const bootstrap = join(home, ".traycer-bootstrap");
      mkdirSync(bootstrap, { mode: 0o700 });
      writeFileSync(join(bootstrap, "location.json"), "{ not valid json");
      const before = listTree(home);

      const result = await runCli(home, ["data", "status", "--json"]);

      expect(result.code, result.stderr).toBe(0);
      const envelope = singleEnvelope(result.stdout);
      expect(envelope.type).toBe("result");
      expect(envelope.status).toBe("ok");
      const location = record(record(envelope.data).location);
      expect(location.kind).toBe("error");
      expect(location.code).toBe("record-malformed");
      expect(listTree(bootstrap)).toEqual(["location.json"]);
      expect(listTree(home)).toEqual(before);
      expectNoSideEffects();
    });

    it("an unknown data subcommand exits non-zero with one error envelope", async () => {
      const result = await runCli(home, ["data", "foo", "--json"]);

      expect(result.code).not.toBe(0);
      const envelope = singleEnvelope(result.stdout);
      expect(envelope.type).toBe("result");
      expect(envelope.status).toBe("error");
      expect(record(envelope.error).code).toBe("E_INVALID_ARGUMENT");
      expect(listTree(home)).toEqual([]);
    });

    it("data --help exits 0 and writes no files", async () => {
      const result = await runCli(home, ["data", "--help"]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("status");
      expect(result.stdout).toContain("migrate");
      expect(listTree(home)).toEqual([]);
    });

    it("help under --json prints the help text as one ok result", async () => {
      for (const args of [
        ["data", "--help", "--json"],
        ["data", "status", "--help", "--json"],
      ]) {
        const result = await runCli(home, args);

        expect(result.code, result.stderr).toBe(0);
        const envelope = singleEnvelope(result.stdout);
        expect(envelope.type).toBe("result");
        expect(envelope.status).toBe("ok");
        const output = record(envelope.data).output;
        expect(typeof output).toBe("string");
        expect(String(output)).toContain("Usage:");
        expect(String(output)).toBe(String(output).trimEnd());
      }
      expect(listTree(home)).toEqual([]);
    });
  },
);
