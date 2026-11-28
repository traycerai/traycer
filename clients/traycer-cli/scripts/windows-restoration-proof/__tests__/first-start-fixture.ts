import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostInstallRecordSchema } from "@traycer/protocol/config/installation-records";
import { readHostInstallRecordAtPath } from "@traycer/protocol/config/installation";
import { writeHostInstallRecordAt } from "../../../src/manifest/host-install";
import { buildWindowsHiddenHostLauncherBytes } from "../../../src/service/platforms/windows";
import type { ServiceLabel } from "../../../src/service/label";

export const proofHostVersion = "1.5.0";

export async function writeAndCheckProofInstall(
  executablePath: string,
): Promise<void> {
  const installDir = dirname(executablePath);
  const installedAt = new Date().toISOString();
  const record = hostInstallRecordSchema.parse({
    version: proofHostVersion,
    runtimeVersion: null,
    platform: "win32",
    arch: "x64",
    installId: "t18-disposable",
    installedAt,
    source: { kind: "local-file", value: executablePath },
    archiveSha256: null,
    executableSha256: createHash("sha256")
      .update(await readFile(executablePath))
      .digest("hex"),
    signatureVerifiedAt: installedAt,
    signatureKeyId: "local-file:unsigned",
    sizeBytes: (await stat(executablePath)).size,
    executablePath,
  });
  await writeHostInstallRecordAt(installDir, record);
  const readBack = await readHostInstallRecordAtPath(
    join(installDir, "install.json"),
  );
  if (
    readBack?.executablePath !== executablePath ||
    readBack.executableSha256 !== record.executableSha256
  )
    throw new Error(
      "The production reader did not round-trip the proof install record",
    );
}

const createShell = 'Set shell = CreateObject("WScript.Shell")';
const runChild = "  exitCode = shell.Run(commandLine, 0, True)";

export function proofLauncher(opts: {
  readonly cli: { readonly command: string; readonly args: string[] };
  readonly label: ServiceLabel;
  readonly fixtureVariables: readonly (readonly [string, string])[];
  readonly supervisorStderr: string;
  readonly cmdPath: string;
}): Buffer {
  const production = buildWindowsHiddenHostLauncherBytes(opts.cli, opts.label);
  const source = production.toString("utf16le");
  const vbsString = (value: string): string =>
    `"${value.replaceAll('"', '""')}"`;
  const instrumentedShell = [
    createShell,
    ...opts.fixtureVariables.map(
      ([key, value]) =>
        `shell.Environment("Process").Item("${key}") = ${vbsString(value)}`,
    ),
  ].join("\r\n");
  if (!source.includes(createShell) || !source.includes(runChild))
    throw new Error(
      "The production launcher no longer has the expected shell and runtime call",
    );
  const redirect = vbsString(` 2>"${opts.supervisorStderr}"`);
  const command = vbsString(`"${opts.cmdPath}" /d /s /c `);
  const instrumentedRun = `  exitCode = shell.Run(${command} & Chr(34) & commandLine & ${redirect} & Chr(34), 0, True)`;
  const bytes = Buffer.from(
    source
      .replace(createShell, instrumentedShell)
      .replace(runChild, instrumentedRun),
    "utf16le",
  );
  const recovered = Buffer.from(
    bytes
      .toString("utf16le")
      .replace(instrumentedRun, runChild)
      .replace(instrumentedShell, createShell),
    "utf16le",
  );
  if (bytes[0] !== 0xff || bytes[1] !== 0xfe || !recovered.equals(production))
    throw new Error(
      "The proof launcher changed the production script outside its fixture instrumentation",
    );
  return bytes;
}
