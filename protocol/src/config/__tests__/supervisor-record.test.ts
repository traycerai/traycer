/**
 * `supervisor-record.ts`: the record's path helper, round-trip through
 * serialize/parse, the "malformed reads as absent, never throws" contract,
 * and {@link supervisorRecordHasCapability}'s open-vocabulary read.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDarwinProcessStartIdentity } from "../../host/lifecycle/process-start-identity";
import {
  SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
  parseSupervisorRecord,
  parseSupervisorRecordText,
  serializeSupervisorRecord,
  supervisorRecordHasCapability,
  supervisorRecordPath,
  type SupervisorRecord,
} from "../supervisor-record";

describe("supervisorRecordPath", () => {
  it("joins the filename onto the given host home directory", () => {
    expect(supervisorRecordPath("/fake/host-home")).toBe(
      join("/fake/host-home", "supervisor.json"),
    );
  });

  it("resolves relative to whatever directory it is given", () => {
    expect(supervisorRecordPath("/one/slot")).toBe(
      join("/one/slot", "supervisor.json"),
    );
    expect(supervisorRecordPath("/another/slot")).toBe(
      join("/another/slot", "supervisor.json"),
    );
  });
});

const VALID_RECORD: SupervisorRecord = {
  v: 1,
  pid: 4242,
  cliVersion: "1.4.0",
  capabilities: [SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1],
  startedAt: "2026-08-17T12:00:00.000Z",
  startIdentity: null,
  admittedAs: null,
};

describe("serialize / parse round-trip", () => {
  it("parseSupervisorRecordText(serializeSupervisorRecord(x)) returns x", () => {
    const text = serializeSupervisorRecord(VALID_RECORD);
    expect(parseSupervisorRecordText(text)).toEqual(VALID_RECORD);
  });

  it("the serialized text ends with a newline", () => {
    const text = serializeSupervisorRecord(VALID_RECORD);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("round-trips an empty capabilities array", () => {
    const record: SupervisorRecord = { ...VALID_RECORD, capabilities: [] };
    const text = serializeSupervisorRecord(record);
    expect(parseSupervisorRecordText(text)).toEqual(record);
  });

  it("round-trips an unrecognised capability string alongside a known one", () => {
    const record: SupervisorRecord = {
      ...VALID_RECORD,
      capabilities: [
        SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
        "some-future-capability",
      ],
    };
    const text = serializeSupervisorRecord(record);
    expect(parseSupervisorRecordText(text)).toEqual(record);
  });
});

describe("malformed input reads as absent, never throws", () => {
  const withoutV = {
    pid: VALID_RECORD.pid,
    cliVersion: VALID_RECORD.cliVersion,
    capabilities: VALID_RECORD.capabilities,
    startedAt: VALID_RECORD.startedAt,
  };
  const withoutPid = {
    v: VALID_RECORD.v,
    cliVersion: VALID_RECORD.cliVersion,
    capabilities: VALID_RECORD.capabilities,
    startedAt: VALID_RECORD.startedAt,
  };
  const withoutCliVersion = {
    v: VALID_RECORD.v,
    pid: VALID_RECORD.pid,
    capabilities: VALID_RECORD.capabilities,
    startedAt: VALID_RECORD.startedAt,
  };
  const withoutCapabilities = {
    v: VALID_RECORD.v,
    pid: VALID_RECORD.pid,
    cliVersion: VALID_RECORD.cliVersion,
    startedAt: VALID_RECORD.startedAt,
  };
  const withoutStartedAt = {
    v: VALID_RECORD.v,
    pid: VALID_RECORD.pid,
    cliVersion: VALID_RECORD.cliVersion,
    capabilities: VALID_RECORD.capabilities,
  };

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly value: unknown;
  }> = [
    { name: "a string", value: "not-a-record" },
    { name: "a number", value: 42 },
    { name: "a boolean", value: true },
    { name: "null", value: null },
    { name: "an array", value: [] },
    { name: "wrong v: 0", value: { ...VALID_RECORD, v: 0 } },
    { name: "wrong v: 2", value: { ...VALID_RECORD, v: 2 } },
    { name: 'wrong v: "1"', value: { ...VALID_RECORD, v: "1" } },
    { name: "missing v", value: withoutV },
    { name: "missing pid", value: withoutPid },
    { name: "missing cliVersion", value: withoutCliVersion },
    { name: "missing capabilities", value: withoutCapabilities },
    { name: "missing startedAt", value: withoutStartedAt },
    { name: "pid as a string", value: { ...VALID_RECORD, pid: "4242" } },
    {
      name: "cliVersion as a number",
      value: { ...VALID_RECORD, cliVersion: 1 },
    },
    {
      name: "capabilities as a string instead of an array",
      value: { ...VALID_RECORD, capabilities: "lifecycle-policy-v1" },
    },
    { name: "startedAt as a number", value: { ...VALID_RECORD, startedAt: 1 } },
    { name: "pid 0", value: { ...VALID_RECORD, pid: 0 } },
    { name: "pid negative", value: { ...VALID_RECORD, pid: -1 } },
    { name: "pid non-integer", value: { ...VALID_RECORD, pid: 1.5 } },
    { name: "pid NaN", value: { ...VALID_RECORD, pid: Number.NaN } },
    {
      name: "pid Infinity",
      value: { ...VALID_RECORD, pid: Number.POSITIVE_INFINITY },
    },
    {
      name: "cliVersion empty string",
      value: { ...VALID_RECORD, cliVersion: "" },
    },
    {
      name: "capabilities containing an empty string",
      value: { ...VALID_RECORD, capabilities: [""] },
    },
    {
      name: "an unparseable startedAt",
      value: { ...VALID_RECORD, startedAt: "not-a-date" },
    },
  ];

  for (const testCase of cases) {
    it(`parseSupervisorRecord returns null for ${testCase.name}`, () => {
      expect(() => parseSupervisorRecord(testCase.value)).not.toThrow();
      expect(parseSupervisorRecord(testCase.value)).toBeNull();
    });

    it(`parseSupervisorRecordText returns null for ${testCase.name}`, () => {
      const text = JSON.stringify(testCase.value);
      expect(() => parseSupervisorRecordText(text)).not.toThrow();
      expect(parseSupervisorRecordText(text)).toBeNull();
    });
  }

  const textOnlyCases: ReadonlyArray<{
    readonly name: string;
    readonly text: string;
  }> = [
    { name: "an empty string", text: "" },
    { name: "truncated JSON", text: '{"v":1,"pid":' },
    { name: "non-JSON text", text: "not json at all" },
  ];

  for (const testCase of textOnlyCases) {
    it(`parseSupervisorRecordText returns null for ${testCase.name}`, () => {
      expect(() => parseSupervisorRecordText(testCase.text)).not.toThrow();
      expect(parseSupervisorRecordText(testCase.text)).toBeNull();
    });
  }
});

describe("unknown extra keys are ignored", () => {
  it("still parses and drops the extra key", () => {
    const withExtra = { ...VALID_RECORD, someFutureField: "unexpected" };
    const parsed = parseSupervisorRecord(withExtra);
    expect(parsed).toEqual(VALID_RECORD);
    expect(parsed).not.toBeNull();
    expect(parsed && "someFutureField" in parsed).toBe(false);
  });
});

describe("startIdentity", () => {
  const ID = formatDarwinProcessStartIdentity("Sun Jul 6 12:00:00 2026");

  it("serializes startIdentity into the record's text", () => {
    const text = serializeSupervisorRecord({
      ...VALID_RECORD,
      startIdentity: ID,
    });
    const raw: unknown = JSON.parse(text);
    expect(raw).toHaveProperty("startIdentity", ID);
  });

  it("round-trips a record carrying a startIdentity", () => {
    const record: SupervisorRecord = { ...VALID_RECORD, startIdentity: ID };
    expect(
      parseSupervisorRecordText(serializeSupervisorRecord(record)),
    ).toEqual(record);
  });

  it("a record with no startIdentity key parses with startIdentity null (legacy)", () => {
    const withoutStartIdentity = {
      v: VALID_RECORD.v,
      pid: VALID_RECORD.pid,
      cliVersion: VALID_RECORD.cliVersion,
      capabilities: VALID_RECORD.capabilities,
      startedAt: VALID_RECORD.startedAt,
    };
    const parsed = parseSupervisorRecord(withoutStartIdentity);
    expect(parsed).not.toBeNull();
    expect(parsed?.startIdentity).toBeNull();
  });

  it("startIdentity: null parses to null", () => {
    const record = { ...VALID_RECORD, startIdentity: null };
    const parsed = parseSupervisorRecord(record);
    expect(parsed).not.toBeNull();
    expect(parsed?.startIdentity).toBeNull();
  });

  it('startIdentity: "garbage" (not a valid identity) still parses as a record, with startIdentity null', () => {
    const record = { ...VALID_RECORD, startIdentity: "garbage" };
    const parsed = parseSupervisorRecord(record);
    expect(parsed).not.toBeNull();
    expect(parsed?.startIdentity).toBeNull();
  });
});

describe("supervisorRecordHasCapability", () => {
  it("is false for a null record", () => {
    expect(
      supervisorRecordHasCapability(
        null,
        SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
      ),
    ).toBe(false);
  });

  it("is true when the capability is present", () => {
    expect(
      supervisorRecordHasCapability(
        VALID_RECORD,
        SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
      ),
    ).toBe(true);
  });

  it("is false when the capability is absent", () => {
    const record: SupervisorRecord = { ...VALID_RECORD, capabilities: [] };
    expect(
      supervisorRecordHasCapability(
        record,
        SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
      ),
    ).toBe(false);
  });

  it("an unknown capability string in the record does not break parsing, and is simply not the one asked for", () => {
    const record: SupervisorRecord = {
      ...VALID_RECORD,
      capabilities: ["some-unknown-capability"],
    };
    expect(parseSupervisorRecord(record)).toEqual(record);
    expect(
      supervisorRecordHasCapability(
        record,
        SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
      ),
    ).toBe(false);
    expect(
      supervisorRecordHasCapability(record, "some-unknown-capability"),
    ).toBe(true);
  });
});

// "the desktop leaves a host that a person started in a
// terminal untouched; the mode governs the service run only." `admittedAs`
// is how the supervisor records which kind of start it admitted -
// `"service"` (a mode-governed run: launchd/systemd/Scheduled Task, or an
// unattended CLI start) or `"foreground"` (a person's own terminal) - so a
// reader can tell the two apart. Optional on the wire like `startIdentity`:
// absent, `null` or unrecognized parses to `null` and never rejects the
// record. These tests read the parsed value with `toHaveProperty` rather
// than a typed field access, and construct raw literals rather than typed
// `SupervisorRecord` values, so they run unmodified once the type gains the
// field - vitest does not type-check.
describe("admittedAs", () => {
  it("parses admittedAs 'service'", () => {
    const raw = { ...VALID_RECORD, admittedAs: "service" };
    const parsed = parseSupervisorRecord(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveProperty("admittedAs", "service");
  });

  it("parses admittedAs 'foreground'", () => {
    const raw = { ...VALID_RECORD, admittedAs: "foreground" };
    const parsed = parseSupervisorRecord(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveProperty("admittedAs", "foreground");
  });

  const invalidAdmittedAsCases: ReadonlyArray<{
    readonly name: string;
    readonly withKey: boolean;
    readonly value: unknown;
  }> = [
    { name: "absent", withKey: false, value: undefined },
    { name: "null", withKey: true, value: null },
    { name: "an unrecognized string", withKey: true, value: "granted" },
    { name: "a number", withKey: true, value: 42 },
  ];

  for (const testCase of invalidAdmittedAsCases) {
    it(`reads ${testCase.name} admittedAs as null without rejecting the record`, () => {
      let raw: Record<string, unknown> = {
        ...VALID_RECORD,
        admittedAs: testCase.value,
      };
      if (!testCase.withKey) {
        const { admittedAs: _omitted, ...withoutAdmittedAs } = raw;
        raw = withoutAdmittedAs;
      }
      const parsed = parseSupervisorRecord(raw);
      expect(parsed).not.toBeNull();
      expect(parsed).toHaveProperty("admittedAs", null);
    });
  }

  it("serializeSupervisorRecord writes a concrete admittedAs value", () => {
    const text = serializeSupervisorRecord({
      ...VALID_RECORD,
      admittedAs: "foreground",
    });
    const raw: unknown = JSON.parse(text);
    expect(raw).toHaveProperty("admittedAs", "foreground");
  });

  it("serializeSupervisorRecord writes admittedAs null", () => {
    const text = serializeSupervisorRecord({
      ...VALID_RECORD,
      admittedAs: null,
    });
    const raw: unknown = JSON.parse(text);
    expect(raw).toHaveProperty("admittedAs", null);
  });

  it("round-trips a record carrying admittedAs", () => {
    const record = { ...VALID_RECORD, admittedAs: "service" as const };
    const text = serializeSupervisorRecord(record);
    const parsed = parseSupervisorRecordText(text);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveProperty("admittedAs", "service");
  });
});
