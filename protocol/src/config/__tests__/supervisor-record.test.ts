/**
 * `supervisor-record.ts`: the record's path helper, round-trip through
 * serialize/parse, the "malformed reads as absent, never throws" contract,
 * and {@link supervisorRecordHasCapability}'s open-vocabulary read.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
