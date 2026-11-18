import { describe, expect, it } from "vitest";
import { traycerLabelIdsForBase } from "../identity";
import type { TraycerLabelIds } from "../identity";
import type { ProbeCommandResult } from "../shared/command";
import {
  classifyLabelOwnership,
  classifyLaunchctlPrintResult,
  extractProgramArgumentsFromPrint,
  isLaunchctlNotFoundOutput,
  isLaunchctlPermissionOutput,
  isSmAppServiceLaunchAgentPath,
  parseLaunchctlPrintFields,
  parseLaunchdRunState,
  parseLwcrEvidence,
} from "../macos/launchctl-print";
import { deriveWedgeVerdict } from "../macos/wedge";
import { SMAPPSERVICE_PATH_UNKNOWN } from "../macos/types";
import {
  HEALTHY_TRAYCER_AGENT_PRINT,
  PRINT_BAD_DOMAIN_STDERR,
  PRINT_SERVICE_NOT_FOUND_STDERR,
  SYSTEM_AGENT_BARE_ARGUMENTS_PRINT,
  THIRD_PARTY_HAS_LWCR_PRINT,
} from "./fixtures/launchctl";

const KNOWN: TraycerLabelIds = traycerLabelIdsForBase("ai.traycer.host");

function commandResult(
  overrides: Partial<ProbeCommandResult>,
): ProbeCommandResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    spawnFailed: false,
    signal: null,
    ...overrides,
  };
}

describe("parseLaunchctlPrintFields", () => {
  it("collects top-level key = value pairs, first occurrence winning", () => {
    const fields = parseLaunchctlPrintFields(
      [
        "path = /Users/x/Library/LaunchAgents/ai.traycer.host.plist",
        "state = running",
        "state = duplicate-ignored",
        "last exit code = 78",
      ].join("\n"),
    );
    expect(fields.get("path")).toBe(
      "/Users/x/Library/LaunchAgents/ai.traycer.host.plist",
    );
    expect(fields.get("state")).toBe("running");
    expect(fields.get("last exit code")).toBe("78");
  });

  it("excludes nested `=>` environment lines", () => {
    const fields = parseLaunchctlPrintFields(
      ["environment = {", "\tPATH => /usr/bin", "}"].join("\n"),
    );
    expect(fields.has("PATH")).toBe(false);
  });

  it("ignores a key with nothing at all following the '='", () => {
    const fields = parseLaunchctlPrintFields("path =\nstate = running");
    expect(fields.has("path")).toBe(false);
    expect(fields.get("state")).toBe("running");
  });

  it("trims and drops whitespace-only values so the empty-value guard is live", () => {
    const fields = parseLaunchctlPrintFields("path =   \nstate = running");
    expect(fields.has("path")).toBe(false);
    expect(fields.get("state")).toBe("running");
  });

  // Finding 10 — measured against real bytes, not argued about.
  it("does NOT harvest keys nested inside a block, on real launchctl output", () => {
    const fields = parseLaunchctlPrintFields(THIRD_PARTY_HAS_LWCR_PRINT);

    // These six live inside `endpoints = { "com.docker.helper" = { … } }`.
    for (const nested of [
      "port",
      "active",
      "managed",
      "reset",
      "hide",
      "watching",
    ]) {
      expect(fields.has(nested)).toBe(false);
    }
    // …while the genuinely top-level fields around them still parse.
    expect(fields.get("path")).toBe("(submitted by smd.321)");
    expect(fields.get("type")).toBe("Submitted");
    expect(fields.get("managed_by")).toBe("com.apple.xpc.ServiceManagement");
    expect(fields.get("last exit code")).toBe("0");
  });

  it("drops block-opening lines instead of mapping the key to a literal '{'", () => {
    const fields = parseLaunchctlPrintFields(HEALTHY_TRAYCER_AGENT_PRINT);
    expect(fields.get("arguments")).toBeUndefined();
    expect(fields.get("environment")).toBeUndefined();
  });
});

