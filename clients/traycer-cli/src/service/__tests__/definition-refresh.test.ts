import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// `createServiceDefinitionRefresher`'s `run` wrapper
// (`definition-refresh.ts:52-56`) re-checks `verifyServiceMutationAuthority`
// immediately before EVERY service-manager call it makes - not once, up
// front, at the refresher's own entry. Forced onto the Linux branch (the
// simplest of the three platform refreshers) so the mechanism is exercised
// without needing a real systemd/launchd/schtasks environment.
// HOME isolation: this suite never resolves `resolveServiceCliInvocation`
// (the CLI invocation is parsed from the redirected unit file below, never
// staged into the well-known slot) and touches only `serviceManifestPath`,
// which is also redirected below - so no code path here reaches
// `os.homedir()`. Redirecting it anyway, defensively, costs nothing and
// removes the need to re-derive that argument if a future test in this file
// adds a path that does.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: mkdtempSyncForHome } = await import("node:fs");
  const { join: joinForHome } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSyncForHome(
      joinForHome(actual.tmpdir(), "traycer-definition-refresh-os-home-"),
    );
  }
  return {
    ...actual,
    platform: () => "linux" as const,
    homedir: () => osHome.current,
  };
});

// Isolation: `serviceManifestPath` normally resolves under the real
// `~/.config/systemd/user/`, exactly as `linux-definition-refresh.test.ts`
// redirects it.
const TEST_UNIT_DIR = mkdtempSync(
  join(tmpdir(), "traycer-definition-refresh-test-"),
);
vi.mock("../label", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../label")>();
  return {
    ...actual,
    serviceManifestPath: (label: { readonly id: string }) =>
      join(TEST_UNIT_DIR, `${label.id}.service`),
  };
});

afterAll(async () => {
  await rm(TEST_UNIT_DIR, { recursive: true, force: true });
  if (osHome.current !== "") {
    await rm(osHome.current, { recursive: true, force: true });
  }
});

import { createServiceDefinitionRefresher } from "../definition-refresh";
import { withServiceMutationAuthority } from "../mutation-authority";
import { serviceManifestPath, type ServiceLabel } from "../label";
import { readFile } from "node:fs/promises";

function labelFor(id: string): ServiceLabel {
  return {
    id,
    displayName: "Traycer Host (test)",
    environment: "dev",
    devSlot: null,
  };
}

function quoteExecStartToken(arg: string): string {
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A STALE unit (an old ExecStart shape `buildSystemdUnit` never emits), so
 * `refresh` has a write and at least one `systemctl` call to make. */
function historicalUnit(label: ServiceLabel): string {
  const execStart = ["/usr/local/bin/traycer", "host", "start"]
    .map(quoteExecStartToken)
    .join(" ");
  return `[Unit]
Description=${label.displayName}
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

describe("createServiceDefinitionRefresher: the runner re-verifies authority before EVERY call", () => {
  it("a live-then-lost verifier rejects from the wrapper's OWN pre-call check, before the real runner ever runs", async () => {
    const label = labelFor("definition-refresh-runner-reverify");
    await mkdir(TEST_UNIT_DIR, { recursive: true });
    await writeFile(
      join(TEST_UNIT_DIR, `${label.id}.service`),
      historicalUnit(label),
      "utf8",
    );

    // The full call sequence for a successful refresh of this fixture is:
    // 1) `withServiceMutationAuthority`'s own entry check; 2-3) two checks
    // inside `replaceDefinitionFile` (before the write, before the rename);
    // 4) the `run` wrapper's OWN check, immediately before it would hand off
    // to the real `systemctl` runner (see the control test below, which
    // counts all four on the happy path). Failing exactly at #4 isolates
    // the runner wrapper's check from the file-write's own checks.
    let verifyCalls = 0;
    const verify = vi.fn(async () => {
      verifyCalls += 1;
      if (verifyCalls === 4) {
        throw new Error("authority lost before the runner call");
      }
    });
    const rawRunnerCalls: Array<{
      readonly command: string;
      readonly args: readonly string[];
    }> = [];
    const refresher = createServiceDefinitionRefresher(
      async (command, args) => {
        rawRunnerCalls.push({ command, args: [...args] });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    await expect(
      withServiceMutationAuthority(verify, () => refresher.refresh(label)),
    ).rejects.toThrow("authority lost before the runner call");

    // Call 5 is `withServiceMutationAuthority`'s own catch-block re-probe,
    // which this fixture lets resolve, so the ORIGINAL "authority lost"
    // error is what surfaces above, not a swallowed one.
    expect(verifyCalls).toBe(5);
    // The real runner - `systemctl --user daemon-reload` - never ran: the
    // wrapper's own re-check rejected first.
    expect(rawRunnerCalls).toEqual([]);
    // The file write already happened - it is gated by ITS OWN two checks
    // (calls 2-3), which both resolved before the runner's check failed.
    expect(await readFile(serviceManifestPath(label), "utf8")).not.toBe(
      historicalUnit(label),
    );
  });

  it("control: an always-live verifier lets the real runner run, and calls it exactly once", async () => {
    const label = labelFor("definition-refresh-runner-reverify-control");
    await mkdir(TEST_UNIT_DIR, { recursive: true });
    await writeFile(
      join(TEST_UNIT_DIR, `${label.id}.service`),
      historicalUnit(label),
      "utf8",
    );

    const verify = vi.fn(async () => undefined);
    const rawRunnerCalls: Array<{
      readonly command: string;
      readonly args: readonly string[];
    }> = [];
    const refresher = createServiceDefinitionRefresher(
      async (command, args) => {
        rawRunnerCalls.push({ command, args: [...args] });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    const result = await withServiceMutationAuthority(verify, () =>
      refresher.refresh(label),
    );

    expect(result.kind).toBe("refreshed");
    expect(rawRunnerCalls).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
    ]);
    // Once for `withServiceMutationAuthority`'s own entry, twice more for
    // `replaceDefinitionFile`'s own write/rename checks, and once for the
    // runner wrapper's pre-call re-check.
    expect(verify).toHaveBeenCalledTimes(4);
  });
});
