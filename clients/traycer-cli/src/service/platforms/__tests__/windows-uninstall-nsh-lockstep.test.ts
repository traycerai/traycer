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
  return readFileSync(
    join(DESKTOP_ROOT, build.directories.buildResources, include),
    "utf8",
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
      const argument = command.slice(command.indexOf(" ") + 1).trim();
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
    // The teardown must sit in the branch taken when the flag is ABSENT.
    const guardIndex = macro.indexOf('"--updated"');
    const deleteIndex = macro.indexOf("schtasks /Delete");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(guardIndex);
    expect(macro.slice(guardIndex, deleteIndex)).toContain(
      "${ifNot} ${Errors}",
    );
  });
});