describe("isSmAppServiceLaunchAgentPath", () => {
  it("matches an in-bundle LaunchAgents path (pre-#657 style)", () => {
    expect(
      isSmAppServiceLaunchAgentPath(
        "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist",
      ),
    ).toBe(true);
  });

  it("does not match a user-domain LaunchAgents path", () => {
    expect(
      isSmAppServiceLaunchAgentPath(
        "/Users/x/Library/LaunchAgents/ai.traycer.host.plist",
      ),
    ).toBe(false);
  });
});

describe("classifyLabelOwnership", () => {
  it("classifies pre-#657 style in-bundle LaunchAgents path as smappservice", () => {
    const raw = [
      "path = /Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist",
      "state = running",
    ].join("\n");
    const fields = parseLaunchctlPrintFields(raw);
    const ownership = classifyLabelOwnership(fields, raw, KNOWN, KNOWN.agent);
    expect(ownership).toEqual({
      kind: "smappservice",
      path: "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist",
      signals: {
        managedByServiceManagement: false,
        typeSubmitted: false,
        inBundleLaunchAgentPath: true,
      },
    });
  });

  it("classifies the real modern smd-submitted agent as smappservice via managed_by + type", () => {
    const fields = parseLaunchctlPrintFields(HEALTHY_TRAYCER_AGENT_PRINT);
    const ownership = classifyLabelOwnership(
      fields,
      HEALTHY_TRAYCER_AGENT_PRINT,
      KNOWN,
      KNOWN.agent,
    );
    expect(ownership.kind).toBe("smappservice");
    if (ownership.kind === "smappservice") {
      expect(ownership.signals.managedByServiceManagement).toBe(true);
      expect(ownership.signals.typeSubmitted).toBe(true);
      expect(ownership.signals.inBundleLaunchAgentPath).toBe(false);
      expect(ownership.path).toBe("(submitted by smd.93299)");
    }
  });

  it("classifies a placeholder / absent path as smappservice purely via managed_by + type", () => {
    const raw = [
      "type = Submitted",
      "managed_by = com.apple.xpc.ServiceManagement",
    ].join("\n");
    const fields = parseLaunchctlPrintFields(raw);
    const ownership = classifyLabelOwnership(fields, raw, KNOWN, KNOWN.agent);
    expect(ownership).toEqual({
      kind: "smappservice",
      path: SMAPPSERVICE_PATH_UNKNOWN,
      signals: {
        managedByServiceManagement: true,
        typeSubmitted: true,
        inBundleLaunchAgentPath: false,
      },
    });
  });

  it("classifies a CLI LaunchAgent with a user-domain path and host-start args as cli-or-other with attested identity", () => {
    const raw = [
      "path = /Users/x/Library/LaunchAgents/ai.traycer.host.plist",
      "type = LaunchAgent",
      "state = running",
      "arguments = {",
      "\t/opt/traycer/bin/traycer",
      "\thost",
      "\tstart",
      "}",
    ].join("\n");
    const fields = parseLaunchctlPrintFields(raw);
    const ownership = classifyLabelOwnership(fields, raw, KNOWN, KNOWN.cliRaw);
    expect(ownership.kind).toBe("cli-or-other");
    if (ownership.kind === "cli-or-other") {
      expect(ownership.path).toBe(
        "/Users/x/Library/LaunchAgents/ai.traycer.host.plist",
      );
      expect(ownership.identity.kind).toBe("attested");
    }
  });

  it("is indeterminate(unrecognized-format) when no ownership or job-shape signal is present", () => {
    const raw = "some-unrelated-field = value";
    const fields = parseLaunchctlPrintFields(raw);
    const ownership = classifyLabelOwnership(fields, raw, KNOWN, KNOWN.agent);
    expect(ownership).toEqual({
      kind: "indeterminate",
      cause: "unrecognized-format",
      path: null,
    });
  });

  it("treats a bare job shape (state present, no ownership signal) as cli-or-other", () => {
    const raw = "state = running\npid = 100";
    const fields = parseLaunchctlPrintFields(raw);
    const ownership = classifyLabelOwnership(fields, raw, KNOWN, KNOWN.agent);
    expect(ownership.kind).toBe("cli-or-other");
  });
});

