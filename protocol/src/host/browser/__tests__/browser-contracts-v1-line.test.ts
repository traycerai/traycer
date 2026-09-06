import { describe, expect, it } from "vitest";
import {
  browserScreencastOpenRequestSchema,
  browserScreencastV20,
  browserSessionsClientFrameSchema,
  browserSessionsOpenRequestSchema,
  browserSessionsServerFrameSchema,
  browserSessionsV20,
} from "@traycer/protocol/host/browser/contracts";
import {
  browserScreencastOpenRequestSchemaV10,
  browserScreencastV10,
  browserSessionsClientFrameSchemaV10,
  browserSessionsOpenRequestSchemaV10,
  browserSessionsServerFrameSchemaV10,
  browserSessionsV10,
} from "@traycer/protocol/host/browser/contracts-v1";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import {
  resourcesListLocalServersDowngradeV20ToV10,
  resourcesListLocalServersUpgradeV10ToV20,
  resourcesListLocalServersV10,
  resourcesListLocalServersV20,
} from "@traycer/protocol/host/resources/subscribe";

/**
 * The v1.3.0 release shipped `browser.sessions@1.0`, `browser.screencast@1.0`
 * and `resources.listLocalServers@1.0` addressed by `epicId`. The Start Page
 * needed the device's epic-less inventory, which is a different open request
 * and therefore a separately served major - and the released peer's
 * `.strict()` frame schemas drop any frame carrying a field they never
 * declared, so every field the live line added is one the host must strip
 * when serving `@1`. These tests pin both halves of that: what each line
 * accepts, and exactly which live fields the `@1` line rejects.
 */

const TAB_V10 = {
  tabId: "tab-1",
  url: "http://localhost:3000",
  originTier: "dev" as const,
  status: "ready" as const,
  title: "App",
  viewed: false,
  drivenBy: [],
};

const SESSION_V10 = {
  sessionId: "session-1",
  epicId: "epic-1",
  hostId: "host-1",
  profile: "primary" as const,
  lastActivityAt: 20,
  runtime: { kind: "headless" as const, revision: 0 },
  tabs: [TAB_V10],
};

const EPIC_SCOPE = { kind: "epic" as const, epicId: "epic-1" };
const INDEPENDENT_SCOPE = { kind: "independent" as const };

function snapshotV10(session: unknown): boolean {
  return browserSessionsServerFrameSchemaV10.safeParse({
    kind: "snapshot",
    hasBinaryPayload: false,
    sessions: [session],
  }).success;
}

describe("browser stream majors", () => {
  it("serves the frozen 1.0 line beside the live 2.0 line", () => {
    const sessions = hostStreamRpcRegistry["browser.sessions"];
    const screencast = hostStreamRpcRegistry["browser.screencast"];
    expect(Object.keys(sessions).sort()).toEqual(["1", "2"]);
    expect(Object.keys(screencast).sort()).toEqual(["1", "2"]);
    expect(sessions[1].versions[0]?.contract).toBe(browserSessionsV10);
    expect(sessions[2].versions[0]?.contract).toBe(browserSessionsV20);
    expect(screencast[1].versions[0]?.contract).toBe(browserScreencastV10);
    expect(screencast[2].versions[0]?.contract).toBe(browserScreencastV20);
  });

  it("addresses the sessions open by epicId at 1.0 and by scope at 2.0", () => {
    expect(
      browserSessionsOpenRequestSchemaV10.safeParse({ epicId: "epic-1" })
        .success,
    ).toBe(true);
    expect(
      browserSessionsOpenRequestSchemaV10.safeParse({ scope: EPIC_SCOPE })
        .success,
    ).toBe(false);
    expect(
      browserSessionsOpenRequestSchema.safeParse({ scope: EPIC_SCOPE }).success,
    ).toBe(true);
    expect(
      browserSessionsOpenRequestSchema.safeParse({ scope: INDEPENDENT_SCOPE })
        .success,
    ).toBe(true);
    expect(
      browserSessionsOpenRequestSchema.safeParse({ epicId: "epic-1" }).success,
    ).toBe(false);
  });

  it("addresses the screencast open by epicId at 1.0, without a handoff token", () => {
    const base = {
      sessionId: "session-1",
      tabId: "tab-1",
      maxWidth: 800,
      maxHeight: 600,
      quality: 60,
      format: "jpeg" as const,
      role: "tile" as const,
    };
    expect(
      browserScreencastOpenRequestSchemaV10.safeParse({
        ...base,
        epicId: "epic-1",
      }).success,
    ).toBe(true);
    expect(
      browserScreencastOpenRequestSchemaV10.safeParse({
        ...base,
        epicId: "epic-1",
        handoffToken: null,
      }).success,
    ).toBe(false);
    expect(
      browserScreencastOpenRequestSchema.safeParse({
        ...base,
        scope: EPIC_SCOPE,
        handoffToken: "token-1",
      }).success,
    ).toBe(true);
    expect(
      browserScreencastOpenRequestSchema.safeParse({
        ...base,
        epicId: "epic-1",
        handoffToken: null,
      }).success,
    ).toBe(false);
  });
});

