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

const ENABLED_PREFERENCE = '{ "remoteDebuggingPortEnabled": true }';

describe("applyRemoteDebuggingPortPreference", () => {
  it("opens a system-picked port in staging when the preference file enables it", () => {
    writePreferenceFile(ENABLED_PREFERENCE);

    applyRemoteDebuggingPortPreference("staging");

    expect(electronFake.appendedSwitches).toEqual([
      ["remote-debugging-port", "0"],
    ]);
  });

  it("opens nothing in staging when there is no preference file", () => {
    applyRemoteDebuggingPortPreference("staging");

    expect(electronFake.appendedSwitches).toEqual([]);
  });

  it.each([
    ["disabled", '{ "remoteDebuggingPortEnabled": false }'],
    ["silent", "{}"],
    ["unparseable", "{remoteDebuggingPortEnabled: true}"],
  ])(
    "opens nothing in staging when the preference file is %s",
    (_, contents) => {
      writePreferenceFile(contents);

      applyRemoteDebuggingPortPreference("staging");

      expect(electronFake.appendedSwitches).toEqual([]);
    },
  );

  it.each(["production", "preview", "dev"])(
    "opens nothing in %s even when the preference file enables it",
    (environment) => {
      writePreferenceFile(ENABLED_PREFERENCE);

      applyRemoteDebuggingPortPreference(environment);

      expect(electronFake.appendedSwitches).toEqual([]);
    },
  );

  it.each(["remote-debugging-port", "remote-debugging-pipe"])(
    "leaves an existing %s switch alone even when the preference file enables the port",
    (existingSwitch) => {
      writePreferenceFile(ENABLED_PREFERENCE);
      electronFake.presentSwitches.add(existingSwitch);

      applyRemoteDebuggingPortPreference("staging");

      expect(electronFake.appendedSwitches).toEqual([]);
    },
  );
});
