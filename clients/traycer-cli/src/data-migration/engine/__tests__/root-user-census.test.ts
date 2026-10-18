import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessIncarnationProbe } from "@traycer/protocol/config/data-migration-admission";
import type { AttemptHolderLivenessVerdict } from "@traycer/protocol/config/host-update-attempt-liveness";
import {
  excludeCoordinator,
  interpretWindowsCensusOutput,
  posixRootUserCensus,
  WINDOWS_CENSUS_BOOTSTRAP,
  WINDOWS_ROOT_CENSUS_SCRIPT,
  windowsCensusArguments,
  type RootUserCensusResult,
} from "../root-user-census";
import { scratchScope } from "./engine-fixtures";

function windowsOutput(value: object): string {
  return JSON.stringify(value);
}

describe("interpretWindowsCensusOutput", () => {
  const clearBody = {
    users: [],
    uninspectable: [],
    foreign: [],
    unattributed: [],
    error: null,
  };

  it("reads an empty census as clear", () => {
    expect(interpretWindowsCensusOutput(windowsOutput(clearBody), 0)).toEqual({
      kind: "clear",
    });
  });

  it("reports the users it found, one entry per process", () => {
    const result = interpretWindowsCensusOutput(
      windowsOutput({
        ...clearBody,
        users: [
          { pid: 4242, name: "Code", evidence: "handle" },
          { pid: 4242, name: "Code", evidence: "image" },
          { pid: 77, name: null, evidence: "image" },
        ],
      }),
      0,
    );
    expect(result).toEqual({
      kind: "users",
      users: [
        { pid: 4242, name: "Code", evidence: "handle" },
        { pid: 77, name: null, evidence: "image" },
      ],
    });
  });

  it("reads ConvertTo-Json's single object (not an array) as one user", () => {
    const result = interpretWindowsCensusOutput(
      windowsOutput({
        users: { pid: 9, name: "cmd", evidence: "handle" },
        uninspectable: null,
        foreign: null,
        unattributed: null,
        error: null,
      }),
      0,
    );
    expect(result).toEqual({
      kind: "users",
      users: [{ pid: 9, name: "cmd", evidence: "handle" }],
    });
  });

  it("reads missing or null lists as empty, including an absent foreign and unattributed list", () => {
    expect(
      interpretWindowsCensusOutput(
        windowsOutput({ users: null, error: null }),
        0,
      ),
    ).toEqual({ kind: "clear" });
    expect(
      interpretWindowsCensusOutput(windowsOutput({ error: null }), 0),
    ).toEqual({ kind: "clear" });
    expect(
      interpretWindowsCensusOutput(
        windowsOutput({
          users: [],
          uninspectable: [],
          foreign: [],
          error: null,
        }),
        0,
      ),
    ).toEqual({ kind: "clear" });
    expect(
      interpretWindowsCensusOutput(
        windowsOutput({ ...clearBody, unattributed: null }),
        0,
      ),
    ).toEqual({ kind: "clear" });
  });

  const ONE_USER = { pid: 1, name: "a", evidence: "handle" };

  it("a foreign list with no users reads as clear: another account's processes never decide", () => {
    const result = interpretWindowsCensusOutput(
      windowsOutput({
        ...clearBody,
        foreign: [
          { pid: 12, name: "other-user-app" },
          { pid: 13, name: null },
        ],
      }),
      0,
    );
    expect(result).toEqual({ kind: "clear" });
  });

  it("a single foreign object (ConvertTo-Json's one-element form) reads as clear", () => {
    expect(
      interpretWindowsCensusOutput(
        windowsOutput({ ...clearBody, foreign: { pid: 12, name: "x" } }),
        0,
      ),
    ).toEqual({ kind: "clear" });
  });

  it("foreign processes plus users report exactly those users", () => {
    const result = interpretWindowsCensusOutput(
      windowsOutput({
        ...clearBody,
        users: [ONE_USER],
        foreign: [{ pid: 12, name: null }],
      }),
      0,
    );
    expect(result).toEqual({ kind: "users", users: [ONE_USER] });
  });

  it("an unattributed list reads as clear", () => {
    const result = interpretWindowsCensusOutput(
      windowsOutput({
        ...clearBody,
        unattributed: [
          { pid: 5, name: "svc" },
          { pid: 6, name: null },
        ],
      }),
      0,
    );
    expect(result).toEqual({ kind: "clear" });
  });

  it("a single unattributed object reads as clear", () => {
    expect(
      interpretWindowsCensusOutput(
        windowsOutput({ ...clearBody, unattributed: { pid: 5, name: "svc" } }),
        0,
      ),
    ).toEqual({ kind: "clear" });
  });

  it("unattributed processes plus users report exactly those users", () => {
    const result = interpretWindowsCensusOutput(
      windowsOutput({
        ...clearBody,
        users: [ONE_USER],
        unattributed: [{ pid: 5, name: null }],
      }),
      0,
    );
    expect(result).toEqual({ kind: "users", users: [ONE_USER] });
  });

  const manyUnattributed = Array.from({ length: 111 }, (_, index) => ({
    pid: 1000 + index,
    name: null,
  }));

  it("the 718-8 P1 shape (111 unattributed, no users, no uninspectable) reads as clear", () => {
    expect(
      interpretWindowsCensusOutput(
        windowsOutput({ ...clearBody, unattributed: manyUnattributed }),
        0,
      ),
    ).toEqual({ kind: "clear" });
  });

  it("the P1 shape plus own-account uninspectable processes (ctfmon, DefenderSessionHelper, taskhostw) reads as clear", () => {
    const result = interpretWindowsCensusOutput(
      windowsOutput({
        ...clearBody,
        unattributed: manyUnattributed,
        uninspectable: [
          {
            pid: 2100,
            name: "ctfmon",
            reason: "its handles could not be opened for inspection",
          },
          {
            pid: 2200,
            name: "DefenderSessionHelper",
            reason: "its handles could not be opened for inspection",
          },
          {
            pid: 2300,
            name: "taskhostw",
            reason: "a handle's path could not be resolved",
          },
        ],
      }),
      0,
    );
    expect(result).toEqual({ kind: "clear" });
  });

  it("uninspectable processes plus a found holder report exactly that holder as users", () => {
    const holder = { pid: 1, name: "a", evidence: "handle" };
    const result = interpretWindowsCensusOutput(
      windowsOutput({
        ...clearBody,
        users: [holder],
        uninspectable: [
          {
            pid: 2,
            name: "elevated",
            reason: "its handles could not all be inspected",
          },
        ],
      }),
      0,
    );
    expect(result).toEqual({ kind: "users", users: [holder] });
  });

  it("a single uninspectable object (ConvertTo-Json's one-element form) reads as clear", () => {
    const result = interpretWindowsCensusOutput(
      windowsOutput({
        ...clearBody,
        uninspectable: { pid: 2, name: null, reason: "denied" },
      }),
      0,
    );
    expect(result).toEqual({ kind: "clear" });
  });

  it("is unprovable when the helper reported an error", () => {
    expect(
      interpretWindowsCensusOutput(
        windowsOutput({ ...clearBody, error: "handle table too large" }),
        0,
      ).kind,
    ).toBe("unprovable");
  });

  it.each([
    { name: "not JSON", stdout: "powershell banner", exit: 0 },
    { name: "an empty string", stdout: "", exit: 0 },
    { name: "a non-zero exit", stdout: windowsOutput(clearBody), exit: 1 },
    {
      name: "a killed helper (null exit)",
      stdout: windowsOutput(clearBody),
      exit: null,
    },
    {
      name: "an unknown extra field",
      stdout: windowsOutput({ ...clearBody, extra: true }),
      exit: 0,
    },
    {
      name: "a missing error field",
      stdout: windowsOutput({
        users: [],
        uninspectable: [],
        foreign: [],
        unattributed: [],
      }),
      exit: 0,
    },
    {
      name: "an unattributed entry with an extra field",
      stdout: windowsOutput({
        ...clearBody,
        unattributed: [{ pid: 1, name: null, extra: 1 }],
      }),
      exit: 0,
    },
    {
      name: "a foreign entry with an extra field",
      stdout: windowsOutput({
        ...clearBody,
        foreign: [{ pid: 1, name: null, extra: 1 }],
      }),
      exit: 0,
    },
    {
      name: "a non-integer pid",
      stdout: windowsOutput({
        ...clearBody,
        users: [{ pid: 1.5, name: "x", evidence: "handle" }],
      }),
      exit: 0,
    },
    { name: "a JSON array", stdout: "[]", exit: 0 },
  ])("fails closed for $name", ({ stdout, exit }) => {
    expect(interpretWindowsCensusOutput(stdout, exit).kind).toBe("unprovable");
  });
});

