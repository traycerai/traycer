// Tests for scripts/local-definition-ratchet.mjs: the per-source scanner, the
// pure ratchet/baseline helpers, and one end-to-end CLI run in a temp repo.
// Every fixture is an inline source string; the real tree is never scanned.

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCEPT_INCREASE_FLAG,
  nextBaseline,
  ratchetDiff,
  scanSource,
} from "../local-definition-ratchet.mjs";

const SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "local-definition-ratchet.mjs",
);

/** `scanSource` as a plain object, for readable `toEqual` assertions. */
function scan(text, fileName = "src/example.ts") {
  return Object.fromEntries(scanSource(fileName, text));
}

describe("scanSource: named rules", () => {
  it.each([
    ["sleep", "function sleep(ms: number) { return setTimeout(ms); }"],
    ["isRecord", "function isRecord(v: unknown): boolean { return !!v; }"],
    [
      "errorMessage",
      "function errorMessage(e: unknown): string { return String(e); }",
    ],
    [
      "productionSources",
      "function productionSources(): string[] { return []; }",
    ],
  ])("%s counts a function declaration", (ruleId, source) => {
    expect(scan(source)).toEqual({ [ruleId]: 1 });
  });

  it.each([
    [
      "sleepMs",
      "sleep",
      "const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));",
    ],
    [
      "isPlainObject",
      "isRecord",
      "const isPlainObject = (v: unknown) => typeof v === 'object';",
    ],
    [
      "describeError",
      "errorMessage",
      "const describeError = (e: unknown) => String(e);",
    ],
    [
      "collectSourceFiles",
      "productionSources",
      "const collectSourceFiles = () => [];",
    ],
  ])("%s counts a const arrow", (_name, ruleId, source) => {
    expect(scan(source)).toEqual({ [ruleId]: 1 });
  });

  it("counts a function expression and a let/var binding", () => {
    expect(
      scan(
        "let isObject = function (v: unknown) { return !!v; };\nvar isObjectRecord = (v: unknown) => !!v;",
      ),
    ).toEqual({ isRecord: 2 });
  });

  it("counts promisify(setTimeout) as a sleep", () => {
    expect(
      scan(
        "import { promisify } from 'node:util';\nconst sleep = promisify(setTimeout);",
      ),
    ).toEqual({ sleep: 1 });
  });

  it("counts several definitions of one rule in one file", () => {
    expect(
      scan(
        "const sleep = (ms: number) => setTimeout(() => {}, ms);\nfunction sleepMs(ms: number) { setTimeout(() => {}, ms); }",
      ),
    ).toEqual({ sleep: 2 });
  });

  it("does not count a method, an object-literal member or a bodiless overload", () => {
    const source = `
      class Clock { sleep(ms: number) { return setTimeout(() => {}, ms); } }
      const ports = { sleep: (ms: number) => ms, isRecord(v: unknown) { return !!v; } };
      function isRecord(v: string): boolean;
      function isRecord(v: number): boolean;
    `;
    expect(scan(source)).toEqual({});
  });

  it("does not count a name inside a comment or a string", () => {
    const source = `
      // function sleep(ms) { setTimeout(ms); }
      /* const isRecord = (v) => !!v; */
      const text = "function errorMessage(e) { return e; }";
      const tpl = \`const sleep = () => setTimeout\`;
    `;
    expect(scan(source)).toEqual({});
  });

  it("counts delay and wait only when the definition calls setTimeout", () => {
    expect(
      scan(
        "function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }",
      ),
    ).toEqual({ sleep: 1 });
    expect(
      scan(
        "const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));",
      ),
    ).toEqual({ sleep: 1 });
    expect(
      scan(
        "function delay(attempt: number): number { return 2 ** attempt * 100; }",
      ),
    ).toEqual({});
    expect(scan("const wait = (n: number) => n + 1;")).toEqual({});
  });

  it("counts errorMessage-rule helpers that take unknown, any or an untyped param", () => {
    expect(
      scan("function errorMessage(error: unknown) { return String(error); }"),
    ).toEqual({ errorMessage: 1 });
    expect(
      scan("function describeError(error: any) { return String(error); }"),
    ).toEqual({ errorMessage: 1 });
    expect(
      scan("const messageOf = (error) => String(error);", "src/a.js"),
    ).toEqual({ errorMessage: 1 });
  });

  it("does not count errorMessage-rule helpers with a typed or missing param", () => {
    expect(
      scan(
        "function messageOf(record: StoredRecord) { return record.message; }",
      ),
    ).toEqual({});
    expect(scan("function errorText() { return 'x'; }")).toEqual({});
  });
});

