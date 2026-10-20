import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWindowsDataRootCommands,
  ensurePrivateBootstrapDir,
  evaluateWindowsPrivateAcl,
  evaluateWindowsVolume,
  isTransientBootstrapEntryName,
  parseWindowsAclReport,
  parseWindowsChildAclReports,
  parseWindowsVolumeProbe,
  preparePrivateDataRoot,
  type DataRootTargetResult,
  type WindowsAclReport,
  type WindowsAclRule,
  type WindowsChildAclReport,
  type WindowsDataRootCommands,
  type WindowsVolumeProbe,
} from "../data-root-target";

const USER_SID = "S-1-5-21-1111-2222-3333-1001";
const OTHER_USER_SID = "S-1-5-21-1111-2222-3333-1002";
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const AUTHENTICATED_USERS_SID = "S-1-5-11";
const EVERYONE_SID = "S-1-1-0";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map(async (dir) => {
      // A test may leave a 0o500 directory behind.
      await chmod(dir, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

async function fixtureDir(): Promise<string> {
  // macOS tmpdir sits behind a /var symlink, which the flow refuses.
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "traycer-data-root-target-test-")),
  );
  dirs.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function refusalCode(result: DataRootTargetResult): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.code;
}

function allow(sid: string, inherited: boolean): WindowsAclRule {
  return { sid, allow: true, inherited };
}

function ownRules(inherited: boolean): WindowsAclRule[] {
  return [
    allow(USER_SID, inherited),
    allow(SYSTEM_SID, inherited),
    allow(ADMINISTRATORS_SID, inherited),
  ];
}

function goodReport(): WindowsAclReport {
  return {
    currentUserSid: USER_SID,
    ownerSid: USER_SID,
    protectedFromInheritance: true,
    rules: ownRules(false),
    childProbes: [ownRules(true), ownRules(true)],
  };
}

function reportWith(overrides: Partial<WindowsAclReport>): WindowsAclReport {
  return { ...goodReport(), ...overrides };
}

const FIXED_NTFS: WindowsVolumeProbe = {
  driveType: "Fixed",
  fileSystem: "NTFS",
  reparseInPath: false,
};

interface FakeCommands {
  readonly commands: WindowsDataRootCommands;
  readonly calls: string[];
  /** Entry count of the directory at the moment `applyPrivateAcl` ran. */
  readonly entriesAtApply: number[];
}

function fakeCommands(
  probe: WindowsVolumeProbe | Error,
  acl: WindowsAclReport | Error,
): FakeCommands {
  return fakeCommandsWithChildren(probe, acl, []);
}

function fakeCommandsWithChildren(
  probe: WindowsVolumeProbe | Error,
  acl: WindowsAclReport | Error,
  children: readonly WindowsChildAclReport[] | Error,
): FakeCommands {
  const calls: string[] = [];
  const entriesAtApply: number[] = [];
  const commands: WindowsDataRootCommands = {
    probeVolume: (path) => {
      calls.push(`probeVolume:${path}`);
      return probe instanceof Error
        ? Promise.reject(probe)
        : Promise.resolve(probe);
    },
    applyPrivateAcl: async (directory) => {
      calls.push(`applyPrivateAcl:${directory}`);
      entriesAtApply.push((await readdir(directory)).length);
      if (acl instanceof Error) throw acl;
      return acl;
    },
    readAcl: () => Promise.reject(new Error("readAcl is not expected")),
    securePrivateChildren: (directory) => {
      calls.push(`securePrivateChildren:${directory}`);
      return children instanceof Error
        ? Promise.reject(children)
        : Promise.resolve(children);
    },
  };
  return { commands, calls, entriesAtApply };
}

/** A clean record report: no explicit ACE, inheriting only the folder's grants. */
function cleanChildFile(
  overrides: Partial<WindowsAclReport>,
): WindowsChildAclReport {
  return {
    kind: "file",
    report: reportWith({
      protectedFromInheritance: false,
      rules: ownRules(true),
      childProbes: [],
      ...overrides,
    }),
  };
}

describe("evaluateWindowsVolume", () => {
  it("accepts a fixed NTFS volume, case-insensitively", () => {
    expect(evaluateWindowsVolume(FIXED_NTFS)).toBeNull();
    expect(
      evaluateWindowsVolume({ ...FIXED_NTFS, fileSystem: "ntfs" }),
    ).toBeNull();
  });

  it.each(["Network", "Removable", "Unknown", "NoRootDirectory"])(
    "refuses a %s drive",
    (driveType) => {
      const result = evaluateWindowsVolume({ ...FIXED_NTFS, driveType });
      expect(result).not.toBeNull();
      if (result !== null)
        expect(refusalCode(result)).toBe("unsupported-volume");
    },
  );

  it.each([null, "FAT32", "exFAT"])("refuses file system %s", (fileSystem) => {
    const result = evaluateWindowsVolume({ ...FIXED_NTFS, fileSystem });
    expect(result).not.toBeNull();
    if (result !== null) expect(refusalCode(result)).toBe("unsupported-volume");
  });

  it("refuses a reparse point in the path", () => {
    const result = evaluateWindowsVolume({
      ...FIXED_NTFS,
      reparseInPath: true,
    });
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(refusalCode(result)).toBe("unsupported-reparse-point");
    }
  });
});

