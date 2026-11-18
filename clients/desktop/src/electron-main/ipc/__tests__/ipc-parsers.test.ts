import { describe, expect, it, vi } from "vitest";
import {
  assertNullableString,
  parseQuitDecision,
  parseRequiredId,
  parseSandboxAutomationEnvironmentId,
  parseSandboxAutomationOpenTarget,
  parseSandboxCreateRequest,
  parseSandboxLifecycleVerb,
  parseSandboxVerbGesture,
  parseSandboxPatchRequest,
  parseSecretRequestDecision,
} from "../ipc-parsers";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

// F6: `parseQuitDecision` used to accept its known members through an `if`
// chain and fall back to "proceed" - i.e. quit - for everything else. Adding
// `userCancelled` to the `QuitDecision` union left that chain compiling, so a
// renderer answering "do not quit" would have been parsed as "quit". This
// pins the new member is actually recognized, not just added to the type.
describe("parseQuitDecision", () => {
  it('accepts "userCancelled"', () => {
    expect(parseQuitDecision("userCancelled")).toBe("userCancelled");
  });

  it("still accepts the pre-existing members", () => {
    expect(parseQuitDecision("proceed")).toBe("proceed");
    expect(parseQuitDecision("userConfirmedDiscard")).toBe(
      "userConfirmedDiscard",
    );
  });

  it("falls back to userCancelled for anything it does not recognize", () => {
    expect(parseQuitDecision("something-else")).toBe("userCancelled");
    expect(parseQuitDecision(undefined)).toBe("userCancelled");
    expect(parseQuitDecision(null)).toBe("userCancelled");
    expect(parseQuitDecision(42)).toBe("userCancelled");
  });
});

// The renderer's `runSandboxVerb` crosses IPC as `unknown`, and the verb ends
// up in a URL path (`/api/sandboxes/:id/<verb>`): the parser is the whole
// guard between a renderer string and that path.
describe("parseSandboxLifecycleVerb", () => {
  it("accepts exactly the four lifecycle verbs", () => {
    for (const verb of ["suspend", "resume", "stop", "start"] as const) {
      expect(parseSandboxLifecycleVerb(verb)).toBe(verb);
    }
  });

  it("throws on anything else, naming the field", () => {
    for (const bad of [
      "destroy",
      "Resume",
      " resume",
      "resume ",
      "resume/../cost",
      "",
      undefined,
      null,
      42,
      ["resume"],
      { verb: "resume" },
    ]) {
      expect(() => parseSandboxLifecycleVerb(bad)).toThrow(
        'runSandboxVerb.verb must be "suspend", "resume", "stop" or "start"',
      );
    }
  });
});

// The gesture crosses IPC as `unknown` too, and ends up in a JSON body the
// control plane records: only `null` and the three known gestures pass.
describe("parseSandboxVerbGesture", () => {
  it("accepts null and exactly the three gestures", () => {
    expect(parseSandboxVerbGesture(null)).toBeNull();
    for (const gesture of ["open-terminal", "send", "open-files"] as const) {
      expect(parseSandboxVerbGesture(gesture)).toBe(gesture);
    }
  });

  it("throws on anything else, naming the field", () => {
    for (const bad of [
      "Open-terminal",
      "open-terminal ",
      "destroy",
      "",
      undefined,
      42,
      ["send"],
      { gesture: "send" },
    ]) {
      expect(() => parseSandboxVerbGesture(bad)).toThrow(
        'runSandboxVerb.gesture must be null, "open-terminal", "send" or "open-files"',
      );
    }
  });
});

// The sandbox environment of a secrets call crosses IPC as `unknown`; null is a
// real value (a server that predates environments), so it is accepted, and
// `undefined` is not.
describe("assertNullableString", () => {
  it("accepts a string and null", () => {
    expect(() =>
      assertNullableString("env-1", "ctx.environmentId"),
    ).not.toThrow();
    expect(() => assertNullableString("", "ctx.environmentId")).not.toThrow();
    expect(() => assertNullableString(null, "ctx.environmentId")).not.toThrow();
  });

  it("throws on anything else, naming the field", () => {
    for (const bad of [undefined, 7, true, {}, ["env-1"]]) {
      expect(() => assertNullableString(bad, "ctx.environmentId")).toThrow(
        "ctx.environmentId requires a string or null argument",
      );
    }
  });
});

// The renderer's `decideSecretRequest` crosses IPC as `unknown`, and the
// decision goes into the body of a write the broker acts on: the parser is the
// whole guard between a renderer value and that body.
describe("parseSecretRequestDecision", () => {
  it("accepts exactly the three decisions", () => {
    for (const decision of ["approve", "approve_default", "decline"] as const) {
      expect(parseSecretRequestDecision(decision)).toBe(decision);
    }
  });

  it("throws on anything else, naming the field", () => {
    for (const bad of [
      "approved",
      "Approve",
      " approve",
      "approve ",
      "approve-default",
      "deny",
      "",
      undefined,
      null,
      42,
      true,
      ["approve"],
      { decision: "approve" },
    ]) {
      expect(() => parseSecretRequestDecision(bad)).toThrow(
        'decideSecretRequest.decision must be "approve", "approve_default" or "decline"',
      );
    }
  });
});