describe("extractProgramArgumentsFromPrint", () => {
  // The finding: the previous quoted-token reader returned `null` here — for
  // *every* real launchd job — which silently reduced launchd-derived
  // attestation to label matching alone.
  it("reads the bare one-per-line arguments launchd actually emits", () => {
    expect(
      extractProgramArgumentsFromPrint(HEALTHY_TRAYCER_AGENT_PRINT),
    ).toEqual([
      "Contents/Library/LaunchAgents/Traycer Host.app/Contents/MacOS/traycer",
      "host",
      "start",
    ]);
  });

  it("keeps a bare argument containing spaces as ONE token", () => {
    const tokens = extractProgramArgumentsFromPrint(
      HEALTHY_TRAYCER_AGENT_PRINT,
    );
    expect(tokens).not.toBeNull();
    expect(tokens?.[0]).toContain("Traycer Host.app");
    expect(tokens).toHaveLength(3);
  });

  it("reads a single-argument block from a real system agent", () => {
    expect(
      extractProgramArgumentsFromPrint(SYSTEM_AGENT_BARE_ARGUMENTS_PRINT),
    ).toEqual(["/usr/libexec/enhancedloggingd"]);
  });

  it("still reads a quoted generation, should launchd ever emit one", () => {
    const raw = ["arguments = {", '\t"a"', '\t"b"', "}"].join("\n");
    expect(extractProgramArgumentsFromPrint(raw)).toEqual(["a", "b"]);
  });

  it("reads the single-line `program arguments = { … }` form", () => {
    const raw = 'program arguments = { "host" "start" }';
    expect(extractProgramArgumentsFromPrint(raw)).toEqual(["host", "start"]);
  });

  it("returns null when no arguments block is present", () => {
    expect(
      extractProgramArgumentsFromPrint(THIRD_PARTY_HAS_LWCR_PRINT),
    ).toBeNull();
    expect(extractProgramArgumentsFromPrint("state = running")).toBeNull();
  });

  it("returns null for a truncated block rather than inventing a token list", () => {
    const raw = ["arguments = {", "\t/usr/bin/thing"].join("\n");
    expect(extractProgramArgumentsFromPrint(raw)).toBeNull();
  });
});

describe("parseLwcrEvidence", () => {
  // BLOCKER C-B1. `has LWCR` is the healthy signed state, and both real
  // captures below carry it.
  it("is absent for the live, healthy Traycer agent that prints `has LWCR`", () => {
    expect(parseLwcrEvidence(HEALTHY_TRAYCER_AGENT_PRINT)).toEqual({
      kind: "absent",
    });
  });

  it("is absent for a healthy third-party signed job that prints `has LWCR`", () => {
    expect(parseLwcrEvidence(THIRD_PARTY_HAS_LWCR_PRINT)).toEqual({
      kind: "absent",
    });
  });

  it("observes `needs LWCR update` — the only real mismatch marker", () => {
    const wedged = HEALTHY_TRAYCER_AGENT_PRINT.replace(
      "properties = partial import | runatload | resolve program | has LWCR",
      "properties = partial import | runatload | resolve program | needs LWCR update",
    );
    expect(parseLwcrEvidence(wedged)).toEqual({
      kind: "observed",
      markers: ["needs LWCR update"],
    });
  });

  it("reads the `properties` field only — a path containing 'lwcr' is not a marker", () => {
    const raw = [
      "path = /Users/x/Library/LaunchAgents/needs-lwcr-update-tool.plist",
      "state = running",
      "properties = supports transactions | has LWCR",
    ].join("\n");
    expect(parseLwcrEvidence(raw)).toEqual({ kind: "absent" });
  });

  it("is indeterminate when the print carries no properties field at all", () => {
    expect(parseLwcrEvidence("state = running")).toEqual({
      kind: "indeterminate",
      cause: "unrecognized-format",
    });
  });
});