describe("evaluateWindowsPrivateAcl", () => {
  function expectRefused(report: WindowsAclReport, isRoot: boolean): void {
    const result = evaluateWindowsPrivateAcl(report, isRoot);
    expect(result).not.toBeNull();
    if (result !== null)
      expect(refusalCode(result)).toBe("acl-not-established");
  }

  it("accepts a good root report", () => {
    expect(evaluateWindowsPrivateAcl(goodReport(), true)).toBeNull();
  });

  it("accepts Administrators as owner", () => {
    expect(
      evaluateWindowsPrivateAcl(
        reportWith({ ownerSid: ADMINISTRATORS_SID }),
        true,
      ),
    ).toBeNull();
  });

  it("refuses another owner", () => {
    expectRefused(reportWith({ ownerSid: OTHER_USER_SID }), true);
    expectRefused(reportWith({ ownerSid: OTHER_USER_SID }), false);
  });

  it.each([
    ["Authenticated Users", AUTHENTICATED_USERS_SID],
    ["Everyone", EVERYONE_SID],
    ["another user", OTHER_USER_SID],
  ])("refuses an extra allow rule for %s", (_name, sid) => {
    expectRefused(
      reportWith({ rules: [...ownRules(false), allow(sid, false)] }),
      true,
    );
  });

  it("accepts a deny rule for Everyone", () => {
    expect(
      evaluateWindowsPrivateAcl(
        reportWith({
          rules: [
            ...ownRules(false),
            { sid: EVERYONE_SID, allow: false, inherited: false },
          ],
        }),
        true,
      ),
    ).toBeNull();
  });

  it("refuses a root that is not protected from inheritance", () => {
    expectRefused(reportWith({ protectedFromInheritance: false }), true);
  });

  it("refuses a root with any inherited rule", () => {
    expectRefused(
      reportWith({
        rules: [
          allow(USER_SID, false),
          allow(SYSTEM_SID, true),
          allow(ADMINISTRATORS_SID, false),
        ],
      }),
      true,
    );
  });

  it("refuses a root that does not grant the current user", () => {
    expectRefused(
      reportWith({
        rules: [allow(SYSTEM_SID, false), allow(ADMINISTRATORS_SID, false)],
      }),
      true,
    );
  });

  it("refuses a root with no child probes", () => {
    expectRefused(reportWith({ childProbes: [] }), true);
  });

  it("refuses a root whose child probe grants a foreign SID", () => {
    expectRefused(
      reportWith({
        childProbes: [
          ownRules(true),
          [...ownRules(true), allow(EVERYONE_SID, true)],
        ],
      }),
      true,
    );
  });

  it("accepts inherited rules and no protection when not a root", () => {
    expect(
      evaluateWindowsPrivateAcl(
        reportWith({
          protectedFromInheritance: false,
          rules: ownRules(true),
          childProbes: [],
        }),
        false,
      ),
    ).toBeNull();
  });

  it("still refuses a foreign allow rule when not a root", () => {
    expectRefused(
      reportWith({
        protectedFromInheritance: false,
        rules: [...ownRules(true), allow(AUTHENTICATED_USERS_SID, true)],
      }),
      false,
    );
  });

  it("compares SIDs case-insensitively", () => {
    expect(
      evaluateWindowsPrivateAcl(
        {
          currentUserSid: USER_SID,
          ownerSid: USER_SID.toLowerCase(),
          protectedFromInheritance: true,
          rules: [
            allow(USER_SID.toLowerCase(), false),
            allow(SYSTEM_SID.toLowerCase(), false),
            allow(ADMINISTRATORS_SID.toLowerCase(), false),
          ],
          childProbes: [
            [
              allow(USER_SID.toLowerCase(), true),
              allow(SYSTEM_SID.toLowerCase(), true),
            ],
          ],
        },
        true,
      ),
    ).toBeNull();
  });
});

