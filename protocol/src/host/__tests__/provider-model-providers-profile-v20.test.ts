import { describe, expect, it } from "vitest";
import { downgradeRequestAcrossMajors } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providersListModelProvidersRequestSchema,
  providersListModelProvidersRequestSchemaV20,
  providersModelProviderAuthRequestSchema,
  providersModelProviderAuthRequestSchemaV20,
} from "@traycer/protocol/host/provider-schemas";
import {
  providersListModelProvidersDowngradeV20ToV10,
  providersListModelProvidersUpgradeV10ToV20,
  providersListModelProvidersV20,
  providersModelProviderAuthDowngradeV20ToV10,
  providersModelProviderAuthUpgradeV10ToV20,
  providersModelProviderAuthV20,
} from "@traycer/protocol/host/registry";

/**
 * `providers.listModelProviders` / `providers.modelProviderAuth` grow
 * `profileId` (D25/D21, W3-T5). Registered as a MAJOR (`@2.0`), not the
 * `@1.1` additive minor the ticket text names - see
 * `providersListModelProvidersRequestSchemaV20`'s comment in
 * `provider-schemas.ts` for why a same-major minor cannot express a
 * rejecting downgrade in this framework.
 */
describe("providers.listModelProviders@2.0 profileId (D25/D21)", () => {
  it("the @1.0 request constant is unchanged and still accepts no profileId", () => {
    expect(
      providersListModelProvidersRequestSchema.safeParse({
        providerId: "opencode",
      }).success,
    ).toBe(true);
    expect(
      providersListModelProvidersRequestSchema.safeParse({
        providerId: "opencode",
        profileId: "p1",
      }).success,
    ).toBe(true); // non-strict: an unknown key is accepted and stripped, never rejected.
  });

  it("the @2.0 request round-trips a non-null profileId", () => {
    const parsed = providersListModelProvidersRequestSchemaV20.parse({
      providerId: "opencode",
      profileId: "p1",
    });
    expect(parsed.profileId).toBe("p1");
  });

  it("the @1.0 -> @2.0 upgrade fills profileId: null for an old client", () => {
    const upgraded = providersListModelProvidersUpgradeV10ToV20.upgradeRequest({
      providerId: "opencode",
    });
    expect(upgraded).toEqual({ providerId: "opencode", profileId: null });
  });

  it("the @2.0 -> @1.0 downgrade fails closed on a non-null profileId, strips a null one", () => {
    const refused =
      providersListModelProvidersDowngradeV20ToV10.downgradeRequest({
        providerId: "opencode",
        profileId: "p1",
      });
    expect(refused).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DOWNGRADE_UNSUPPORTED" }),
    });

    const accepted =
      providersListModelProvidersDowngradeV20ToV10.downgradeRequest({
        providerId: "opencode",
        profileId: null,
      });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value).not.toHaveProperty("profileId");
    expect(accepted.value).toEqual({ providerId: "opencode" });
  });
});

describe("providers.modelProviderAuth@2.0 profileId (D25/D21)", () => {
  const action = {
    action: "disconnect" as const,
    modelProviderId: "anthropic",
  };

  it("the @1.0 request constant is unchanged", () => {
    expect(
      providersModelProviderAuthRequestSchema.safeParse({
        providerId: "opencode",
        action,
      }).success,
    ).toBe(true);
  });

  it("the @2.0 request round-trips a non-null profileId", () => {
    const parsed = providersModelProviderAuthRequestSchemaV20.parse({
      providerId: "opencode",
      profileId: "p1",
      action,
    });
    expect(parsed.profileId).toBe("p1");
  });

  it("the @1.0 -> @2.0 upgrade fills profileId: null for an old client", () => {
    const upgraded = providersModelProviderAuthUpgradeV10ToV20.upgradeRequest({
      providerId: "opencode",
      action,
    });
    expect(upgraded).toEqual({
      providerId: "opencode",
      profileId: null,
      action,
    });
  });

  it("the @2.0 -> @1.0 downgrade fails closed on a non-null profileId, strips a null one", () => {
    const refused =
      providersModelProviderAuthDowngradeV20ToV10.downgradeRequest({
        providerId: "opencode",
        profileId: "p1",
        action,
      });
    expect(refused).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DOWNGRADE_UNSUPPORTED" }),
    });

    const accepted =
      providersModelProviderAuthDowngradeV20ToV10.downgradeRequest({
        providerId: "opencode",
        profileId: null,
        action,
      });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value).not.toHaveProperty("profileId");
    expect(accepted.value).toEqual({ providerId: "opencode", action });
  });
});

/**
 * Wave-2 P16's lesson: pinning the bridge objects directly (above) never
 * exercises `hostRpcRegistry`'s own `downgradePathsFromLatest` table, so a
 * wrong bridge wired in, an off-by-one `latestMinor`, or a missing
 * `upgradeFromPreviousVersion` all leave the tests above green. These drive
 * the real registry the way `agent-schemas.test.ts`'s
 * "registers major 2 as latest with the major-1 line untouched" cases do.
 */
describe("providers.listModelProviders / modelProviderAuth@2.0 registry wiring", () => {
  it("registers providers.listModelProviders major 2 as latest with the major-1 line untouched", () => {
    expect(
      hostRpcRegistry["providers.listModelProviders"][2].versions[0].contract,
    ).toBe(providersListModelProvidersV20);
    expect(
      hostRpcRegistry["providers.listModelProviders"][2].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
    expect(hostRpcRegistry["providers.listModelProviders"][2].latestMinor).toBe(
      0,
    );
    expect(
      hostRpcRegistry["providers.listModelProviders"][2]
        .downgradePathsFromLatest[1],
    ).toBe(providersListModelProvidersDowngradeV20ToV10);
  });

  it("registers providers.modelProviderAuth major 2 as latest with the major-1 line untouched", () => {
    expect(
      hostRpcRegistry["providers.modelProviderAuth"][2].versions[0].contract,
    ).toBe(providersModelProviderAuthV20);
    expect(
      hostRpcRegistry["providers.modelProviderAuth"][2].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
    expect(hostRpcRegistry["providers.modelProviderAuth"][2].latestMinor).toBe(
      0,
    );
    expect(
      hostRpcRegistry["providers.modelProviderAuth"][2]
        .downgradePathsFromLatest[1],
    ).toBe(providersModelProviderAuthDowngradeV20ToV10);
  });

  it("rejects a non-null profileId downgrade through the real registry path", () => {
    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["providers.listModelProviders"],
        2,
        1,
        { providerId: "opencode", profileId: "p1" },
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });

    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["providers.modelProviderAuth"],
        2,
        1,
        {
          providerId: "opencode",
          profileId: "p1",
          action: { action: "disconnect", modelProviderId: "anthropic" },
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
  });
});