describe("wedge verdict over real launchd bytes", () => {
  function wedgeFor(raw: string) {
    return deriveWedgeVerdict(
      classifyLaunchctlPrintResult(
        commandResult({ exitCode: 0, stdout: raw }),
        KNOWN,
        KNOWN.agent,
      ),
      {
        loginItemEnabled: true,
        hasPidMetadata: true,
        hasAttemptProgress: true,
      },
    );
  }

  // The v1.1.8 lockout shape, reproduced by construction and then closed: a
  // healthy signed agent must never derive a wedge, because the planner turns
  // `wedged` into `transition-to-fallback` — provision raw fallback, boot out
  // the agent, i.e. tear down its own working registration.
  it("does not wedge the live, healthy Traycer agent", () => {
    expect(wedgeFor(HEALTHY_TRAYCER_AGENT_PRINT).kind).toBe(
      "healthy-or-unknown",
    );
  });

  it("does not wedge a healthy third-party signed job", () => {
    expect(wedgeFor(THIRD_PARTY_HAS_LWCR_PRINT).kind).toBe(
      "healthy-or-unknown",
    );
  });

  it("does wedge the same agent once its properties say `needs LWCR update`", () => {
    const verdict = wedgeFor(
      HEALTHY_TRAYCER_AGENT_PRINT.replace("has LWCR", "needs LWCR update"),
    );
    expect(verdict.kind).toBe("wedged");
    if (verdict.kind === "wedged") {
      expect(verdict.reasons).toContain("lwcr-mismatch-markers");
    }
  });
});

describe("parseLaunchdRunState", () => {
  it("parses run state from the real healthy agent print", () => {
    const runState = parseLaunchdRunState(HEALTHY_TRAYCER_AGENT_PRINT);
    expect(runState.jobState).toEqual({ kind: "observed", value: "running" });
    expect(runState.pid).toEqual({ kind: "observed", value: 98634 });
    expect(runState.runs).toEqual({ kind: "observed", value: 1 });
    // `last exit code = (never exited)` is not a number — absent, not 0.
    expect(runState.lastExitCode).toEqual({ kind: "absent" });
    expect(runState.lwcr).toEqual({ kind: "absent" });
  });

  it("parses state, last exit code 78, pid and runs from a synthetic wedge blob", () => {
    const raw = [
      "state = running",
      "last exit code = 78",
      "pid = 4321",
      "runs = 5",
      "properties = needs LWCR update",
    ].join("\n");
    const runState = parseLaunchdRunState(raw);
    expect(runState.jobState).toEqual({ kind: "observed", value: "running" });
    expect(runState.lastExitCode).toEqual({ kind: "observed", value: 78 });
    expect(runState.pid).toEqual({ kind: "observed", value: 4321 });
    expect(runState.runs).toEqual({ kind: "observed", value: 5 });
    expect(runState.lwcr.kind).toBe("observed");
  });

  it("reports absent evidence for fields that are not present", () => {
    const runState = parseLaunchdRunState("unrelated = 1");
    expect(runState.jobState).toEqual({ kind: "absent" });
    expect(runState.lastExitCode).toEqual({ kind: "absent" });
    expect(runState.pid).toEqual({ kind: "absent" });
    expect(runState.runs).toEqual({ kind: "absent" });
    expect(runState.lwcr).toEqual({
      kind: "indeterminate",
      cause: "unrecognized-format",
    });
  });
});