describe("parseWindowsAclReport", () => {
  const rule = { sid: USER_SID, allow: true, inherited: false };

  it("parses the plain array shape", () => {
    expect(
      parseWindowsAclReport(
        JSON.stringify({
          currentUserSid: USER_SID,
          ownerSid: USER_SID,
          protectedFromInheritance: true,
          rules: [rule],
          childProbes: [[rule], [rule]],
        }),
      ),
    ).toEqual({
      currentUserSid: USER_SID,
      ownerSid: USER_SID,
      protectedFromInheritance: true,
      rules: [rule],
      childProbes: [[rule], [rule]],
    });
  });

  it("normalizes PowerShell 5.1 collapsed shapes", () => {
    const parsed = parseWindowsAclReport(
      JSON.stringify({
        currentUserSid: USER_SID,
        ownerSid: USER_SID,
        protectedFromInheritance: false,
        rules: rule,
        childProbes: null,
      }),
    );
    expect(parsed.rules).toEqual([rule]);
    expect(parsed.childProbes).toEqual([]);
  });

  it("wraps a single collapsed child probe", () => {
    const parsed = parseWindowsAclReport(
      JSON.stringify({
        currentUserSid: USER_SID,
        ownerSid: USER_SID,
        protectedFromInheritance: true,
        rules: [rule],
        childProbes: rule,
      }),
    );
    expect(parsed.childProbes).toEqual([[rule]]);
  });

  it("accepts child probes holding single rule objects", () => {
    const parsed = parseWindowsAclReport(
      JSON.stringify({
        currentUserSid: USER_SID,
        ownerSid: USER_SID,
        protectedFromInheritance: true,
        rules: [rule],
        childProbes: [rule, [rule, rule]],
      }),
    );
    expect(parsed.childProbes).toEqual([[rule], [rule, rule]]);
  });

  it("treats a missing rules field as no rules", () => {
    const parsed = parseWindowsAclReport(
      JSON.stringify({
        currentUserSid: USER_SID,
        ownerSid: USER_SID,
        protectedFromInheritance: true,
      }),
    );
    expect(parsed.rules).toEqual([]);
  });

  it.each([
    ["not JSON", "not json"],
    ["a non-object", "[1,2]"],
    ["an empty object", "{}"],
    [
      "a non-boolean protection flag",
      JSON.stringify({
        currentUserSid: USER_SID,
        ownerSid: USER_SID,
        protectedFromInheritance: "yes",
        rules: [],
      }),
    ],
    [
      "a rule missing a field",
      JSON.stringify({
        currentUserSid: USER_SID,
        ownerSid: USER_SID,
        protectedFromInheritance: true,
        rules: [{ sid: USER_SID, allow: true }],
      }),
    ],
    [
      "a child probe rule with a bad type",
      JSON.stringify({
        currentUserSid: USER_SID,
        ownerSid: USER_SID,
        protectedFromInheritance: true,
        rules: [rule],
        childProbes: [[{ sid: 1, allow: true, inherited: false }]],
      }),
    ],
  ])("throws on %s", (_name, stdout) => {
    expect(() => parseWindowsAclReport(stdout)).toThrow();
  });
});

describe("parseWindowsVolumeProbe", () => {
  it("parses a ready drive", () => {
    expect(
      parseWindowsVolumeProbe(
        JSON.stringify({
          driveType: "Fixed",
          fileSystem: "NTFS",
          reparseInPath: false,
        }),
      ),
    ).toEqual(FIXED_NTFS);
  });

  it("maps a null file system to null", () => {
    expect(
      parseWindowsVolumeProbe(
        JSON.stringify({
          driveType: "Removable",
          fileSystem: null,
          reparseInPath: true,
        }),
      ),
    ).toEqual({
      driveType: "Removable",
      fileSystem: null,
      reparseInPath: true,
    });
  });

  it("only treats a literal true as a reparse point", () => {
    expect(
      parseWindowsVolumeProbe(
        JSON.stringify({
          driveType: "Fixed",
          fileSystem: "NTFS",
          reparseInPath: "true",
        }),
      ).reparseInPath,
    ).toBe(false);
  });

  it.each(["not json", "{}", JSON.stringify({ driveType: 3 })])(
    "throws on %s",
    (stdout) => {
      expect(() => parseWindowsVolumeProbe(stdout)).toThrow();
    },
  );
});

describe("createWindowsDataRootCommands", () => {
  it("passes the path as the runner's second argument, never inside the script", async () => {
    const seen: { script: string; path: string }[] = [];
    const path = "D:\\Weird Path\\ü データ";
    const commands = createWindowsDataRootCommands((script, runPath) => {
      seen.push({ script, path: runPath });
      if (seen.length === 1) {
        return Promise.resolve(
          JSON.stringify({
            driveType: "Fixed",
            fileSystem: "NTFS",
            reparseInPath: false,
          }),
        );
      }
      if (seen.length === 4) {
        return Promise.resolve(JSON.stringify([{ kind: "directory" }]));
      }
      return Promise.resolve(JSON.stringify(goodReport()));
    });

    expect(await commands.probeVolume(path)).toEqual(FIXED_NTFS);
    expect(await commands.applyPrivateAcl(path)).toEqual(goodReport());
    expect(await commands.readAcl(path)).toEqual(goodReport());
    expect(await commands.securePrivateChildren(path)).toEqual([
      { kind: "directory" },
    ]);

    expect(seen).toHaveLength(4);
    for (const call of seen) {
      expect(call.path).toBe(path);
      expect(call.script).not.toContain(path);
      expect(call.script).not.toContain("Weird Path");
      expect(call.script).toContain("TRAYCER_DATA_ROOT_PATH");
    }
  });

  it("rejects when the runner output is malformed", async () => {
    const commands = createWindowsDataRootCommands(() =>
      Promise.resolve("garbage"),
    );
    await expect(commands.probeVolume("D:\\x")).rejects.toThrow();
    await expect(commands.applyPrivateAcl("D:\\x")).rejects.toThrow();
    await expect(commands.readAcl("D:\\x")).rejects.toThrow();
    await expect(commands.securePrivateChildren("D:\\x")).rejects.toThrow();
  });
});