describe("Windows census transport", () => {
  it("keeps the whole command line far under the CreateProcess limit and the encoded bootstrap under 1,000 characters", () => {
    const args = windowsCensusArguments();
    expect(args.join(" ").length).toBeLessThan(32_767);
    const flagIndex = args.indexOf("-EncodedCommand");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    const encoded = args[flagIndex + 1] ?? "";
    expect(encoded.length).toBeGreaterThan(0);
    expect(encoded.length).toBeLessThan(1_000);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(
      WINDOWS_CENSUS_BOOTSTRAP,
    );
  });

  it("sends the script over stdin: the bootstrap reads all of it and the script is not on the command line", () => {
    expect(WINDOWS_CENSUS_BOOTSTRAP).toContain("[Console]::In.ReadToEnd()");
    expect(windowsCensusArguments().join(" ")).not.toContain(
      "TraycerRootCensus",
    );
  });

  it("the script is ASCII-only, so its encoding on stdin cannot be mangled", () => {
    expect(/^[\x00-\x7F]*$/u.test(WINDOWS_ROOT_CENSUS_SCRIPT)).toBe(true);
  });

  // The script runs only on Windows, so its final classification is pinned by
  // text: a process with image (or any) evidence is a user even when some of
  // its handles could not be read, since an unread handle never decides.
  it("the script reports any found evidence as a user, even with handles left unread", () => {
    expect(WINDOWS_ROOT_CENSUS_SCRIPT).toContain(
      "if ($null -ne $p.Evidence) { $out.users += @{ pid = $p.Pid; name = $p.Name; evidence = $p.Evidence } }",
    );
    expect(WINDOWS_ROOT_CENSUS_SCRIPT).not.toContain(
      "$null -eq $p.Unread)) { $out.users",
    );
  });
});