describe("browser.sessions@1.0 rejects every field the live line added", () => {
  // Each `false` here is a field the host's @1 projection has to strip: the
  // released GUI drops the whole frame otherwise.
  it("session info carries epicId, not scope, and tabs no boundWindowId", () => {
    expect(snapshotV10(SESSION_V10)).toBe(true);
    const { epicId: _epicId, ...withoutEpicId } = SESSION_V10;
    expect(snapshotV10({ ...withoutEpicId, scope: EPIC_SCOPE })).toBe(false);
    expect(
      snapshotV10({
        ...SESSION_V10,
        tabs: [{ ...TAB_V10, boundWindowId: null }],
      }),
    ).toBe(false);
    expect(
      browserSessionsServerFrameSchema.safeParse({
        kind: "snapshot",
        hasBinaryPayload: false,
        sessions: [
          {
            ...withoutEpicId,
            scope: EPIC_SCOPE,
            tabs: [{ ...TAB_V10, boundWindowId: "window-1" }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("tabOpened carries no openerTabId", () => {
    const opened = {
      kind: "tabOpened",
      hasBinaryPayload: false,
      sessionId: "session-1",
      tabId: "tab-2",
      source: "page",
    };
    expect(browserSessionsServerFrameSchemaV10.safeParse(opened).success).toBe(
      true,
    );
    expect(
      browserSessionsServerFrameSchemaV10.safeParse({
        ...opened,
        openerTabId: "tab-1",
      }).success,
    ).toBe(false);
  });

  it("openTabResult carries no handoffToken", () => {
    const result = {
      kind: "openTabResult",
      hasBinaryPayload: false,
      requestId: "req-1",
      result: { ok: true, sessionId: "session-1", tabId: "tab-2" },
    };
    expect(browserSessionsServerFrameSchemaV10.safeParse(result).success).toBe(
      true,
    );
    expect(
      browserSessionsServerFrameSchemaV10.safeParse({
        ...result,
        result: { ...result.result, handoffToken: "token-1" },
      }).success,
    ).toBe(false);
  });

  it("has no attachTab or moveTab client frames", () => {
    for (const kind of ["attachTab", "moveTab"]) {
      const frame = {
        kind,
        hasBinaryPayload: false,
        requestId: "req-1",
        tabId: "tab-1",
      };
      expect(browserSessionsClientFrameSchemaV10.safeParse(frame).success).toBe(
        false,
      );
      expect(browserSessionsClientFrameSchema.safeParse(frame).success).toBe(
        true,
      );
    }
  });

  it("electronTabLifecycleReady carries no desktopWindowId", () => {
    const ready = {
      kind: "electronTabLifecycleReady",
      hasBinaryPayload: false,
      coLocatedHostId: "host-1",
    };
    expect(browserSessionsClientFrameSchemaV10.safeParse(ready).success).toBe(
      true,
    );
    expect(
      browserSessionsClientFrameSchemaV10.safeParse({
        ...ready,
        desktopWindowId: "window-1",
      }).success,
    ).toBe(false);
  });
});

describe("resources.listLocalServers majors", () => {
  it("registers the frozen 1.0 line and the scope-addressed 2.0 line", () => {
    const method = hostRpcRegistry["resources.listLocalServers"];
    expect(method[1].versions[0].contract).toBe(resourcesListLocalServersV10);
    expect(method[2].versions[0].contract).toBe(resourcesListLocalServersV20);
    expect(method[2].versions[0].upgradeFromPreviousVersion).toBe(
      resourcesListLocalServersUpgradeV10ToV20,
    );
    expect(method[2].downgradePathsFromLatest[1]).toBe(
      resourcesListLocalServersDowngradeV20ToV10,
    );
  });

  it("upgrades a 1.0 request to an epic scope", () => {
    expect(
      resourcesListLocalServersUpgradeV10ToV20.upgradeRequest({
        epicId: "epic-1",
      }),
    ).toEqual({ scope: EPIC_SCOPE });
    const response = { servers: [{ pid: 4, port: 3000, processName: "node" }] };
    expect(
      resourcesListLocalServersUpgradeV10ToV20.upgradeResponse(response),
    ).toEqual(response);
  });

  it("downgrades an epic request to epicId and refuses an independent one", () => {
    expect(
      resourcesListLocalServersDowngradeV20ToV10.downgradeRequest({
        scope: EPIC_SCOPE,
      }),
    ).toEqual({ ok: true, value: { epicId: "epic-1" } });
    const refused = resourcesListLocalServersDowngradeV20ToV10.downgradeRequest(
      { scope: INDEPENDENT_SCOPE },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("DOWNGRADE_UNSUPPORTED");
    }
  });
});
