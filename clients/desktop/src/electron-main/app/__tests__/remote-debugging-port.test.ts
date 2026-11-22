import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronFake = vi.hoisted(() => ({
  userDataPath: "",
  presentSwitches: new Set<string>(),
  appendedSwitches: [] as Array<[string, string]>,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronFake.userDataPath,
    commandLine: {
      hasSwitch: (name: string) => electronFake.presentSwitches.has(name),
      appendSwitch: (name: string, value: string) => {
        electronFake.appendedSwitches.push([name, value]);
      },
    },
  },
}));

vi.mock("../logger", () => ({ log: { info: vi.fn() } }));

import { applyRemoteDebuggingPortPreference } from "../remote-debugging-port";

function writePreferenceFile(contents: string): void {
  writeFileSync(
    join(electronFake.userDataPath, "remote-debugging-port.json"),
    contents,
  );
}

beforeEach(() => {
  electronFake.userDataPath = mkdtempSync(join(tmpdir(), "debugging-port-"));
  electronFake.presentSwitches.clear();
  electronFake.appendedSwitches.length = 0;
});

afterEach(() => {
  rmSync(electronFake.userDataPath, { recursive: true, force: true });
});

describe("applyRemoteDebuggingPortPreference", () => {
  it("never opens the port in production, even when the preference file enables it", () => {
    writePreferenceFile('{ "remoteDebuggingPortEnabled": true }');

    applyRemoteDebuggingPortPreference("production");

    expect(electronFake.appendedSwitches).toEqual([]);
  });

  it.each(["preview", "dev"])("opens nothing in %s", (environment) => {
    applyRemoteDebuggingPortPreference(environment);

    expect(electronFake.appendedSwitches).toEqual([]);
  });

  it("opens a system-picked port in staging when there is no preference file", () => {
    applyRemoteDebuggingPortPreference("staging");

    expect(electronFake.appendedSwitches).toEqual([
      ["remote-debugging-port", "0"],
    ]);
  });

  it("opens the port in staging when the preference file does not say false", () => {
    writePreferenceFile("{}");

    applyRemoteDebuggingPortPreference("staging");

    expect(electronFake.appendedSwitches).toEqual([
      ["remote-debugging-port", "0"],
    ]);
  });

  it("respects the off switch in staging", () => {
    writePreferenceFile('{ "remoteDebuggingPortEnabled": false }');

    applyRemoteDebuggingPortPreference("staging");

    expect(electronFake.appendedSwitches).toEqual([]);
  });

  it("treats a preference file that cannot be parsed as the off switch", () => {
    writePreferenceFile("{remoteDebuggingPortEnabled: false}");

    applyRemoteDebuggingPortPreference("staging");

    expect(electronFake.appendedSwitches).toEqual([]);
  });

  it.each(["remote-debugging-port", "remote-debugging-pipe"])(
    "leaves an existing %s switch alone",
    (existingSwitch) => {
      electronFake.presentSwitches.add(existingSwitch);

      applyRemoteDebuggingPortPreference("staging");

      expect(electronFake.appendedSwitches).toEqual([]);
    },
  );
});
