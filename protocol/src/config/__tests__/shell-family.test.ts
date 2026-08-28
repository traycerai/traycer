import { describe, expect, it } from "vitest";
import {
  windowsShellCaptionFamily,
  type WindowsShellCaptionFamily,
} from "../shell-family";

describe("windowsShellCaptionFamily", () => {
  const cases: ReadonlyArray<readonly [string, WindowsShellCaptionFamily]> = [
    // PowerShell 7 and Windows PowerShell 5.1 - both profile-probed.
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell"],
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "powershell",
    ],
    // Git Bash: bash.exe in an MSYS layout (`<install>\bin` / `<install>\usr\bin`),
    // regardless of the install directory name - PortableGit unzips anywhere.
    ["C:\\Program Files\\Git\\bin\\bash.exe", "git-bash"],
    ["C:\\Program Files\\Git\\usr\\bin\\bash.exe", "git-bash"],
    ["C:\\Tools\\PortableGit\\usr\\bin\\bash.exe", "git-bash"],
    // Any MSYS-layout bash is probed (deliberate broadening - a bash that can't
    // produce the cygpath dump degrades to the registry fallback on the host).
    ["C:\\msys64\\usr\\bin\\bash.exe", "git-bash"],
    // The Settings path is user-typed and may use forward slashes.
    ["C:/Program Files/Git/bin/bash.exe", "git-bash"],
    // System32's bash.exe is the legacy WSL launcher: never probed as Git
    // Bash, and it earns the same WSL boundary caption as wsl.exe.
    ["C:\\Windows\\System32\\bash.exe", "wsl"],
    // WSL runs agents as Windows processes.
    ["C:\\Windows\\System32\\wsl.exe", "wsl"],
    // cmd and any custom program get the registry-merged environment only.
    ["C:\\Windows\\System32\\cmd.exe", "other"],
    ["C:\\tools\\nu.exe", "other"],
  ];

  for (const [path, expected] of cases) {
    it(`classifies ${path} as ${expected}`, () => {
      expect(windowsShellCaptionFamily(path)).toBe(expected);
    });
  }

  it("is case-insensitive on the binary name and Git-install segment", () => {
    expect(
      windowsShellCaptionFamily("C:\\Program Files\\PowerShell\\7\\PWSH.EXE"),
    ).toBe("powershell");
    expect(
      windowsShellCaptionFamily("C:\\Program Files\\GIT\\BIN\\BASH.EXE"),
    ).toBe("git-bash");
  });
});