describe("parseWindowsChildAclReports", () => {
  const fileEntry = {
    kind: "file",
    report: {
      currentUserSid: USER_SID,
      ownerSid: USER_SID,
      protectedFromInheritance: false,
      rules: [{ sid: USER_SID, allow: true, inherited: true }],
      childProbes: null,
    },
  };

  it.each(["", "   \r\n"])(
    "returns no entries for empty output %j",
    (stdout) => {
      expect(parseWindowsChildAclReports(stdout)).toEqual([]);
    },
  );

  it("parses a single collapsed object", () => {
    expect(parseWindowsChildAclReports(JSON.stringify(fileEntry))).toEqual([
      {
        kind: "file",
        report: {
          currentUserSid: USER_SID,
          ownerSid: USER_SID,
          protectedFromInheritance: false,
          rules: [{ sid: USER_SID, allow: true, inherited: true }],
          childProbes: [],
        },
      },
    ]);
    expect(
      parseWindowsChildAclReports(JSON.stringify({ kind: "reparse" })),
    ).toEqual([{ kind: "reparse" }]);
  });

  it("parses an array mixing file, directory and reparse entries", () => {
    const parsed = parseWindowsChildAclReports(
      JSON.stringify([fileEntry, { kind: "directory" }, { kind: "reparse" }]),
    );
    expect(parsed.map((entry) => entry.kind)).toEqual([
      "file",
      "directory",
      "reparse",
    ]);
  });

  it.each([
    ["an unknown kind", JSON.stringify([{ kind: "socket" }])],
    ["a non-object entry", JSON.stringify([1])],
    ["a file entry without a report", JSON.stringify([{ kind: "file" }])],
    ["not JSON", "not json"],
  ])("throws on %s", (_name, stdout) => {
    expect(() => parseWindowsChildAclReports(stdout)).toThrow();
  });
});

