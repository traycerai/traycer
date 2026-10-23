import { describe, expect, it } from "vitest";
import { validateVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  providersSettingsFileResetProviderV10,
  providersSettingsFileResetV10,
  providersSettingsFileStatusUpgradeV10ToV11,
  providersSettingsFileStatusV10,
  providersSettingsFileStatusV11,
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
    expect(entry[1].latestMinor).toBe(1);
    expect(entry[1].versions[0].contract).toBe(providersSettingsFileStatusV10);
    expect(entry[1].versions[1].contract).toBe(providersSettingsFileStatusV11);
    expect(entry[1].versions[1].upgradeFromPreviousVersion).toBe(
      providersSettingsFileStatusUpgradeV10ToV11,
    );
  });

  it("names unreadable provider rows from 1.1, including an id this build does not know", () => {
    for (const unreadableProviderIds of [
      [],
      ["droid"],
      ["droid", "some-future-provider"],
    ]) {
      const response = { unreadable: false, unreadableProviderIds };
      expect(
        providersSettingsFileStatusV11.responseSchema.parse(response),
      ).toEqual(response);
    }
  });

  it("rejects a 1.1 answer without the provider list or with an empty id", () => {
    for (const bad of [
      { unreadable: false },
      { unreadable: false, unreadableProviderIds: [""] },
      { unreadable: false, unreadableProviderIds: "droid" },
    ]) {
      expect(
        providersSettingsFileStatusV11.responseSchema.safeParse(bad).success,
      ).toBe(false);
    }
  });

  it("upgrades a 1.0 host's answer to one that names no provider rows", () => {
    for (const unreadable of [true, false]) {
      expect(
        providersSettingsFileStatusUpgradeV10ToV11.upgradeResponse(
          providersSettingsFileStatusV10.responseSchema.parse({ unreadable }),
        ),
      ).toEqual({ unreadable, unreadableProviderIds: [] });
    }
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

describe("providers.settingsFile.resetProvider protocol contract", () => {
  const BACKUP =
    "provider-overrides.json.droid-unreadable-2026-10-23T12-40-00-000Z";

  it("parses a request naming one provider, including an id this build does not know", () => {
    for (const providerId of ["droid", "some-future-provider"]) {
      expect(
        providersSettingsFileResetProviderV10.requestSchema.parse({
          providerId,
        }),
      ).toEqual({ providerId });
    }
  });

  it("rejects a request with no provider or an empty one", () => {
    for (const bad of [{}, { providerId: "" }, { providerId: 7 }]) {
      expect(
        providersSettingsFileResetProviderV10.requestSchema.safeParse(bad)
          .success,
      ).toBe(false);
    }
  });

  it("parses every outcome, each naming the backups the call wrote", () => {
    for (const response of [
      {
        outcome: "reset",
        backupFileName: BACKUP,
        backupFileNames: [BACKUP],
        providersNotRestarted: ["some-future-provider"],
      },
      { outcome: "readable", backupFileNames: [] },
      { outcome: "readable", backupFileNames: [BACKUP] },
      { outcome: "document-unreadable", backupFileNames: [] },
      { outcome: "changed", backupFileNames: [BACKUP, `${BACKUP}-1`] },
      { outcome: "failed", backupFileNames: [BACKUP] },
    ]) {
      expect(
        providersSettingsFileResetProviderV10.responseSchema.parse(response),
      ).toEqual(response);
    }
  });

  it("rejects an outcome without its backup list, a reset without its backup, and an unknown outcome", () => {
    for (const bad of [
      { outcome: "readable" },
      { outcome: "failed", backupFileNames: [""] },
      {
        outcome: "reset",
        backupFileNames: [BACKUP],
        providersNotRestarted: [],
      },
      {
        outcome: "reset",
        backupFileName: "",
        backupFileNames: [BACKUP],
        providersNotRestarted: [],
      },
      { outcome: "deleted", backupFileNames: [] },
      {},
    ]) {
      expect(
        providersSettingsFileResetProviderV10.responseSchema.safeParse(bad)
          .success,
      ).toBe(false);
    }
  });

  it("registers off the released floor with unsupported degrade", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "providers.settingsFile.resetProvider",
    );
    const entry = hostRpcRegistry["providers.settingsFile.resetProvider"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(
      providersSettingsFileResetProviderV10,
    );
  });
});
