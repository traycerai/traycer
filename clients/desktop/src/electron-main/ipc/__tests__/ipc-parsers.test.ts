import { describe, expect, it, vi } from "vitest";
import {
  parseQuitDecision,
  parseSandboxCreateRequest,
  parseSandboxLifecycleVerb,
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
  };

  it("returns a valid request unchanged, nulls kept as the server's defaults", () => {
    expect(parseSandboxCreateRequest(VALID)).toEqual(VALID);
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
    });
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
    ];
    for (const [field, override] of cases) {
      expect(() =>
        parseSandboxCreateRequest({ ...VALID, ...override }),
      ).toThrow(`createSandbox.request.${field}`);
    }
  });
});
