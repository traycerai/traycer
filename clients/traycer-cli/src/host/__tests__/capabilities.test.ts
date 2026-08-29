import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  HOST_CAPABILITIES,
  HOST_CAPABILITIES_VERSION,
  HOST_CAPABILITY_MAINTENANCE_LEASE_V1,
  HOST_CAPABILITY_MAINTENANCE_LEASE_V2,
  HOST_CAPABILITY_HOST_START_ADOPTION_V2,
  HOST_CAPABILITY_SERVICE_LABEL,
  runHostCapabilities,
} from "../capabilities";
import { COMPATIBLE_HOST_START_SCRIPT_PREFIX } from "../../service/platforms/host-start-script";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "index.ts",
);

/**
 * These tokens are a compatibility surface, not an implementation detail: an
 * emitted launchd plist / systemd unit / Scheduled Task asks an OLDER CLI
 * about them, so renaming one silently un-labels every registration that
 * probes it. Pinning the literal strings is the point of this file.
 */
describe("host capability tokens", () => {
  it("pins the exact token string emitters embed", () => {
    expect(HOST_CAPABILITY_SERVICE_LABEL).toBe("service-label");
    expect(HOST_CAPABILITY_HOST_START_ADOPTION_V2).toBe(
      "host-start-adoption-v2",
    );
    expect(HOST_CAPABILITY_MAINTENANCE_LEASE_V1).toBe("maintenance-lease-v1");
    expect(HOST_CAPABILITY_MAINTENANCE_LEASE_V2).toBe("maintenance-lease-v2");
  });

  it("pins the full advertised set, so adding or dropping a token is a deliberate edit", () => {
    expect(HOST_CAPABILITIES).toEqual([
      "service-label",
      "host-start-adoption-v2",
      "maintenance-lease-v1",
      "maintenance-lease-v2",
    ]);
  });
});

describe("runHostCapabilities", () => {
  it("answers --has with the exit code and no output at all", () => {
    expect(
      runHostCapabilities({ kind: "has", capability: "service-label" }),
    ).toEqual({ stdout: "", exitCode: 0 });
    expect(
      runHostCapabilities({ kind: "has", capability: "maintenance-lease-v1" }),
    ).toEqual({ stdout: "", exitCode: 0 });
    expect(
      runHostCapabilities({ kind: "has", capability: "maintenance-lease-v2" }),
    ).toEqual({ stdout: "", exitCode: 0 });
    expect(
      runHostCapabilities({
        kind: "has",
        capability: "host-start-adoption-v2",
      }),
    ).toEqual({ stdout: "", exitCode: 0 });
  });

  it("answers --has for an unknown token with a non-zero exit, never a crash", () => {
    expect(
      runHostCapabilities({ kind: "has", capability: "not-a-capability" }),
    ).toEqual({ stdout: "", exitCode: 1 });
  });

  it("emits a versioned JSON document for --json", () => {
    const response = runHostCapabilities({ kind: "list", json: true });
    expect(response.exitCode).toBe(0);
    expect(JSON.parse(response.stdout)).toEqual({
      v: HOST_CAPABILITIES_VERSION,
      capabilities: [
        "service-label",
        "host-start-adoption-v2",
        "maintenance-lease-v1",
        "maintenance-lease-v2",
      ],
    });
  });

  it("emits one token per line without --json", () => {
    expect(runHostCapabilities({ kind: "list", json: false })).toEqual({
      stdout:
        "service-label\nhost-start-adoption-v2\nmaintenance-lease-v1\nmaintenance-lease-v2\n",
      exitCode: 0,
    });
  });
});

/**
 * Executed against the real commander program, because the contract the
 * emitted scripts depend on is the PROCESS behaviour - exit code and stdout -
 * not the pure function above. In particular the emitted probes branch on the
 * exit code alone, so a command that printed the right thing while exiting
 * non-zero would silently un-label every registration.
 */
describe("`traycer host capabilities` as a subprocess", () => {
  it("exits 0 for a supported capability and writes nothing to stdout", async () => {
    const result = await execFileAsync("bun", [
      CLI_ENTRY,
      "host",
      "capabilities",
      "--has",
      "service-label",
    ]);
    expect(result.stdout).toBe("");
  });

  it("exits 0 for the target-bound maintenance lease v2 capability", async () => {
    const result = await execFileAsync("bun", [
      CLI_ENTRY,
      "host",
      "capabilities",
      "--has",
      "maintenance-lease-v2",
    ]);
    expect(result.stdout).toBe("");
  });

  it("exits 0 for the spawn-scoped host-start adoption capability", async () => {
    const result = await execFileAsync("bun", [
      CLI_ENTRY,
      "host",
      "capabilities",
      "--has",
      HOST_CAPABILITY_HOST_START_ADOPTION_V2,
    ]);
    expect(result.stdout).toBe("");
  });

  it("exits non-zero for an unsupported capability", async () => {
    await expect(
      execFileAsync("bun", [
        CLI_ENTRY,
        "host",
        "capabilities",
        "--has",
        "no-such-capability",
      ]),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("prints the JSON document on stdout", async () => {
    const result = await execFileAsync("bun", [
      CLI_ENTRY,
      "host",
      "capabilities",
      "--json",
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      v: 1,
      capabilities: [
        "service-label",
        "host-start-adoption-v2",
        "maintenance-lease-v1",
        "maintenance-lease-v2",
      ],
    });
  });

  // The whole reason this contract exists: `--service-label` used to be
  // detected by grepping `host start --help`, so applying the file's own
  // `.hideHelp()` convention to an "Internal:" option silently disabled the
  // identity binding everywhere. The options ARE hidden now - assert that,
  // and assert the capability answer is unaffected by it.
  it("keeps answering after --service-label was hidden from help output", async () => {
    const help = await execFileAsync("bun", [
      CLI_ENTRY,
      "host",
      "start",
      "--help",
    ]);
    expect(help.stdout).not.toContain("--service-label");

    const probe = await execFileAsync("bun", [
      CLI_ENTRY,
      "host",
      "capabilities",
      "--has",
      "service-label",
    ]);
    expect(probe.stdout).toBe("");
  });

  /**
   * Closes the loop between the two halves of the contract. Everywhere else
   * the emitted script is executed against a STUB CLI, which can only prove
   * the script's own branching. This runs the probe half of the real emitted
   * script against the REAL CLI, so a token the emitter asks for but the CLI
   * does not advertise (or vice versa) fails here rather than silently
   * un-labelling every registration in the field.
   *
   * Only the probe prefix is executed, never the `exec … host start` arms -
   * those would spawn a supervisor against the developer's own data dir.
   */
  it("the probe the emitters actually embed returns 0 against the real CLI", async () => {
    await expect(
      execFileAsync("/bin/sh", [
        "-c",
        `${COMPATIBLE_HOST_START_SCRIPT_PREFIX} >/dev/null 2>&1`,
        "bun",
        CLI_ENTRY,
      ]),
    ).resolves.toBeDefined();
  });

  it("that same probe returns non-zero when the token is not advertised", async () => {
    const wrongToken = COMPATIBLE_HOST_START_SCRIPT_PREFIX.replace(
      HOST_CAPABILITY_SERVICE_LABEL,
      "not-a-capability",
    );
    await expect(
      execFileAsync("/bin/sh", [
        "-c",
        `${wrongToken} >/dev/null 2>&1`,
        "bun",
        CLI_ENTRY,
      ]),
    ).rejects.toMatchObject({ code: 1 });
  });
}, 60_000);