describe("classifyLaunchctlPrintResult", () => {
  it("is indeterminate(spawn-failed) when the runner could not spawn launchctl", () => {
    const result = classifyLaunchctlPrintResult(
      commandResult({ spawnFailed: true }),
      KNOWN,
      KNOWN.agent,
    );
    expect(result).toEqual({ kind: "indeterminate", cause: "spawn-failed" });
  });

  it("is indeterminate(timeout) when the runner killed the process for exceeding the deadline", () => {
    const result = classifyLaunchctlPrintResult(
      commandResult({ timedOut: true }),
      KNOWN,
      KNOWN.agent,
    );
    expect(result).toEqual({ kind: "indeterminate", cause: "timeout" });
  });

  // Real captured stderr + real exit codes.
  it("is absent for the real exit-113 service-not-found bytes", () => {
    const result = classifyLaunchctlPrintResult(
      commandResult({
        exitCode: 113,
        stderr: PRINT_SERVICE_NOT_FOUND_STDERR,
      }),
      KNOWN,
      KNOWN.cliRaw,
    );
    expect(result).toEqual({ kind: "absent" });
  });

  it("is indeterminate(command-failed) for the real exit-112 bad-domain bytes", () => {
    const result = classifyLaunchctlPrintResult(
      commandResult({ exitCode: 112, stderr: PRINT_BAD_DOMAIN_STDERR }),
      KNOWN,
      KNOWN.cliRaw,
    );
    expect(result).toEqual({
      kind: "indeterminate",
      cause: "command-failed",
    });
  });

  it("is indeterminate(permission) for a non-zero exit with a permission signature", () => {
    const result = classifyLaunchctlPrintResult(
      commandResult({ exitCode: 1, stderr: "Operation not permitted" }),
      KNOWN,
      KNOWN.agent,
    );
    expect(result).toEqual({ kind: "indeterminate", cause: "permission" });
  });

  it("is indeterminate(command-failed) for a non-zero exit with no recognized signature", () => {
    const result = classifyLaunchctlPrintResult(
      commandResult({ exitCode: 1, stderr: "unexpected internal error" }),
      KNOWN,
      KNOWN.agent,
    );
    expect(result).toEqual({ kind: "indeterminate", cause: "command-failed" });
  });

  it("is observed with ownership and run-state on the real healthy agent print", () => {
    const result = classifyLaunchctlPrintResult(
      commandResult({ exitCode: 0, stdout: HEALTHY_TRAYCER_AGENT_PRINT }),
      KNOWN,
      KNOWN.agent,
    );
    expect(result.kind).toBe("observed");
    if (result.kind === "observed") {
      expect(result.ownership.kind).toBe("smappservice");
      expect(result.runState.jobState).toEqual({
        kind: "observed",
        value: "running",
      });
    }
  });
});

describe("isLaunchctlNotFoundOutput", () => {
  it.each([
    "Could not find service",
    "Could not find specified service",
    "no such process",
    "service could not be found",
    "unrecognized domain or target specified",
  ])("recognizes %s as a not-found signature", (text) => {
    expect(isLaunchctlNotFoundOutput(text)).toBe(true);
  });

  it("recognizes the real captured not-found stderr", () => {
    expect(isLaunchctlNotFoundOutput(PRINT_SERVICE_NOT_FOUND_STDERR)).toBe(
      true,
    );
  });

  it("does NOT treat the real bad-domain stderr as not-found", () => {
    expect(isLaunchctlNotFoundOutput(PRINT_BAD_DOMAIN_STDERR)).toBe(false);
  });

  it("does not treat an arbitrary failure message as not-found", () => {
    expect(isLaunchctlNotFoundOutput("unexpected internal error")).toBe(false);
  });
});

describe("isLaunchctlPermissionOutput", () => {
  it.each([
    "Operation not permitted",
    "Permission denied",
    "not privileged to access domain",
    "EPERM",
  ])("recognizes %s as a permission signature", (text) => {
    expect(isLaunchctlPermissionOutput(text)).toBe(true);
  });

  it("does not treat an arbitrary failure message as a permission signature", () => {
    expect(isLaunchctlPermissionOutput("unexpected internal error")).toBe(
      false,
    );
  });
});