describe("scanSource: streamSubscriptionLifecycle", () => {
  const REACT = "import { useEffect } from 'react';\n";

  it("counts a react module with a module-level Map and a refCount release", () => {
    const source = `${REACT}
      const sessions = new Map<string, { refCount: number }>();
      export function release(key: string) {
        const entry = sessions.get(key);
        if (entry === undefined) return;
        entry.refCount -= 1;
        if (entry.refCount === 0) sessions.delete(key);
      }
    `;
    expect(scan(source, "src/use-thing.tsx")).toEqual({
      streamSubscriptionLifecycle: 1,
    });
  });

  it("counts the consumers.size === 0 form", () => {
    const source = `${REACT}
      const registry = new Map<string, { consumers: Set<symbol> }>();
      export function leave(key: string, id: symbol) {
        const entry = registry.get(key);
        if (entry === undefined) return;
        entry.consumers.delete(id);
        if (entry.consumers.size === 0) registry.delete(key);
      }
    `;
    expect(scan(source, "src/use-thing.ts")).toEqual({
      streamSubscriptionLifecycle: 1,
    });
  });

  it("does not count the same module without the react import", () => {
    const source = `
      const sessions = new Map<string, { refCount: number }>();
      export function release(key: string) {
        const entry = sessions.get(key);
        if (entry === undefined) return;
        entry.refCount -= 1;
      }
    `;
    expect(scan(source)).toEqual({});
  });

  it("does not count a registry only handed to the shared hook", () => {
    const source = `${REACT}
      import { useSharedStreamSubscription } from './shared';
      const sessions = new Map<string, unknown>();
      export function useThing(key: string) {
        return useSharedStreamSubscription(sessions, key);
      }
    `;
    expect(scan(source, "src/use-thing.ts")).toEqual({});
  });

  it("does not count a module whose only module-level registry is a WeakMap", () => {
    const source = `${REACT}
      const sessions = new WeakMap<object, { refCount: number }>();
      export function release(key: object) {
        const entry = sessions.get(key);
        if (entry === undefined) return;
        entry.refCount -= 1;
      }
    `;
    expect(scan(source, "src/use-thing.ts")).toEqual({});
  });
});

describe("ratchetDiff", () => {
  const tracked = () => true;

  it("flags a file above its row", () => {
    const diff = ratchetDiff(
      new Map([["sleep", new Map([["a.ts", 2]])]]),
      { sleep: { "a.ts": 1 } },
      tracked,
    );
    expect(diff).toEqual({
      tooHigh: [{ rule: "sleep", file: "a.ts", actual: 2, baseline: 1 }],
      tooLow: [],
    });
  });

  it("flags a new file as above a baseline of zero", () => {
    const diff = ratchetDiff(
      new Map([["isRecord", new Map([["new.ts", 1]])]]),
      {},
      tracked,
    );
    expect(diff.tooHigh).toEqual([
      { rule: "isRecord", file: "new.ts", actual: 1, baseline: 0 },
    ]);
  });

  it("flags a file below its row, including one with no remaining definitions", () => {
    const diff = ratchetDiff(
      new Map([["sleep", new Map([["a.ts", 1]])]]),
      { sleep: { "a.ts": 2, "b.ts": 1 } },
      tracked,
    );
    expect(diff).toEqual({
      tooHigh: [],
      tooLow: [
        { rule: "sleep", file: "a.ts", actual: 1, baseline: 2 },
        { rule: "sleep", file: "b.ts", actual: 0, baseline: 1 },
      ],
    });
  });

  it("ignores a fallen row whose file is no longer tracked", () => {
    const diff = ratchetDiff(
      new Map(),
      { sleep: { "gone.ts": 1 } },
      (file) => file !== "gone.ts",
    );
    expect(diff).toEqual({ tooHigh: [], tooLow: [] });
  });
});

