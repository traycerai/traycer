import { describe, expect, it } from "vitest";
import { traycerLabelIdsForBase } from "../identity";
import {
  classifyLingerState,
  classifyUnitFile,
  extractExecStartTokens,
  tokenizeExecStart,
} from "../linux/unit-file";

const KNOWN = traycerLabelIdsForBase("ai.traycer.host");

const UNIT_WITH_HOST_START = [
  "[Unit]",
  "Description=Traycer Host",
  "[Service]",
  "ExecStart=/opt/traycer/bin/traycer host start",
].join("\n");

describe("classifyUnitFile", () => {
  it("is unreadable when the fs read failed", () => {
    const result = classifyUnitFile({
      path: "/home/x/.config/systemd/user/ai.traycer.host.service",
      labelId: KNOWN.cliRaw,
      knownLabels: KNOWN,
      exists: true,
      text: null,
      readError: "EACCES",
    });
    expect(result).toEqual({ kind: "unreadable", cause: "EACCES" });
  });

  it("is absent when the unit file does not exist", () => {
    const result = classifyUnitFile({
      path: "/home/x/.config/systemd/user/ai.traycer.host.service",
      labelId: KNOWN.cliRaw,
      knownLabels: KNOWN,
      exists: false,
      text: null,
      readError: null,
    });
    expect(result).toEqual({ kind: "absent" });
  });

  it("is indeterminate(parse-error) when the unit file has no ExecStart line", () => {
    const result = classifyUnitFile({
      path: "/home/x/.config/systemd/user/ai.traycer.host.service",
      labelId: KNOWN.cliRaw,
      knownLabels: KNOWN,
      exists: true,
      text: "[Unit]\nDescription=no exec start here",
      readError: null,
    });
    expect(result).toEqual({ kind: "indeterminate", cause: "parse-error" });
  });

  it("is observed with an exec-start identity signal (not program-arguments) for a Traycer ExecStart line", () => {
    const result = classifyUnitFile({
      path: "/home/x/.config/systemd/user/ai.traycer.host.service",
      labelId: KNOWN.cliRaw,
      knownLabels: KNOWN,
      exists: true,
      text: UNIT_WITH_HOST_START,
      readError: null,
    });
    expect(result.kind).toBe("observed");
    if (result.kind === "observed") {
      expect(result.identity.kind).toBe("attested");
      if (result.identity.kind === "attested") {
        expect(
          result.identity.signals.some((s) => s.kind === "exec-start"),
        ).toBe(true);
        expect(
          result.identity.signals.some((s) => s.kind === "program-arguments"),
        ).toBe(false);
      }
    }
  });
});

describe("extractExecStartTokens", () => {
  it("extracts and tokenizes the ExecStart= line", () => {
    expect(extractExecStartTokens(UNIT_WITH_HOST_START)).toEqual([
      "/opt/traycer/bin/traycer",
      "host",
      "start",
    ]);
  });

  it("returns null when there is no ExecStart= line", () => {
    expect(extractExecStartTokens("[Unit]\nDescription=x")).toBeNull();
  });

  it("returns null when ExecStart= has no content", () => {
    expect(extractExecStartTokens("ExecStart=")).toBeNull();
  });
});

describe("tokenizeExecStart", () => {
  it("splits on whitespace outside quotes", () => {
    expect(tokenizeExecStart("/bin/foo host start")).toEqual([
      "/bin/foo",
      "host",
      "start",
    ]);
  });

  it("keeps a double-quoted argument with embedded spaces as one token", () => {
    expect(tokenizeExecStart('/bin/foo "an arg with spaces" start')).toEqual([
      "/bin/foo",
      "an arg with spaces",
      "start",
    ]);
  });

  it("respects backslash escapes inside quotes", () => {
    expect(tokenizeExecStart('/bin/foo "escaped\\"quote"')).toEqual([
      "/bin/foo",
      'escaped"quote',
    ]);
  });

  it("collapses repeated whitespace between tokens", () => {
    expect(tokenizeExecStart("/bin/foo   host    start")).toEqual([
      "/bin/foo",
      "host",
      "start",
    ]);
  });
});

describe("classifyLingerState", () => {
  const okResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    spawnFailed: false,
  };

  it("is absent when the user is not known", () => {
    expect(classifyLingerState(okResult, false)).toEqual({ kind: "absent" });
  });

  it("is indeterminate(loginctl-failed) on spawn failure", () => {
    expect(
      classifyLingerState({ ...okResult, spawnFailed: true }, true),
    ).toEqual({ kind: "indeterminate", cause: "loginctl-failed" });
  });

  it("is indeterminate(loginctl-failed) on timeout", () => {
    expect(classifyLingerState({ ...okResult, timedOut: true }, true)).toEqual({
      kind: "indeterminate",
      cause: "loginctl-failed",
    });
  });

  it("is indeterminate(loginctl-failed) on a non-zero exit", () => {
    expect(classifyLingerState({ ...okResult, exitCode: 1 }, true)).toEqual({
      kind: "indeterminate",
      cause: "loginctl-failed",
    });
  });

  it("is indeterminate(parse-error) when Linger= is missing from stdout", () => {
    expect(
      classifyLingerState({ ...okResult, stdout: "SomeOther=1" }, true),
    ).toEqual({ kind: "indeterminate", cause: "parse-error" });
  });

  it.each([
    ["yes", true],
    ["no", false],
    ["true", true],
    ["false", false],
  ] as const)("parses Linger=%s as enabled=%s", (raw, enabled) => {
    expect(
      classifyLingerState({ ...okResult, stdout: `Linger=${raw}` }, true),
    ).toEqual({ kind: "observed", enabled });
  });
});