describe.skipIf(process.platform === "win32")("preparePrivateDataRoot", () => {
  it("creates a fresh child of an existing parent, applying the ACL before anything is written", async () => {
    const base = await fixtureDir();
    const target = join(base, "root");
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: target,
      protectedRoots: [join(base, "protected")],
      platform: "posix",
      commands: fake.commands,
    });
    expect(result).toEqual({ ok: true, root: target, created: true });
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(fake.calls).toEqual([
      `probeVolume:${base}`,
      `applyPrivateAcl:${target}`,
    ]);
    expect(fake.entriesAtApply).toEqual([0]);
    expect(await readdir(target)).toEqual([]);
  });

  it("accepts an existing empty directory without creating it", async () => {
    const base = await fixtureDir();
    const target = join(base, "empty");
    await mkdir(target);
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: target,
      protectedRoots: [],
      platform: "posix",
      commands: fake.commands,
    });
    expect(result).toEqual({ ok: true, root: target, created: false });
    expect(fake.calls).toContain(`applyPrivateAcl:${target}`);
  });

  it("accepts a path with spaces and Unicode", async () => {
    const base = await fixtureDir();
    const target = join(base, "Traycer Data ✓ データ");
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: target,
      protectedRoots: [],
      platform: "posix",
      commands: fake.commands,
    });
    expect(result).toEqual({ ok: true, root: target, created: true });
  });

  it("refuses a populated directory, leaving it untouched", async () => {
    const base = await fixtureDir();
    const target = join(base, "populated");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "keep", "utf8");
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: target,
      protectedRoots: [],
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("populated");
    expect(await readdir(target)).toEqual(["keep.txt"]);
    expect(fake.calls.some((call) => call.startsWith("applyPrivateAcl"))).toBe(
      false,
    );
  });

  it.each([
    ["equal to", (protectedRoot: string) => protectedRoot],
    ["inside", (protectedRoot: string) => join(protectedRoot, "child")],
  ])("refuses a target %s a protected root", async (_name, targetFor) => {
    const base = await fixtureDir();
    const protectedRoot = join(base, "protected");
    const target = targetFor(protectedRoot);
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: target,
      protectedRoots: [protectedRoot],
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("overlaps-protected-root");
    expect(await exists(target)).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a target that contains a protected root", async () => {
    const base = await fixtureDir();
    const target = join(base, "outer");
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: target,
      protectedRoots: [join(target, "inner", "protected")],
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("overlaps-protected-root");
    expect(await exists(target)).toBe(false);
  });

  it("refuses a target reached through a symlinked parent into a protected root", async () => {
    const base = await fixtureDir();
    const protectedRoot = join(base, "protected");
    await mkdir(protectedRoot);
    const alias = join(base, "alias");
    await symlink(protectedRoot, alias);
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: join(alias, "new"),
      protectedRoots: [protectedRoot],
      platform: "posix",
      commands: fake.commands,
    });
    expect(result.ok).toBe(false);
    expect(["unsupported-reparse-point", "overlaps-protected-root"]).toContain(
      refusalCode(result),
    );
    expect(await readdir(protectedRoot)).toEqual([]);
  });

  it("refuses a symlink target itself", async () => {
    const base = await fixtureDir();
    const real = join(base, "real");
    await mkdir(real);
    const link = join(base, "link");
    await symlink(real, link);
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: link,
      protectedRoots: [],
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("unsupported-reparse-point");
    expect(await readdir(real)).toEqual([]);
  });

  it("refuses a missing parent", async () => {
    const base = await fixtureDir();
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: join(base, "missing", "root"),
      protectedRoots: [],
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("parent-missing");
    expect(await exists(join(base, "missing"))).toBe(false);
  });

  it("refuses a target that is a file", async () => {
    const base = await fixtureDir();
    const target = join(base, "a-file");
    await writeFile(target, "x", "utf8");
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: target,
      protectedRoots: [],
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("not-a-directory");
  });

  it("refuses an unsupported volume and creates nothing", async () => {
    const base = await fixtureDir();
    const target = join(base, "root");
    const fake = fakeCommands(
      { ...FIXED_NTFS, driveType: "Network" },
      goodReport(),
    );
    const result = await preparePrivateDataRoot({
      requested: target,
      protectedRoots: [],
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("unsupported-volume");
    expect(await exists(target)).toBe(false);
  });

  it("refuses when the volume probe throws", async () => {
    const base = await fixtureDir();
    const target = join(base, "root");
    const fake = fakeCommands(new Error("boom"), goodReport());
    const result = await preparePrivateDataRoot({
      requested: target,
      protectedRoots: [],
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("unsupported-volume");
    expect(await exists(target)).toBe(false);
  });

  it.each([
    [
      "a bad report",
      reportWith({ rules: [...ownRules(false), allow(EVERYONE_SID, false)] }),
    ],
    ["a thrown error", new Error("acl failed")],
  ])(
    "removes a directory it created when the ACL result is %s",
    async (_name, acl) => {
      const base = await fixtureDir();
      const target = join(base, "root");
      const fake = fakeCommands(FIXED_NTFS, acl);
      const result = await preparePrivateDataRoot({
        requested: target,
        protectedRoots: [],
        platform: "posix",
        commands: fake.commands,
      });
      expect(refusalCode(result)).toBe("acl-not-established");
      expect(await exists(target)).toBe(false);
    },
  );

  it.each([
    ["a bad report", reportWith({ ownerSid: OTHER_USER_SID })],
    ["a thrown error", new Error("acl failed")],
  ])(
    "leaves a pre-existing empty directory in place when the ACL result is %s",
    async (_name, acl) => {
      const base = await fixtureDir();
      const target = join(base, "root");
      await mkdir(target);
      const fake = fakeCommands(FIXED_NTFS, acl);
      const result = await preparePrivateDataRoot({
        requested: target,
        protectedRoots: [],
        platform: "posix",
        commands: fake.commands,
      });
      expect(refusalCode(result)).toBe("acl-not-established");
      expect((await stat(target)).isDirectory()).toBe(true);
    },
  );

  it("refuses an invalid path", async () => {
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await preparePrivateDataRoot({
      requested: "relative/root",
      protectedRoots: [],
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("invalid-path");
    expect(fake.calls).toEqual([]);
  });
});

describe("ensurePrivateBootstrapDir", () => {
  it.skipIf(process.platform === "win32")(
    "creates the directory with mode 0700",
    async () => {
      const base = await fixtureDir();
      const bootstrapDir = join(base, ".traycer-bootstrap");
      const fake = fakeCommands(FIXED_NTFS, goodReport());
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir,
        platform: "posix",
        commands: fake.commands,
      });
      expect(result).toEqual({ ok: true, root: bootstrapDir, created: true });
      expect((await stat(bootstrapDir)).mode & 0o777).toBe(0o700);
      expect(fake.calls).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "tightens an existing 0755 directory to 0700",
    async () => {
      const base = await fixtureDir();
      const bootstrapDir = join(base, ".traycer-bootstrap");
      await mkdir(bootstrapDir);
      await chmod(bootstrapDir, 0o755);
      const fake = fakeCommands(FIXED_NTFS, goodReport());
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir,
        platform: "posix",
        commands: fake.commands,
      });
      expect(result).toEqual({ ok: true, root: bootstrapDir, created: false });
      expect((await stat(bootstrapDir)).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts an existing non-empty directory",
    async () => {
      const base = await fixtureDir();
      const bootstrapDir = join(base, ".traycer-bootstrap");
      await mkdir(bootstrapDir, { mode: 0o700 });
      await writeFile(join(bootstrapDir, "location.json"), "{}", "utf8");
      const fake = fakeCommands(FIXED_NTFS, goodReport());
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir,
        platform: "posix",
        commands: fake.commands,
      });
      expect(result.ok).toBe(true);
      expect(await readdir(bootstrapDir)).toEqual(["location.json"]);
    },
  );

  it.skipIf(process.platform === "win32")("refuses a symlink", async () => {
    const base = await fixtureDir();
    const real = join(base, "real");
    await mkdir(real);
    const bootstrapDir = join(base, ".traycer-bootstrap");
    await symlink(real, bootstrapDir);
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await ensurePrivateBootstrapDir({
      bootstrapDir,
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("unsupported-reparse-point");
  });

  it("refuses a file", async () => {
    const base = await fixtureDir();
    const bootstrapDir = join(base, ".traycer-bootstrap");
    await writeFile(bootstrapDir, "x", "utf8");
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await ensurePrivateBootstrapDir({
      bootstrapDir,
      platform: "posix",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("not-a-directory");
  });

  it("applies and verifies the ACL on win32", async () => {
    const base = await fixtureDir();
    const bootstrapDir = join(base, ".traycer-bootstrap");
    const fake = fakeCommands(FIXED_NTFS, goodReport());
    const result = await ensurePrivateBootstrapDir({
      bootstrapDir,
      platform: "win32",
      commands: fake.commands,
    });
    expect(result).toEqual({ ok: true, root: bootstrapDir, created: true });
    expect(fake.calls).toEqual([
      `applyPrivateAcl:${bootstrapDir}`,
      `securePrivateChildren:${bootstrapDir}`,
    ]);
  });

  it.each([
    ["a bad report", reportWith({ protectedFromInheritance: false })],
    ["a thrown error", new Error("acl failed")],
  ])("maps %s to acl-not-established on win32", async (_name, acl) => {
    const base = await fixtureDir();
    const bootstrapDir = join(base, ".traycer-bootstrap");
    const fake = fakeCommands(FIXED_NTFS, acl);
    const result = await ensurePrivateBootstrapDir({
      bootstrapDir,
      platform: "win32",
      commands: fake.commands,
    });
    expect(refusalCode(result)).toBe("acl-not-established");
  });
});

describe("ensurePrivateBootstrapDir record protection", () => {
  async function bootstrapWith(
    base: string,
    setup: (dir: string) => Promise<void>,
  ): Promise<string> {
    const dir = join(base, ".traycer-bootstrap");
    await mkdir(dir, { mode: 0o700 });
    await setup(dir);
    return dir;
  }

  describe.skipIf(process.platform === "win32")("POSIX", () => {
    it("tightens a 0666 record to 0600 without changing its contents", async () => {
      const base = await fixtureDir();
      const dir = await bootstrapWith(base, async (bootstrap) => {
        await writeFile(
          join(bootstrap, "location.json"),
          '{"keep":true}',
          "utf8",
        );
        await chmod(join(bootstrap, "location.json"), 0o666);
        await chmod(bootstrap, 0o755);
      });
      const fake = fakeCommands(FIXED_NTFS, goodReport());
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir: dir,
        platform: "posix",
        commands: fake.commands,
      });
      expect(result).toEqual({ ok: true, root: dir, created: false });
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, "location.json"))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(dir, "location.json"), "utf8")).toBe(
        '{"keep":true}',
      );
    });

    it("leaves an already private record alone", async () => {
      const base = await fixtureDir();
      const dir = await bootstrapWith(base, async (bootstrap) => {
        await writeFile(join(bootstrap, "location.json"), "{}", {
          mode: 0o600,
        });
      });
      const fake = fakeCommands(FIXED_NTFS, goodReport());
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir: dir,
        platform: "posix",
        commands: fake.commands,
      });
      expect(result.ok).toBe(true);
      expect((await stat(join(dir, "location.json"))).mode & 0o777).toBe(0o600);
    });

    it("refuses a symlink child before chmodding anything", async () => {
      const base = await fixtureDir();
      const outside = join(base, "outside.txt");
      await writeFile(outside, "x", "utf8");
      await chmod(outside, 0o644);
      const dir = await bootstrapWith(base, async (bootstrap) => {
        await writeFile(join(bootstrap, "location.json"), "{}", "utf8");
        await chmod(join(bootstrap, "location.json"), 0o666);
        await symlink(outside, join(bootstrap, "link"));
        await chmod(bootstrap, 0o755);
      });
      const fake = fakeCommands(FIXED_NTFS, goodReport());
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir: dir,
        platform: "posix",
        commands: fake.commands,
      });
      expect(refusalCode(result)).toBe("unsupported-reparse-point");
      expect((await stat(dir)).mode & 0o777).toBe(0o755);
      expect((await stat(join(dir, "location.json"))).mode & 0o777).toBe(0o666);
      expect((await stat(outside)).mode & 0o777).toBe(0o644);
    });

    it("refuses a sub-folder child before chmodding anything", async () => {
      const base = await fixtureDir();
      const dir = await bootstrapWith(base, async (bootstrap) => {
        await mkdir(join(bootstrap, "nested"));
        await chmod(bootstrap, 0o755);
      });
      const fake = fakeCommands(FIXED_NTFS, goodReport());
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir: dir,
        platform: "posix",
        commands: fake.commands,
      });
      expect(refusalCode(result)).toBe("unsupported-entry");
      expect((await stat(dir)).mode & 0o777).toBe(0o755);
    });
  });

  describe("win32 (fake commands)", () => {
    it("refuses a symlink child without calling applyPrivateAcl", async () => {
      const base = await fixtureDir();
      const dir = await bootstrapWith(base, async (bootstrap) => {
        await symlink(base, join(bootstrap, "link"));
      });
      const fake = fakeCommands(FIXED_NTFS, goodReport());
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir: dir,
        platform: "win32",
        commands: fake.commands,
      });
      expect(refusalCode(result)).toBe("unsupported-reparse-point");
      expect(fake.calls).toEqual([]);
    });

    it("refuses a sub-folder child without calling applyPrivateAcl", async () => {
      const base = await fixtureDir();
      const dir = await bootstrapWith(base, async (bootstrap) => {
        await mkdir(join(bootstrap, "nested"));
      });
      const fake = fakeCommands(FIXED_NTFS, goodReport());
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir: dir,
        platform: "win32",
        commands: fake.commands,
      });
      expect(refusalCode(result)).toBe("unsupported-entry");
      expect(fake.calls).toEqual([]);
    });

    async function runWithChildren(
      children: readonly WindowsChildAclReport[] | Error,
    ): Promise<{
      result: DataRootTargetResult;
      fake: FakeCommands;
      dir: string;
    }> {
      const base = await fixtureDir();
      const dir = join(base, ".traycer-bootstrap");
      const fake = fakeCommandsWithChildren(FIXED_NTFS, goodReport(), children);
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir: dir,
        platform: "win32",
        commands: fake.commands,
      });
      return { result, fake, dir };
    }

    it("accepts a clean inherited-only record and calls apply then secure", async () => {
      const { result, fake, dir } = await runWithChildren([cleanChildFile({})]);
      expect(result.ok).toBe(true);
      expect(fake.calls).toEqual([
        `applyPrivateAcl:${dir}`,
        `securePrivateChildren:${dir}`,
      ]);
    });

    it("accepts an empty folder", async () => {
      const { result } = await runWithChildren([]);
      expect(result.ok).toBe(true);
    });

    it("refuses a reparse child reported by the secure step", async () => {
      const { result } = await runWithChildren([{ kind: "reparse" }]);
      expect(refusalCode(result)).toBe("unsupported-reparse-point");
    });

    it("refuses a directory child reported by the secure step", async () => {
      const { result } = await runWithChildren([{ kind: "directory" }]);
      expect(refusalCode(result)).toBe("unsupported-entry");
    });

    it("refuses a record with a foreign owner", async () => {
      const { result } = await runWithChildren([
        cleanChildFile({ ownerSid: OTHER_USER_SID }),
      ]);
      expect(refusalCode(result)).toBe("acl-not-established");
    });

    it("refuses a record with an explicit foreign allow ACE", async () => {
      const { result } = await runWithChildren([
        cleanChildFile({
          rules: [...ownRules(true), allow(OTHER_USER_SID, false)],
        }),
      ]);
      expect(refusalCode(result)).toBe("acl-not-established");
    });

    it("refuses a record that is still protected from inheritance", async () => {
      const { result } = await runWithChildren([
        cleanChildFile({ protectedFromInheritance: true }),
      ]);
      expect(refusalCode(result)).toBe("acl-not-established");
    });

    it("refuses a record that still has an own (non-inherited) rule", async () => {
      const { result } = await runWithChildren([
        cleanChildFile({
          rules: [
            allow(USER_SID, false),
            allow(SYSTEM_SID, true),
            allow(ADMINISTRATORS_SID, true),
          ],
        }),
      ]);
      expect(refusalCode(result)).toBe("acl-not-established");
    });

    it("refuses when any one of several records is unclean", async () => {
      const { result } = await runWithChildren([
        cleanChildFile({}),
        cleanChildFile({ ownerSid: OTHER_USER_SID }),
      ]);
      expect(refusalCode(result)).toBe("acl-not-established");
    });

    it("maps a thrown securePrivateChildren to acl-not-established", async () => {
      const { result } = await runWithChildren(new Error("secure failed"));
      expect(refusalCode(result)).toBe("acl-not-established");
    });

    it("does not secure the children when the folder ACL is bad", async () => {
      const base = await fixtureDir();
      const dir = join(base, ".traycer-bootstrap");
      const fake = fakeCommandsWithChildren(
        FIXED_NTFS,
        reportWith({ protectedFromInheritance: false }),
        [cleanChildFile({})],
      );
      const result = await ensurePrivateBootstrapDir({
        bootstrapDir: dir,
        platform: "win32",
        commands: fake.commands,
      });
      expect(refusalCode(result)).toBe("acl-not-established");
      expect(fake.calls).toEqual([`applyPrivateAcl:${dir}`]);
    });
  });
});

