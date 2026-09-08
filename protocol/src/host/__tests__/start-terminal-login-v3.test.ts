/**
 * `providers.startTerminalLogin@3.0` (D21/D22): `profileId` + `createProfile`.
 * A MAJOR, not a minor - `host-v1.3.0-rc.3` ships `@2.0`, so an rc peer
 * already negotiates "2.0", and only a major buys the `2 -> 1`/`3 -> 2`
 * downgrades the ability to REFUSE a non-null profile target instead of
 * silently dropping it (the exact bug this refactor exists to remove).
 */
import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  upgradeRequestToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providersStartTerminalLoginDowngradeV30ToV10,
  providersStartTerminalLoginDowngradeV30ToV20,
  providersStartTerminalLoginUpgradeV20ToV30,
} from "@traycer/protocol/host/registry";

const epicScope = { kind: "epic" as const, epicId: "epic-1" };

function baseV30Request(overrides: {
  profileId?: string | null;
  createProfile?: { label: string } | null;
}) {
  return {
    providerId: "copilot" as const,
    scope: epicScope,
    cols: 80,
    rows: 24,
    profileId: overrides.profileId ?? null,
    createProfile: overrides.createProfile ?? null,
  };
}

describe("providers.startTerminalLogin@3.0 (D21/D22)", () => {
  it("2.0 -> 3.0 upgrade fills profileId/createProfile with null", () => {
    const upgraded = providersStartTerminalLoginUpgradeV20ToV30.upgradeRequest({
      providerId: "copilot",
      scope: epicScope,
      cols: 80,
      rows: 24,
    });
    expect(upgraded).toEqual({
      providerId: "copilot",
      scope: epicScope,
      cols: 80,
      rows: 24,
      profileId: null,
      createProfile: null,
    });

    const upgradedResponse =
      providersStartTerminalLoginUpgradeV20ToV30.upgradeResponse({
        sessionId: "session-1",
        replacedSessionId: null,
      });
    expect(upgradedResponse).toEqual({
      sessionId: "session-1",
      replacedSessionId: null,
      profileId: null,
    });
  });

  it("3.0 -> 2.0 refuses a non-null profileId", () => {
    const refused =
      providersStartTerminalLoginDowngradeV30ToV20.downgradeRequest(
        baseV30Request({ profileId: "profile-1" }),
      );
    expect(refused).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DOWNGRADE_UNSUPPORTED" }),
    });
  });

  it("3.0 -> 2.0 refuses a non-null createProfile", () => {
    const refused =
      providersStartTerminalLoginDowngradeV30ToV20.downgradeRequest(
        baseV30Request({ createProfile: { label: "Work" } }),
      );
    expect(refused).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DOWNGRADE_UNSUPPORTED" }),
    });
  });

  it("3.0 -> 2.0 with a null/null request downgrades clean", () => {
    const downgraded =
      providersStartTerminalLoginDowngradeV30ToV20.downgradeRequest(
        baseV30Request({}),
      );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value).toEqual({
      providerId: "copilot",
      scope: epicScope,
      cols: 80,
      rows: 24,
    });

    const responseDowngraded =
      providersStartTerminalLoginDowngradeV30ToV20.downgradeResponse({
        sessionId: "session-1",
        replacedSessionId: null,
        profileId: null,
      });
    expect(responseDowngraded).toEqual({
      ok: true,
      value: { sessionId: "session-1", replacedSessionId: null },
    });
  });

  it("3.0 -> 1.0 refuses a non-null profileId AND a non-null createProfile", () => {
    const refusedProfile =
      providersStartTerminalLoginDowngradeV30ToV10.downgradeRequest(
        baseV30Request({ profileId: "profile-1" }),
      );
    expect(refusedProfile).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DOWNGRADE_UNSUPPORTED" }),
    });

    const refusedCreate =
      providersStartTerminalLoginDowngradeV30ToV10.downgradeRequest(
        baseV30Request({ createProfile: { label: "Work" } }),
      );
    expect(refusedCreate).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DOWNGRADE_UNSUPPORTED" }),
    });
  });

  it("3.0 -> 1.0 with a null/null epic-scoped request downgrades clean (delegates to 2->1)", () => {
    const downgraded =
      providersStartTerminalLoginDowngradeV30ToV10.downgradeRequest(
        baseV30Request({}),
      );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value).toEqual({
      providerId: "copilot",
      epicId: "epic-1",
      cols: 80,
      rows: 24,
    });
  });

  it("3.0 -> 1.0 still refuses an independent scope (the 2->1 gate survives a third major opening)", () => {
    const independentScopeRequest = {
      providerId: "copilot" as const,
      scope: { kind: "independent" as const },
      cols: 80,
      rows: 24,
      profileId: null,
      createProfile: null,
    };
    const downgraded =
      providersStartTerminalLoginDowngradeV30ToV10.downgradeRequest(
        independentScopeRequest,
      );
    expect(downgraded).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DOWNGRADE_UNSUPPORTED" }),
    });
  });

  it("upgrades and downgrades through the real registry", () => {
    const upgradedRequest = upgradeRequestToVersion(
      hostRpcRegistry["providers.startTerminalLogin"],
      { major: 2, minor: 0 },
      { major: 3, minor: 0 },
      { providerId: "copilot", scope: epicScope, cols: 80, rows: 24 },
    );
    expect(upgradedRequest).toMatchObject({
      profileId: null,
      createProfile: null,
    });

    const downgraded = downgradeRequestAcrossMajors(
      hostRpcRegistry["providers.startTerminalLogin"],
      3,
      2,
      baseV30Request({ profileId: "profile-1" }),
    );
    expect(downgraded).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DOWNGRADE_UNSUPPORTED" }),
    });
  });
});