// A team id or environment id crosses IPC as `unknown` and goes into a URL
// path: an empty or non-string one is refused before any request is built.
describe("parseRequiredId", () => {
  it("returns a non-empty string unchanged", () => {
    expect(parseRequiredId("team-acme", "getTeamEnvironment.teamId")).toBe(
      "team-acme",
    );
  });

  it("throws on an empty string, undefined, null or a non-string, naming the field", () => {
    for (const bad of ["", undefined, null, 7, true, {}, ["team-acme"]]) {
      expect(() => parseRequiredId(bad, "getTeamEnvironment.teamId")).toThrow(
        "getTeamEnvironment.teamId",
      );
    }
  });
});

// A malformed create has no safe degrade - a guessed shape would provision a
// machine nobody asked for - so every bad value throws instead.
describe("parseSandboxCreateRequest", () => {
  const VALID = {
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: null,
    region: null,
    displayName: "build-box",
    idleMinutes: null,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    environmentId: null,
    destroyAfterRestingMinutes: null,
    createdByTaskId: null,
    clientRequestId: null,
  };

  it("returns a valid request unchanged, nulls kept as the server's defaults", () => {
    expect(parseSandboxCreateRequest(VALID)).toEqual(VALID);
  });

  it("passes a resting period of 0, which is never", () => {
    expect(
      parseSandboxCreateRequest({ ...VALID, destroyAfterRestingMinutes: 0 }),
    ).toEqual({ ...VALID, destroyAfterRestingMinutes: 0 });
    expect(
      parseSandboxCreateRequest({
        ...VALID,
        os: "windows",
        cpus: 0.5,
        diskMb: 20480,
        region: "eu-west",
        idleMinutes: 120,
        burst: true,
        createdByHostId: "host-1",
        createdByAgentId: "agent-1",
        environmentId: "env_1",
      }),
    ).toMatchObject({
      os: "windows",
      cpus: 0.5,
      diskMb: 20480,
      region: "eu-west",
      idleMinutes: 120,
      burst: true,
      createdByHostId: "host-1",
      createdByAgentId: "agent-1",
      environmentId: "env_1",
    });
  });

  it("keeps a null environmentId as the caller's own principal's environment", () => {
    expect(
      parseSandboxCreateRequest({ ...VALID, environmentId: null })
        .environmentId,
    ).toBeNull();
  });

  it("throws when the environmentId key is absent altogether", () => {
    const { environmentId: _omitted, ...withoutEnvironment } = VALID;
    expect(() => parseSandboxCreateRequest(withoutEnvironment)).toThrow(
      "createSandbox.request.environmentId",
    );
  });

  it("drops a field it does not know rather than forwarding it to the control plane", () => {
    const parsed = parseSandboxCreateRequest({ ...VALID, userId: "other" });
    expect(Object.keys(parsed)).not.toContain("userId");
  });

  it("throws on a body that is not an object", () => {
    for (const bad of [null, undefined, "linux", 3, [VALID]]) {
      expect(() => parseSandboxCreateRequest(bad)).toThrow(
        "createSandbox.request must be an object",
      );
    }
  });

  it("throws on each bad field, naming it", () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ["os", { os: "plan9" }],
      ["burst", { burst: "no" }],
      ["cpus", { cpus: 0 }],
      ["cpus", { cpus: "2" }],
      ["memoryMb", { memoryMb: 0 }],
      ["memoryMb", { memoryMb: 1.5 }],
      ["diskMb", { diskMb: -1 }],
      // A missing field is not a null: only an explicit null asks for the default.
      ["diskMb", { diskMb: undefined }],
      ["region", { region: undefined }],
      ["idleMinutes", { idleMinutes: undefined }],
      ["region", { region: "" }],
      ["displayName", { displayName: "" }],
      ["idleMinutes", { idleMinutes: 0 }],
      ["createdByHostId", { createdByHostId: "" }],
      ["createdByAgentId", { createdByAgentId: 7 }],
      // Like `createdByHostId`: an empty string is not an id, and a missing key
      // is not a null (only an explicit null picks the caller's own
      // environment).
      ["environmentId", { environmentId: "" }],
      ["environmentId", { environmentId: undefined }],
      ["environmentId", { environmentId: 7 }],
      ["destroyAfterRestingMinutes", { destroyAfterRestingMinutes: -1 }],
      ["createdByTaskId", { createdByTaskId: "" }],
      ["clientRequestId", { clientRequestId: undefined }],
    ];
    for (const [field, override] of cases) {
      expect(() =>
        parseSandboxCreateRequest({ ...VALID, ...override }),
      ).toThrow(`createSandbox.request.${field}`);
    }
  });
});