class ScriptedProbe implements ProcessIncarnationProbe {
  readonly asked: { readonly pid: number; readonly recorded: string | null }[] =
    [];

  constructor(
    private readonly verdicts: ReadonlyMap<
      number,
      AttemptHolderLivenessVerdict
    >,
  ) {}

  ownStartIdentity(): Promise<string | null> {
    return Promise.resolve("start-identity");
  }

  liveness(): Promise<"alive" | "dead" | "indeterminate"> {
    return Promise.resolve("alive");
  }

  verdict(
    pid: number,
    recorded: string | null,
  ): Promise<AttemptHolderLivenessVerdict> {
    this.asked.push({ pid, recorded });
    return Promise.resolve(this.verdicts.get(pid) ?? "dead");
  }
}

describe("excludeCoordinator", () => {
  const COORDINATOR = { pid: 100, startIdentity: "start-identity" };
  const aliveSame = (): ScriptedProbe =>
    new ScriptedProbe(
      new Map<number, AttemptHolderLivenessVerdict>([[100, "alive-same"]]),
    );

  it("returns a clear or unprovable result unchanged", async () => {
    expect(
      await excludeCoordinator({ kind: "clear" }, COORDINATOR, aliveSame()),
    ).toEqual({ kind: "clear" });
    const unprovable: RootUserCensusResult = {
      kind: "unprovable",
      reason: "x",
    };
    expect(await excludeCoordinator(unprovable, COORDINATOR, aliveSame())).toBe(
      unprovable,
    );
  });

  it("drops the coordinator when its pid matches, its only use is its image and the incarnation is alive-same", async () => {
    const probe = aliveSame();
    const result = await excludeCoordinator(
      {
        kind: "users",
        users: [{ pid: 100, name: "traycer", evidence: "image" }],
      },
      COORDINATOR,
      probe,
    );
    expect(result).toEqual({ kind: "clear" });
    expect(probe.asked).toEqual([{ pid: 100, recorded: "start-identity" }]);
  });

  it("keeps every other user and drops only the coordinator", async () => {
    const result = await excludeCoordinator(
      {
        kind: "users",
        users: [
          { pid: 100, name: "traycer", evidence: "image" },
          { pid: 200, name: "editor", evidence: "handle" },
          { pid: 300, name: "shell", evidence: "image" },
        ],
      },
      COORDINATOR,
      aliveSame(),
    );
    expect(result).toEqual({
      kind: "users",
      users: [
        { pid: 200, name: "editor", evidence: "handle" },
        { pid: 300, name: "shell", evidence: "image" },
      ],
    });
  });

  it.each(["cwd", "handle"])(
    "keeps the coordinator when its use is %s, not the image",
    async (evidence) => {
      const result = await excludeCoordinator(
        { kind: "users", users: [{ pid: 100, name: "traycer", evidence }] },
        COORDINATOR,
        aliveSame(),
      );
      expect(result).toEqual({
        kind: "users",
        users: [{ pid: 100, name: "traycer", evidence }],
      });
    },
  );

  it.each<AttemptHolderLivenessVerdict>(["dead", "indeterminate"])(
    "keeps the user when the verdict is %s",
    async (verdict) => {
      const probe = new ScriptedProbe(
        new Map<number, AttemptHolderLivenessVerdict>([[100, verdict]]),
      );
      const result = await excludeCoordinator(
        {
          kind: "users",
          users: [{ pid: 100, name: "traycer", evidence: "image" }],
        },
        COORDINATOR,
        probe,
      );
      expect(result.kind).toBe("users");
    },
  );

  it("keeps the user when the coordinator has no start identity, without asking the probe", async () => {
    const probe = aliveSame();
    const result = await excludeCoordinator(
      {
        kind: "users",
        users: [{ pid: 100, name: "traycer", evidence: "image" }],
      },
      { pid: 100, startIdentity: null },
      probe,
    );
    expect(result.kind).toBe("users");
    expect(probe.asked).toEqual([]);
  });

  it("keeps a different pid with image evidence", async () => {
    const result = await excludeCoordinator(
      {
        kind: "users",
        users: [{ pid: 101, name: "traycer", evidence: "image" }],
      },
      COORDINATOR,
      aliveSame(),
    );
    expect(result.kind).toBe("users");
  });
});

