/**
 * Lockstep between the desktop's NSIS uninstaller macro and the CLI code that
 * actually creates the artifacts it removes.
 *
 * The macro (`clients/desktop/resources/bundle/uninstall-host-autostart.nsh`)
 * closes the OS-native-uninstall gap: removing Traycer through Add/Remove
 * Programs used to delete the app while leaving the `\Traycer\Host` Scheduled
 * Task and its launcher VBS behind, so the host kept starting at every logon.
 *
 * It necessarily HARDCODES the task name and the launcher path - NSIS cannot
 * import TypeScript, and the desktop package has no dependency on this one. So
 * the strings are duplicated, and duplication that nothing checks is exactly
 * how an uninstaller silently stops uninstalling: rename the task in
 * `windowsTaskName` and the macro keeps issuing `schtasks /Delete` against a
 * name that no longer exists, succeeding loudly and doing nothing.
 *
 * This test lives in the CLI package rather than the desktop one because this
 * package owns the source of truth. It reads the desktop's files by path (no
 * import), which is also why it can assert against the REAL committed macro
 * rather than a copy of its contents.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serviceLabelFor, windowsTaskName } from "../../label";
import { cliInstallHomeDir } from "../../../store/paths";

const DESKTOP_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "desktop",
);

function readDesktopJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(DESKTOP_ROOT, relativePath), "utf8"),
  ) as Record<string, unknown>;
}

/**
 * Resolves the macro through the SAME field electron-builder reads, rather
 * than by hardcoding the filename here. `nsis.include` is resolved against
 * `directories.buildResources` (app-builder-lib `getResource`), so a move of
 * either the file or the buildResources dir has to keep this readable.
 */
function readUninstallMacro(): string {
  const build = readDesktopJson("package.json").build as {
    readonly directories: { readonly buildResources: string };
    readonly nsis: { readonly include?: string };
  };
  const include = build.nsis.include;
  if (include === undefined) {
    throw new Error(
      "desktop package.json build.nsis.include is unset - the uninstaller macro is not wired in at all",
    );
  }
  const source = readFileSync(
    join(DESKTOP_ROOT, build.directories.buildResources, include),
    "utf8",
  );
  // The macro's OWN `!ifndef` defaults, read from the file rather than
  // restated here. This is the substitution an unstamped (production) build
  // gets, so a copy of it in this test could go stale against the `!define`
  // lines and quietly make every assertion below check the wrong string.
  //
  // Note this is deliberately NOT read from the release-target stamp: the
  // assertions compare against `windowsTaskName(serviceLabelFor("production"))`
  // plus an independent literal, and sourcing the expectation from the same
  // place the generator reads would turn a lockstep check into `X === X`.
  const defaults: Record<string, string> = {};
  for (const [, name, value] of source.matchAll(
    /^!define\s+(TRAYCER_WINDOWS_TASK_NAME|TRAYCER_WINDOWS_TASK_FOLDER|TRAYCER_HOST_LAUNCHER)\s+"([^"]*)"$/gm,
  )) {
    defaults[name] = value;
  }
  const missing = [
    "TRAYCER_WINDOWS_TASK_NAME",
    "TRAYCER_WINDOWS_TASK_FOLDER",
    "TRAYCER_HOST_LAUNCHER",
  ].filter((name) => defaults[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `uninstall-host-autostart.nsh declares no !define default for ${missing.join(", ")}; an unstamped build would expand the macro to an empty string and the uninstaller would delete nothing`,
    );
  }
  return source.replace(
    /\$\{(TRAYCER_WINDOWS_TASK_NAME|TRAYCER_WINDOWS_TASK_FOLDER|TRAYCER_HOST_LAUNCHER)\}/g,
    (_macro: string, name: string) => defaults[name] ?? "",
  );
}

