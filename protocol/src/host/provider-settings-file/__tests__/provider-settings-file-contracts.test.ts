import { describe, expect, it } from "vitest";
import { validateVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  providersSettingsFileResetV10,
  providersSettingsFileStatusV10,
} from "@traycer/protocol/host/provider-settings-file/contracts";

const MOVED_ASIDE_FILE_NAME =
  "provider-overrides.json.unreadable-2026-10-17T14-05-03-123Z";

describe("providers.settingsFile.status protocol contract", () => {
  it("parses an empty request", () => {
    expect(providersSettingsFileStatusV10.requestSchema.parse({})).toEqual({});
  });

  it("answers whether the whole settings document is unreadable", () => {
    for (const response of [{ unreadable: true }, { unreadable: false }]) {
      expect(
        providersSettingsFileStatusV10.responseSchema.parse(response),
      ).toEqual(response);
    }
  });

  it("rejects an empty answer and a non-boolean flag", () => {
    for (const bad of [{}, { unreadable: "yes" }, { unreadable: null }]) {
      expect(
        providersSettingsFileStatusV10.responseSchema.safeParse(bad).success,
      ).toBe(false);
    }
  });

  it("registers off the released floor with unsupported degrade", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "providers.settingsFile.status",
    );
    const entry = hostRpcRegistry["providers.settingsFile.status"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(providersSettingsFileStatusV10);
  });
});

describe("providers.settingsFile.reset protocol contract", () => {
  it("parses an empty request", () => {
    expect(providersSettingsFileResetV10.requestSchema.parse({})).toEqual({});
  });

  it("answers the file name the old document was moved to, or that it was readable", () => {
    for (const response of [
      {
        outcome: "reset",
        movedAsideFileName: MOVED_ASIDE_FILE_NAME,
        providersNotRestarted: [],
      },
      { outcome: "readable" },
    ]) {
      expect(
        providersSettingsFileResetV10.responseSchema.parse(response),
      ).toEqual(response);
    }
  });

  it("rejects a reset with no file name, an empty one, and an unknown outcome", () => {
    for (const bad of [
      { outcome: "reset", providersNotRestarted: [] },
      {
        outcome: "reset",
        movedAsideFileName: "",
        providersNotRestarted: [],
      },
      {
        outcome: "deleted",
        movedAsideFileName: MOVED_ASIDE_FILE_NAME,
        providersNotRestarted: [],
      },
      {},
    ]) {
      expect(
        providersSettingsFileResetV10.responseSchema.safeParse(bad).success,
      ).toBe(false);
    }
  });

  it("parses a reset naming the providers that could not be restarted, including an id this build does not know", () => {
    for (const providersNotRestarted of [
      [],
      ["opencode"],
      ["opencode", "some-future-provider"],
      ["some-future-provider"],
    ]) {
      const response = {
        outcome: "reset",
        movedAsideFileName: MOVED_ASIDE_FILE_NAME,
        providersNotRestarted,
      };
      expect(
        providersSettingsFileResetV10.responseSchema.parse(response),
      ).toEqual(response);
    }
  });

  it("rejects a reset that omits providersNotRestarted or carries an empty provider id", () => {
    for (const bad of [
      { outcome: "reset", movedAsideFileName: MOVED_ASIDE_FILE_NAME },
      {
        outcome: "reset",
        movedAsideFileName: MOVED_ASIDE_FILE_NAME,
        providersNotRestarted: [""],
      },
      {
        outcome: "reset",
        movedAsideFileName: MOVED_ASIDE_FILE_NAME,
        providersNotRestarted: ["opencode", ""],
      },
      {
        outcome: "reset",
        movedAsideFileName: MOVED_ASIDE_FILE_NAME,
        providersNotRestarted: "opencode",
      },
    ]) {
      expect(
        providersSettingsFileResetV10.responseSchema.safeParse(bad).success,
      ).toBe(false);
    }
  });

  it("registers off the released floor with unsupported degrade", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "providers.settingsFile.reset",
    );
    const entry = hostRpcRegistry["providers.settingsFile.reset"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(providersSettingsFileResetV10);
  });
});