describe("isTransientBootstrapEntryName", () => {
  const UUID = "0b9f6d1e-5c34-4a8e-9f1d-2a7c3e8b4d10";
  const HEX32 = "0b9f6d1e5c344a8e9f1d2a7c3e8b4d10";

  it.each([
    `admission-${UUID}.json`,
    "admission.lock",
    "migration-coordinator.lock",
    `migration.json.${UUID}.tmp`,
    `location.json.${HEX32}.tmp`,
    `migration-m-${UUID}.json.${UUID}.tmp`,
    `migration-coordinator.lock.dead-${UUID}`,
    `admission.lock.dead-${UUID}`,
  ])("treats %s as transient", (name) => {
    expect(isTransientBootstrapEntryName(name)).toBe(true);
  });

  it.each([
    "location.json",
    "location.prev.json",
    "migration.json",
    "migration.prev.json",
    `migration-m-${UUID}.json`,
    `migration-m-${UUID}.prev.json`,
    "admission-short.json",
    "admission.json",
    "x.json.123.tmp",
    "something.tmp",
    "migration-coordinator.lock.dead-",
    "",
  ])("treats %j as a persistent record or unknown entry", (name) => {
    expect(isTransientBootstrapEntryName(name)).toBe(false);
  });
});

describe("parseWindowsChildAclReports vanished entries", () => {
  it("parses a vanished entry, alone or among others", () => {
    expect(
      parseWindowsChildAclReports(
        JSON.stringify({ kind: "vanished", name: "admission-x.json" }),
      ),
    ).toEqual([{ kind: "vanished", name: "admission-x.json" }]);
    expect(
      parseWindowsChildAclReports(
        JSON.stringify([
          { kind: "directory" },
          { kind: "vanished", name: "location.json" },
        ]),
      ),
    ).toEqual([
      { kind: "directory" },
      { kind: "vanished", name: "location.json" },
    ]);
  });

  it.each([
    ["without a name", JSON.stringify([{ kind: "vanished" }])],
    ["with a non-string name", JSON.stringify([{ kind: "vanished", name: 7 }])],
    ["with a null name", JSON.stringify([{ kind: "vanished", name: null }])],
  ])("rejects a vanished entry %s", (_name, stdout) => {
    expect(() => parseWindowsChildAclReports(stdout)).toThrow();
  });
});