const hasLsof =
  process.platform !== "win32" &&
  spawnSync("lsof", ["-v"], { stdio: "ignore" }).error === undefined;

describe.skipIf(process.platform === "win32")(
  "posixRootUserCensus",
  { timeout: 90_000 },
  () => {
    const scratch = scratchScope();
    const children: ChildProcess[] = [];

    afterEach(async () => {
      for (const child of children.splice(0)) await killAndWait(child);
    });

    async function killAndWait(child: ChildProcess): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
    }

    function sleepMs(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function privateRoot(): Promise<string> {
      const root = join(await scratch.create(), "root");
      await mkdir(root, { mode: 0o700 });
      await chmod(root, 0o700);
      return root;
    }

    const uid = process.getuid?.() ?? -1;

    function run(root: string): Promise<RootUserCensusResult> {
      return posixRootUserCensus({ uid }).census({
        root,
        signal: new AbortController().signal,
      });
    }

    /** Polls until `pid` is reported (the child needs a moment to chdir/open), or the census cannot decide. */
    async function waitForUser(
      root: string,
      pid: number,
    ): Promise<RootUserCensusResult> {
      let last: RootUserCensusResult = { kind: "clear" };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        last = await run(root);
        if (last.kind === "unprovable") return last;
        if (
          last.kind === "users" &&
          last.users.some((user) => user.pid === pid)
        )
          return last;
        await sleepMs(150);
      }
      return last;
    }

    it("is unprovable for a data folder other accounts can read", async () => {
      const root = join(await scratch.create(), "open-root");
      await mkdir(root);
      await chmod(root, 0o755);
      const result = await run(root);
      expect(result.kind).toBe("unprovable");
      expect(result.kind === "unprovable" ? result.reason : "").toContain(
        "other accounts",
      );
    });

    describe.skipIf(!hasLsof)("with ps and lsof", () => {
      it("reports a process whose working directory is inside the root, and is clear once it is gone", async (context) => {
        const root = await privateRoot();
        const child = spawn("sleep", ["30"], { cwd: root, stdio: "ignore" });
        children.push(child);
        const pid = child.pid;
        if (pid === undefined)
          throw new Error("the helper process did not start");
        const found = await waitForUser(root, pid);
        if (found.kind === "unprovable") context.skip();
        expect(found.kind).toBe("users");
        if (found.kind !== "users") return;
        const user = found.users.find((entry) => entry.pid === pid);
        expect(user).toMatchObject({ pid, evidence: "cwd", name: "sleep" });

        await killAndWait(child);
        const after = await run(root);
        if (after.kind === "unprovable") context.skip();
        expect(after).toEqual({ kind: "clear" });
      });

      it("reports a process that holds a file open inside the root", async (context) => {
        const root = await privateRoot();
        const file = join(root, "held-open.txt");
        await writeFile(file, "held");
        const outside = await scratch.create();
        const child = spawn("sh", ["-c", `exec 3< "${file}"; exec sleep 30`], {
          cwd: outside,
          stdio: "ignore",
        });
        children.push(child);
        const pid = child.pid;
        if (pid === undefined)
          throw new Error("the helper process did not start");
        const found = await waitForUser(root, pid);
        if (found.kind === "unprovable") context.skip();
        expect(found.kind).toBe("users");
        if (found.kind !== "users") return;
        expect(found.users.find((entry) => entry.pid === pid)?.evidence).toBe(
          "handle",
        );
      });

      it("the census itself reports every user, this process included (excluding it is the caller's decision)", async (context) => {
        const root = await privateRoot();
        const child = spawn("sleep", ["30"], { cwd: root, stdio: "ignore" });
        children.push(child);
        const pid = child.pid;
        if (pid === undefined)
          throw new Error("the helper process did not start");
        const seen = await waitForUser(root, pid);
        if (seen.kind !== "users") {
          context.skip();
          return;
        }
        const again = await run(root);
        if (again.kind !== "users") {
          context.skip();
          return;
        }
        expect(again.users.some((user) => user.pid === pid)).toBe(true);
      });

      it("a working directory or handle outranks the image for the same pid", async (context) => {
        const root = await privateRoot();
        // A copy of the shell's `sleep` inside the root: its image is in the root, and so is its cwd.
        const child = spawn("sleep", ["30"], { cwd: root, stdio: "ignore" });
        children.push(child);
        const pid = child.pid;
        if (pid === undefined)
          throw new Error("the helper process did not start");
        const found = await waitForUser(root, pid);
        if (found.kind !== "users") {
          context.skip();
          return;
        }
        expect(found.users.find((user) => user.pid === pid)?.evidence).not.toBe(
          "image",
        );
      });
    });
  },
);