describe("windows OS-native uninstall macro", () => {
  it("deletes the exact Scheduled Task name windowsTaskName() registers for production", () => {
    const expected = windowsTaskName(serviceLabelFor("production"));
    expect(expected).toBe("\\Traycer\\Host");
    // The delete is the fix; assert the real command, not just the name
    // appearing somewhere in a comment.
    expect(readUninstallMacro()).toContain(
      `schtasks /Delete /TN "${expected}" /F`,
    );
  });

  it("deletes the launcher at the path the Scheduled Task's action actually runs", () => {
    // `hiddenHostLauncherPath` is module-private in windows.ts, so rebuild it
    // from its two real inputs: `cliInstallHomeDir("production")` and the
    // launcher filename. The home dir is absolute and platform-native, so
    // compare the part BELOW the user profile, spelled the way NSIS spells it
    // (`$PROFILE\...`).
    const belowProfile = relative(homedir(), cliInstallHomeDir("production"));
    const windowsTail = belowProfile.split(/[\\/]/).join("\\");
    expect(windowsTail).toBe(".traycer\\cli");
    expect(readUninstallMacro()).toContain(
      `Delete "$PROFILE\\${windowsTail}\\host-start-hidden.vbs"`,
    );
  });

  it("never delimits an nsExec argument with a quote it also needs inside", () => {
    // NSIS accepts `"`, `'` and backtick as string delimiters but has NO
    // escape for the delimiter itself - doubling it (`''`) does not escape, it
    // ends the string early. The folder-cleanup command needs both `"` and `'`
    // for PowerShell, so it must be backtick-delimited. This is unverifiable
    // by any test that only greps for command substrings, and makensis is not
    // available on the dev/CI platforms this suite runs on, so the quoting is
    // pinned structurally instead.
    for (const line of readUninstallMacro().split("\n")) {
      const command = line.trim();
      if (!command.startsWith("nsExec::")) continue;
      let argument = command.slice(command.indexOf(" ") + 1).trim();
      // `nsExec::ExecToLog` accepts an optional `/TIMEOUT=<ms>` flag before
      // the delimited command string; skip it to reach the actual argument.
      const timeoutFlag = argument.match(/^\/TIMEOUT=\d+\s+/);
      if (timeoutFlag !== null)
        argument = argument.slice(timeoutFlag[0].length);
      const delimiter = argument[0];
      expect(["'", '"', "`"]).toContain(delimiter);
      expect(argument.endsWith(delimiter)).toBe(true);
      // The delimiter must not appear inside the argument at all.
      expect(argument.slice(1, -1)).not.toContain(delimiter);
    }
  });

  it("does NOT tear the autostart down during an in-place update", () => {
    // The catastrophic-regression guard. electron-builder runs the OLD
    // uninstaller with `--updated` as part of every update
    // (templates/nsis/include/installUtil.nsh), and `customUnInstall` is
    // inserted near the top of the un.Uninstall section, so it fires then too.
    // Unguarded, upgrading Traycer would delete the logon task and the host
    // would never start again after an update - strictly worse than the defect
    // the macro fixes.
    const macro = readUninstallMacro();
    expect(macro).toContain(`\${GetOptions} $R0 "--updated" $R1`);

    // `${GetOptions}` sets the error flag when the option is ABSENT, so
    // `${ifNot} ${Errors}` is the arm taken when `--updated` WAS passed - the
    // update - and every teardown command has to live in its `${else}`.
    //
    // Both arms are sliced and asserted, rather than only checking that the
    // delete follows the guard: that weaker form stays green when the two arms
    // are SWAPPED, which is precisely the inversion this test exists to catch.
    const optionIndex = macro.indexOf('"--updated"');
    const guardIndex = macro.indexOf("${ifNot} ${Errors}");
    const elseIndex = macro.indexOf("${else}", guardIndex);
    // The macro's OUTERMOST `${endIf}` closes the update guard; the ownership
    // branches nested inside the removal arm close with their own.
    const endIfIndex = macro.lastIndexOf("${endIf}");
    expect(optionIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(optionIndex);
    expect(elseIndex).toBeGreaterThan(guardIndex);
    expect(endIfIndex).toBeGreaterThan(elseIndex);

    const updateArm = macro.slice(guardIndex, elseIndex);
    const removalArm = macro.slice(elseIndex, endIfIndex);
    for (const command of [
      "schtasks /End",
      "schtasks /Delete",
      "host-start-hidden.vbs",
      "DeleteFolder('Traycer',0)",
    ]) {
      expect(removalArm).toContain(command);
      expect(updateArm).not.toContain(command);
    }
  });
});

// The macro's own ownership gate. The task name is machine-global, and an
// uninstaller elevated as an admin may end and delete ANOTHER user's task by
// the default task DACL, so every write on the task waits on a probe of whose
// task it is (the CLI's `windows-task-gate.ts` is the same rule). Pinned
// structurally, like the update guard above, because makensis is not available
// where this suite runs.
describe("windows OS-native uninstall macro: the task is ended and deleted only when it is this account's", () => {
  // Offsets of every executed `nsExec::` command containing `text` (a comment
  // that names a verb is not a command).
  function commandOffsets(macro: string, text: string): number[] {
    const offsets: number[] = [];
    let offset = 0;
    for (const line of macro.split("\n")) {
      if (line.trim().startsWith("nsExec::") && line.includes(text)) {
        offsets.push(offset + line.indexOf(text));
      }
      offset += line.length + 1;
    }
    return offsets;
  }

  // The probe is the one nsExec whose script reads the task's principal.
  function probeIndex(macro: string): number {
    return macro.indexOf("Definition.Principal.UserId");
  }

  // The `${if} $R1 == "0"` ... `${elseIf}` arm: end and delete.
  function ownedArm(macro: string): { start: number; end: number } {
    const start = macro.indexOf('${if} $R1 == "0"\n');
    const end = macro.indexOf("${elseIf}", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return { start, end };
  }

  it("asks whose task it is before any of the three writes", () => {
    const macro = readUninstallMacro();
    const probe = probeIndex(macro);
    expect(probe).toBeGreaterThan(-1);
    for (const write of [
      "schtasks /End",
      "schtasks /Delete",
      "DeleteFolder(",
    ]) {
      const offsets = commandOffsets(macro, write);
      expect(offsets, `${write} is executed`).toHaveLength(1);
      expect(offsets[0], `${write} comes after the probe`).toBeGreaterThan(
        probe,
      );
    }
  });

  it('/End and /Delete are each spelled once, and only under ${if} $R1 == "0"', () => {
    const macro = readUninstallMacro();
    const arm = ownedArm(macro);
    for (const write of ["schtasks /End", "schtasks /Delete"]) {
      const offsets = commandOffsets(macro, write);
      expect(offsets, `${write} is executed once`).toHaveLength(1);
      const first = offsets[0] ?? -1;
      expect(first).toBeGreaterThan(arm.start);
      expect(first).toBeLessThan(arm.end);
    }
  });

  it('the folder DeleteFolder is only under $R1 == "0" ${orIf} $R1 == "2" (the task is gone or was this account\'s)', () => {
    const macro = readUninstallMacro();
    const guard = macro.indexOf('${if} $R1 == "0"\n    ${orIf} $R1 == "2"');
    expect(guard).toBeGreaterThan(-1);
    const offsets = commandOffsets(macro, "DeleteFolder(");
    expect(offsets).toHaveLength(1);
    const deleteFolder = offsets[0] ?? -1;
    expect(deleteFolder).toBeGreaterThan(guard);
    // Nothing closes the guard between it and the delete.
    expect(macro.slice(guard, deleteFolder)).not.toContain("${endIf}");
  });

  it("the launcher Delete is unconditional within the removal arm: this account's own file goes whoever owns the task", () => {
    const macro = readUninstallMacro();
    const removalArmStart = macro.indexOf(
      "${else}",
      macro.indexOf("${ifNot} ${Errors}"),
    );
    const launcher = macro.indexOf('Delete "$PROFILE');
    expect(launcher).toBeGreaterThan(removalArmStart);
    // Every ${if} opened after the removal arm began has closed by the time
    // the launcher is deleted: it is not nested in an ownership branch.
    const before = macro.slice(removalArmStart, launcher);
    const opened = (before.match(/\$\{if\}/g) ?? []).length;
    const closed = (before.match(/\$\{endIf\}/g) ?? []).length;
    expect(opened).toBe(closed);
  });

  it("the probe tells 'no such task' (0x80070002 = -2147024894, or the folder's own 0x80070003 = -2147024893) from every other failure, and only those are absent", () => {
    const macro = readUninstallMacro();
    // The task can be missing two ways: `GetTask` fails with "file not
    // found" when the `\Traycer` folder exists but the task inside it
    // doesn't, or with "path not found" when the folder itself is gone.
    // Both mean "no such task", so both are folded into the same exit 2.
    expect(macro).toContain(
      "($$e.HResult -eq -2147024894) -or ($$e.HResult -eq -2147024893)){exit 2}",
    );
    // Any other failure to read the task fails closed (4), never as absent.
    expect(macro).toMatch(
      /-2147024894\) -or \(\$\$e\.HResult -eq -2147024893\)\)\{exit 2\};exit 4\}/,
    );
    // Another user's task is 3, this account's is 0.
    expect(macro).toContain("if($$u -ieq $$me){exit 0};exit 3");
  });

  it("names no account: nothing prints the principal or the caller's SID", () => {
    const macro = readUninstallMacro();
    const probe = probeIndex(macro);
    const probeLine = macro.slice(
      macro.lastIndexOf("nsExec::", probe),
      macro.indexOf("\n", probe),
    );
    // The probe emits nothing: it answers through its exit status alone.
    expect(probeLine).not.toMatch(
      /Write-(Host|Output|Verbose|Information)|\becho\b|\bOut-/i,
    );
    // No user-visible line interpolates the answer or either account.
    for (const line of macro.split("\n")) {
      if (!line.trim().startsWith("DetailPrint")) continue;
      expect(line).not.toContain("$R1");
      expect(line).not.toContain("$$");
      expect(line).not.toMatch(/S-1-\d/);
    }
  });
});