describe("ensurePrivateBootstrapDir transient entries (win32 fake commands)", () => {
  const UUID = "0b9f6d1e-5c34-4a8e-9f1d-2a7c3e8b4d10";

  async function run(
    children: readonly WindowsChildAclReport[],
  ): Promise<DataRootTargetResult> {
    const base = await fixtureDir();
    const fake = fakeCommandsWithChildren(FIXED_NTFS, goodReport(), children);
    return ensurePrivateBootstrapDir({
      bootstrapDir: join(base, ".traycer-bootstrap"),
      platform: "win32",
      commands: fake.commands,
    });
  }

  it.each([
    `admission-${UUID}.json`,
    "admission.lock",
    `migration.json.${UUID}.tmp`,
  ])("skips a vanished transient entry %s", async (name) => {
    const result = await run([{ kind: "vanished", name }]);
    expect(result.ok).toBe(true);
  });

  it("skips a vanished transient entry beside clean records", async () => {
    const result = await run([
      cleanChildFile({}),
      { kind: "vanished", name: `admission-${UUID}.json` },
      cleanChildFile({}),
    ]);
    expect(result.ok).toBe(true);
  });

  it.each(["location.json", "migration.json", `migration-m-${UUID}.json`])(
    "refuses a vanished persistent record %s",
    async (name) => {
      const result = await run([{ kind: "vanished", name }]);
      expect(refusalCode(result)).toBe("unsupported-entry");
    },
  );

  it("still refuses a persistent record that vanished beside a transient one", async () => {
    const result = await run([
      { kind: "vanished", name: `admission-${UUID}.json` },
      { kind: "vanished", name: "location.json" },
    ]);
    expect(refusalCode(result)).toBe("unsupported-entry");
  });
});
