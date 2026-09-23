/**
 * `epic.updateChatRunSettings@1.2` - the strict settings tuple carries the
 * chat's agent identity.
 *
 * `@1.1` is RELEASED and stays frozen without the field. `@1.2` requires it,
 * so a new client must state an identity (`null` is the stock one). A `@1.1`
 * caller is upgraded with `identityId: null`, which there means "not stated":
 * the host branches on the caller's minor against
 * `EPIC_UPDATE_CHAT_RUN_SETTINGS_IDENTITY_MINOR` and keeps the stored identity
 * rather than clearing it. A `@1.2` request sent to a `@1.1` host is re-parsed
 * through the frozen schema, which strips the field - an old host has no
 * identities to apply.
 */
import { describe, expect, it } from "vitest";
import { upgradeRequestToVersion } from "@traycer/protocol/framework/index";
import { hostAgentRemoteSenderFactsSchema } from "@traycer/protocol/host/host-agent-capabilities";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { epicUpdateChatRunSettingsUpgradeV11ToV12 } from "@traycer/protocol/host/epic/contracts";
import {
  EPIC_UPDATE_CHAT_RUN_SETTINGS_IDENTITY_MINOR,
  updateChatRunSettingsRequestSchemaV11,
  updateChatRunSettingsRequestSchemaV12,
  type UpdateChatRunSettingsRequestV11,
} from "@traycer/protocol/host/epic/unary-schemas";

const V11 = { major: 1, minor: 1 } as const;
const V12 = { major: 1, minor: 2 } as const;

const registry = hostRpcRegistry["epic.updateChatRunSettings"];

const SETTINGS_V11: UpdateChatRunSettingsRequestV11["settings"] = {
  harnessId: "claude",
  model: "claude-sonnet-4",
  permissionMode: "full_access",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const REQUEST_V11: UpdateChatRunSettingsRequestV11 = {
  epicId: "epic-1",
  chatId: "chat-1",
  settings: SETTINGS_V11,
};

describe("epic.updateChatRunSettings@1.2 registration", () => {
  it("is the latest minor, and the host's identity gate names it", () => {
    expect(registry[1].latestMinor).toBe(2);
    expect(EPIC_UPDATE_CHAT_RUN_SETTINGS_IDENTITY_MINOR).toBe(2);
    expect(registry[1].versions[2].contract.schemaVersion).toEqual(V12);
  });
});

describe("updateChatRunSettingsRequestSchemaV11 (frozen)", () => {
  it("does not carry identityId, and strips one a newer client sends", () => {
    const parsed = updateChatRunSettingsRequestSchemaV11.parse({
      ...REQUEST_V11,
      settings: { ...SETTINGS_V11, identityId: "identity_1" },
    });
    expect(parsed.settings).not.toHaveProperty("identityId");
    expect(parsed).toEqual(REQUEST_V11);
  });
});

describe("updateChatRunSettingsRequestSchemaV12", () => {
  it("round-trips a named identity and the stock one", () => {
    for (const identityId of ["identity_1", null]) {
      const request = {
        ...REQUEST_V11,
        settings: { ...SETTINGS_V11, identityId },
      };
      expect(updateChatRunSettingsRequestSchemaV12.parse(request)).toEqual(
        request,
      );
    }
  });

  it("refuses a tuple that does not state an identity", () => {
    expect(
      updateChatRunSettingsRequestSchemaV12.safeParse(REQUEST_V11).success,
    ).toBe(false);
  });
});

describe("epic.updateChatRunSettings v1.1 → v1.2 upgrade", () => {
  it("fills identityId: null and preserves every other field", () => {
    const upgraded =
      epicUpdateChatRunSettingsUpgradeV11ToV12.upgradeRequest(REQUEST_V11);
    expect(upgraded).toEqual({
      ...REQUEST_V11,
      settings: { ...SETTINGS_V11, identityId: null },
    });
    // The host validates the upgraded request against the canonical minor.
    expect(
      updateChatRunSettingsRequestSchemaV12.safeParse(upgraded).success,
    ).toBe(true);
  });

  it("upgrades through the host registry minor chain", () => {
    expect(upgradeRequestToVersion(registry, V11, V12, REQUEST_V11)).toEqual({
      ...REQUEST_V11,
      settings: { ...SETTINGS_V11, identityId: null },
    });
  });
});

describe("hostAgentRemoteSenderFactsSchema (GUI arm)", () => {
  it("carries the sender's identity so a cross-host child inherits it", () => {
    const facts = {
      surface: "gui" as const,
      hostId: "host-1",
      settings: { ...SETTINGS_V11, identityId: "identity_1" },
    };
    expect(hostAgentRemoteSenderFactsSchema.parse(facts)).toEqual(facts);
  });

  it("refuses GUI settings that do not state an identity", () => {
    expect(
      hostAgentRemoteSenderFactsSchema.safeParse({
        surface: "gui",
        hostId: "host-1",
        settings: SETTINGS_V11,
      }).success,
    ).toBe(false);
  });
});