describe("parseSandboxPatchRequest", () => {
  const VALID = {
    displayName: "renamed",
    idleMinutes: null,
    destroyAfterRestingMinutes: null,
  };

  it("refuses what the protocol refuses: an idle period under 2, a name over 191", () => {
    expect(() =>
      parseSandboxPatchRequest({ ...VALID, idleMinutes: 1 }),
    ).toThrow(/patchSandbox\.request\.idleMinutes/);
    expect(() =>
      parseSandboxPatchRequest({ ...VALID, displayName: "x".repeat(192) }),
    ).toThrow(/patchSandbox\.request\.displayName/);
  });

  it("returns a valid request unchanged, 0 kept as a resting period of never", () => {
    expect(parseSandboxPatchRequest(VALID)).toEqual(VALID);
    expect(
      parseSandboxPatchRequest({
        displayName: null,
        idleMinutes: 45,
        destroyAfterRestingMinutes: 0,
      }),
    ).toEqual({
      displayName: null,
      idleMinutes: 45,
      destroyAfterRestingMinutes: 0,
    });
  });

  it("throws on a body that is not an object", () => {
    for (const bad of [null, undefined, "renamed", [VALID]]) {
      expect(() => parseSandboxPatchRequest(bad)).toThrow(
        "patchSandbox.request must be an object",
      );
    }
  });

  it("throws on each bad field, naming it", () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ["displayName", { displayName: "" }],
      // A missing key is not a null: only an explicit null leaves it as is.
      ["displayName", { displayName: undefined }],
      ["idleMinutes", { idleMinutes: 0 }],
      ["idleMinutes", { idleMinutes: 1.5 }],
      ["destroyAfterRestingMinutes", { destroyAfterRestingMinutes: -1 }],
      ["destroyAfterRestingMinutes", { destroyAfterRestingMinutes: "never" }],
    ];
    for (const [field, override] of cases) {
      expect(() => parseSandboxPatchRequest({ ...VALID, ...override })).toThrow(
        `patchSandbox.request.${field}`,
      );
    }
  });
});

// The environment a `getSandboxAutomation` read names: an empty id would send
// `?environmentId=` and read no environment at all, so it is refused here.
describe("parseSandboxAutomationEnvironmentId", () => {
  it("keeps null as null: the person's own Automations host", () => {
    expect(parseSandboxAutomationEnvironmentId(null)).toBeNull();
  });

  it("returns a non-empty id unchanged", () => {
    expect(parseSandboxAutomationEnvironmentId("env_1")).toBe("env_1");
  });

  it.each([
    ["an empty string", ""],
    ["undefined", undefined],
    ["a number", 7],
    ["an object", {}],
  ])("refuses %s", (_label, bad) => {
    expect(() => parseSandboxAutomationEnvironmentId(bad)).toThrow(
      "getSandboxAutomation.environmentId",
    );
  });
});

// The renderer's `openSandboxAutomation` target crosses IPC as `unknown` and
// names the pod a team's open wakes (or creates): a guessed target would open
// another pod than the one picked, so a malformed one throws.
describe("parseSandboxAutomationOpenTarget", () => {
  it("keeps null as null: the caller's own Automations host, no body", () => {
    expect(parseSandboxAutomationOpenTarget(null)).toBeNull();
  });

  it("returns a valid target unchanged", () => {
    expect(
      parseSandboxAutomationOpenTarget({ environmentId: "env_1", ordinal: 2 }),
    ).toEqual({ environmentId: "env_1", ordinal: 2 });
  });

  it("accepts ordinal 0, the first pod", () => {
    expect(
      parseSandboxAutomationOpenTarget({ environmentId: "env_1", ordinal: 0 }),
    ).toEqual({ environmentId: "env_1", ordinal: 0 });
  });

  it("keeps a null ordinal as null: the server picks the pod with headroom", () => {
    expect(
      parseSandboxAutomationOpenTarget({
        environmentId: "env_1",
        ordinal: null,
      }),
    ).toEqual({ environmentId: "env_1", ordinal: null });
  });

  it("drops a field it does not know rather than forwarding it", () => {
    const parsed = parseSandboxAutomationOpenTarget({
      environmentId: "env_1",
      ordinal: 1,
      userId: "other",
    });
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "environmentId",
      "ordinal",
    ]);
  });

  it("throws on a target that is neither null nor an object", () => {
    for (const bad of [undefined, "env_1", 3, true, [{ environmentId: "e" }]]) {
      expect(() => parseSandboxAutomationOpenTarget(bad)).toThrow(
        "openSandboxAutomation.target must be an object or null",
      );
    }
  });

  it("throws on an empty or non-string environmentId", () => {
    for (const bad of ["", undefined, null, 7, {}]) {
      expect(() =>
        parseSandboxAutomationOpenTarget({ environmentId: bad, ordinal: 1 }),
      ).toThrow("openSandboxAutomation.target.environmentId");
    }
  });

  it("throws on a negative, fractional or non-numeric ordinal", () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity, "1", undefined, {}]) {
      expect(() =>
        parseSandboxAutomationOpenTarget({
          environmentId: "env_1",
          ordinal: bad,
        }),
      ).toThrow("openSandboxAutomation.target.ordinal");
    }
  });
});