describe("nextBaseline", () => {
  it("refuses a rise even when another file fell", () => {
    const result = nextBaseline(
      new Map([
        [
          "sleep",
          new Map([
            ["a.ts", 2],
            ["b.ts", 0],
          ]),
        ],
      ]),
      { sleep: { "a.ts": 1, "b.ts": 3 } },
      false,
    );
    expect(result).toEqual({
      kind: "refused",
      tooHigh: [{ rule: "sleep", file: "a.ts", actual: 2, baseline: 1 }],
    });
  });

  it("writes a rise when the increase was accepted", () => {
    const result = nextBaseline(
      new Map([["sleep", new Map([["a.ts", 2]])]]),
      { sleep: { "a.ts": 1 } },
      true,
    );
    expect(result.kind).toBe("ok");
    expect(result.baseline.sleep).toEqual({ "a.ts": 2 });
  });

  it("writes a decrease without the flag, sorted, dropping zero rows", () => {
    const result = nextBaseline(
      new Map([
        [
          "sleep",
          new Map([
            ["z.ts", 1],
            ["a.ts", 1],
            ["m.ts", 0],
          ]),
        ],
      ]),
      { sleep: { "a.ts": 2, "m.ts": 1, "z.ts": 1 } },
      false,
    );
    expect(result.kind).toBe("ok");
    expect(Object.keys(result.baseline.sleep)).toEqual(["a.ts", "z.ts"]);
    expect(result.baseline.sleep).toEqual({ "a.ts": 1, "z.ts": 1 });
    expect(Object.keys(result.baseline).sort()).toEqual([
      "errorMessage",
      "isRecord",
      "productionSources",
      "sleep",
      "streamSubscriptionLifecycle",
    ]);
  });
});

describe("CLI", () => {
  const RULE_IDS = [
    "sleep",
    "isRecord",
    "errorMessage",
    "productionSources",
    "streamSubscriptionLifecycle",
  ];
  const SLEEP_COPY =
    "export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n";

  let repoDir;
  let configPath;

  function writeConfig(canonicalBySleep) {
    const rules = Object.fromEntries(
      RULE_IDS.map((id) => [
        id,
        {
          canonical: id === "sleep" ? canonicalBySleep : [],
          use: `use the shared ${id}`,
        },
      ]),
    );
    writeFileSync(
      configPath,
      `${JSON.stringify({ rules, baseline: {} }, null, 2)}\n`,
    );
  }

  function git(...args) {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  }

  function run(...flags) {
    return spawnSync("bun", [SCRIPT_PATH, configPath, ...flags], {
      cwd: repoDir,
      encoding: "utf8",
    });
  }

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "definition-ratchet-"));
    configPath = join(repoDir, "ratchet.json");
    git("init", "-q");
    mkdirSync(join(repoDir, "src"));
    writeFileSync(join(repoDir, "src", "copy.ts"), SLEEP_COPY);
    writeConfig([]);
    git("add", "src/copy.ts");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("fails a new copy, refuses --write alone, accepts --write --accept-increase, then passes", () => {
    const failing = run();
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain("src/copy.ts");
    expect(failing.stderr).toContain("use the shared sleep");

    const before = readFileSync(configPath, "utf8");
    const refused = run("--write");
    expect(refused.status).toBe(1);
    expect(readFileSync(configPath, "utf8")).toBe(before);

    const accepted = run("--write", ACCEPT_INCREASE_FLAG);
    expect(accepted.status).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).baseline.sleep).toEqual(
      {
        "src/copy.ts": 1,
      },
    );

    expect(run().status).toBe(0);
  });

  it("still scans the repository inside a commit hook, where git sets GIT_DIR", () => {
    mkdirSync(join(repoDir, "scripts"));
    configPath = join(repoDir, "scripts", "ratchet.json");
    writeConfig([]);
    const result = spawnSync("bun", [SCRIPT_PATH, configPath], {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: join(repoDir, ".git") },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/copy.ts");
  });

  it("does not count a canonical file listed in the config", () => {
    writeConfig(["src/copy.ts"]);
    expect(run().status).toBe(0);
  });

  it("exits 1 when a canonical path does not exist", () => {
    writeConfig(["src/missing.ts"]);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/missing.ts");
  });
});
