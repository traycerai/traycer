/**
 * `desktop-presence.ts`: the record's path helper, round-trip through
 * serialize/parse, and the "malformed reads as absent, never throws"
 * contract that {@link parseDesktopPresence} / {@link
 * parseDesktopPresenceText} promise every caller in this directory.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_PRESENCE_ON_EXIT_VERDICTS,
  desktopPresencePath,
  parseDesktopPresence,
  parseDesktopPresenceText,
  serializeDesktopPresence,
  type DesktopPresence,
} from "../desktop-presence";
import {
  formatDarwinProcessStartIdentity,
  formatLinuxProcessStartIdentity,
} from "../../host/lifecycle/process-start-identity";

describe("desktopPresencePath", () => {
  it("joins the filename onto the given host home directory", () => {
    expect(desktopPresencePath("/fake/host-home")).toBe(
      join("/fake/host-home", "desktop-presence.json"),
    );
  });

  it("resolves relative to whatever directory it is given", () => {
    expect(desktopPresencePath("/one/slot")).toBe(
      join("/one/slot", "desktop-presence.json"),
    );
    expect(desktopPresencePath("/another/slot")).toBe(
      join("/another/slot", "desktop-presence.json"),
    );
  });
});

const DARWIN_IDENTITY = formatDarwinProcessStartIdentity(
  "Sun Jul 6 12:00:00 2026",
);
if (DARWIN_IDENTITY === null) {
  throw new Error(
    "test fixture: formatDarwinProcessStartIdentity returned null",
  );
}

const LINUX_IDENTITY = formatLinuxProcessStartIdentity("boot-id-1", 4242);
if (LINUX_IDENTITY === null) {
  throw new Error(
    "test fixture: formatLinuxProcessStartIdentity returned null",
  );
}

const VALID_PRESENCE: DesktopPresence = {
  v: 1,
  pid: 4242,
  processStartIdentity: DARWIN_IDENTITY,
  onExit: "keep",
  policyRev: 2,
  writtenAt: "2026-08-17T12:00:00.000Z",
};

describe("serialize / parse round-trip", () => {
  it("parseDesktopPresenceText(serializeDesktopPresence(x)) returns x", () => {
    const text = serializeDesktopPresence(VALID_PRESENCE);
    expect(parseDesktopPresenceText(text)).toEqual(VALID_PRESENCE);
  });

  it("the serialized text ends with a newline", () => {
    const text = serializeDesktopPresence(VALID_PRESENCE);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("round-trips a Linux-built identity too", () => {
    const presence: DesktopPresence = {
      ...VALID_PRESENCE,
      processStartIdentity: LINUX_IDENTITY,
    };
    const text = serializeDesktopPresence(presence);
    expect(parseDesktopPresenceText(text)).toEqual(presence);
  });

  it("every onExit verdict in DESKTOP_PRESENCE_ON_EXIT_VERDICTS round-trips", () => {
    for (const onExit of DESKTOP_PRESENCE_ON_EXIT_VERDICTS) {
      const presence: DesktopPresence = { ...VALID_PRESENCE, onExit };
      const text = serializeDesktopPresence(presence);
      expect(parseDesktopPresenceText(text)).toEqual(presence);
    }
  });
});

describe("malformed input reads as absent, never throws", () => {
  const withoutV = {
    pid: VALID_PRESENCE.pid,
    processStartIdentity: VALID_PRESENCE.processStartIdentity,
    onExit: VALID_PRESENCE.onExit,
    policyRev: VALID_PRESENCE.policyRev,
    writtenAt: VALID_PRESENCE.writtenAt,
  };
  const withoutPid = {
    v: VALID_PRESENCE.v,
    processStartIdentity: VALID_PRESENCE.processStartIdentity,
    onExit: VALID_PRESENCE.onExit,
    policyRev: VALID_PRESENCE.policyRev,
    writtenAt: VALID_PRESENCE.writtenAt,
  };
  const withoutProcessStartIdentity = {
    v: VALID_PRESENCE.v,
    pid: VALID_PRESENCE.pid,
    onExit: VALID_PRESENCE.onExit,
    policyRev: VALID_PRESENCE.policyRev,
    writtenAt: VALID_PRESENCE.writtenAt,
  };
  const withoutOnExit = {
    v: VALID_PRESENCE.v,
    pid: VALID_PRESENCE.pid,
    processStartIdentity: VALID_PRESENCE.processStartIdentity,
    policyRev: VALID_PRESENCE.policyRev,
    writtenAt: VALID_PRESENCE.writtenAt,
  };
  const withoutPolicyRev = {
    v: VALID_PRESENCE.v,
    pid: VALID_PRESENCE.pid,
    processStartIdentity: VALID_PRESENCE.processStartIdentity,
    onExit: VALID_PRESENCE.onExit,
    writtenAt: VALID_PRESENCE.writtenAt,
  };
  const withoutWrittenAt = {
    v: VALID_PRESENCE.v,
    pid: VALID_PRESENCE.pid,
    processStartIdentity: VALID_PRESENCE.processStartIdentity,
    onExit: VALID_PRESENCE.onExit,
    policyRev: VALID_PRESENCE.policyRev,
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
    { name: "wrong v: 0", value: { ...VALID_PRESENCE, v: 0 } },
    { name: "wrong v: 2", value: { ...VALID_PRESENCE, v: 2 } },
    { name: 'wrong v: "1"', value: { ...VALID_PRESENCE, v: "1" } },
    { name: "missing v", value: withoutV },
    { name: "missing pid", value: withoutPid },
    {
      name: "missing processStartIdentity",
      value: withoutProcessStartIdentity,
    },
    { name: "missing onExit", value: withoutOnExit },
    { name: "missing policyRev", value: withoutPolicyRev },
    { name: "missing writtenAt", value: withoutWrittenAt },
    { name: "pid as a string", value: { ...VALID_PRESENCE, pid: "4242" } },
    {
      name: "processStartIdentity as a number",
      value: { ...VALID_PRESENCE, processStartIdentity: 1 },
    },
    { name: "onExit as a number", value: { ...VALID_PRESENCE, onExit: 1 } },
    {
      name: "policyRev as a string",
      value: { ...VALID_PRESENCE, policyRev: "2" },
    },
    {
      name: "writtenAt as a number",
      value: { ...VALID_PRESENCE, writtenAt: 1 },
    },
    { name: "pid 0", value: { ...VALID_PRESENCE, pid: 0 } },
    { name: "pid negative", value: { ...VALID_PRESENCE, pid: -1 } },
    { name: "pid non-integer", value: { ...VALID_PRESENCE, pid: 1.5 } },
    { name: "pid NaN", value: { ...VALID_PRESENCE, pid: Number.NaN } },
    {
      name: "pid Infinity",
      value: { ...VALID_PRESENCE, pid: Number.POSITIVE_INFINITY },
    },
    { name: "policyRev negative", value: { ...VALID_PRESENCE, policyRev: -1 } },
    {
      name: "policyRev non-integer",
      value: { ...VALID_PRESENCE, policyRev: 1.5 },
    },
    {
      name: "policyRev NaN",
      value: { ...VALID_PRESENCE, policyRev: Number.NaN },
    },
    {
      name: "policyRev Infinity",
      value: { ...VALID_PRESENCE, policyRev: Number.POSITIVE_INFINITY },
    },
    {
      name: "an unparseable writtenAt",
      value: { ...VALID_PRESENCE, writtenAt: "not-a-date" },
    },
    {
      name: 'a malformed processStartIdentity: ""',
      value: { ...VALID_PRESENCE, processStartIdentity: "" },
    },
    {
      name: 'a malformed processStartIdentity: "no-colon"',
      value: { ...VALID_PRESENCE, processStartIdentity: "no-colon" },
    },
    {
      name: 'a malformed processStartIdentity: "freebsd:123"',
      value: { ...VALID_PRESENCE, processStartIdentity: "freebsd:123" },
    },
    {
      name: 'a malformed processStartIdentity: "darwin:"',
      value: { ...VALID_PRESENCE, processStartIdentity: "darwin:" },
    },
  ];

  for (const testCase of cases) {
    it(`parseDesktopPresence returns null for ${testCase.name}`, () => {
      expect(() => parseDesktopPresence(testCase.value)).not.toThrow();
      expect(parseDesktopPresence(testCase.value)).toBeNull();
    });

    it(`parseDesktopPresenceText returns null for ${testCase.name}`, () => {
      const text = JSON.stringify(testCase.value);
      expect(() => parseDesktopPresenceText(text)).not.toThrow();
      expect(parseDesktopPresenceText(text)).toBeNull();
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
    it(`parseDesktopPresenceText returns null for ${testCase.name}`, () => {
      expect(() => parseDesktopPresenceText(testCase.text)).not.toThrow();
      expect(parseDesktopPresenceText(testCase.text)).toBeNull();
    });
  }
});

describe("enum rejection", () => {
  it("reads an unknown onExit as absent, never as the verdict it does not know", () => {
    for (const onExit of ["Keep", "terminate", ""]) {
      expect(parseDesktopPresence({ ...VALID_PRESENCE, onExit })).toBeNull();
    }
  });
});

describe("unknown extra keys are ignored", () => {
  it("still parses and drops the extra key", () => {
    const withExtra = { ...VALID_PRESENCE, someFutureField: "unexpected" };
    const parsed = parseDesktopPresence(withExtra);
    expect(parsed).toEqual(VALID_PRESENCE);
    expect(parsed).not.toBeNull();
    expect(parsed && "someFutureField" in parsed).toBe(false);
  });
});
