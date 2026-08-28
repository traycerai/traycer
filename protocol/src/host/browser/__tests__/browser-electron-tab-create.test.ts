import { describe, expect, it } from "vitest";
import {
  browserSessionsClientFrameSchema,
  browserSessionsServerFrameSchema,
} from "@traycer/protocol/host/browser/contracts";

const CREATE_REQUEST = {
  kind: "createElectronTab",
  hasBinaryPayload: false,
  requestId: "req-create-1",
  sessionId: "session-1",
  tabId: "tab-minted-9",
  requestedUrl: "https://example.com/agent",
  reason: "agent-open",
  seedStorageState: { cookies: [], origins: [] },
} as const;

const CREATE_BOOTSTRAP = {
  ...CREATE_REQUEST,
  requestId: "req-bootstrap-1",
  reason: "session-bootstrap",
} as const;

const RELEASE_REQUEST = {
  kind: "releaseElectronTab",
  hasBinaryPayload: false,
  sessionId: "session-1",
  tabId: "tab-minted-9",
  registrationId: "native-1",
} as const;

const PROVISIONED = {
  kind: "electronTabProvisioned",
  hasBinaryPayload: false,
  requestId: "req-create-1",
  sessionId: "session-1",
  tabId: "tab-minted-9",
  registrationId: "native-1",
} as const;

const FAILED = {
  kind: "electronTabCreateFailed",
  hasBinaryPayload: false,
  requestId: "req-create-1",
  sessionId: "session-1",
  tabId: "tab-minted-9",
  code: "native_create_failed",
  message: "Electron rejected the guest creation.",
} as const;

const ACCEPTED = {
  kind: "electronTabAccepted",
  hasBinaryPayload: false,
  requestId: "req-create-1",
  sessionId: "session-1",
  tabId: "tab-minted-9",
  registrationId: "native-1",
} as const;

const HANDOFF = {
  kind: "electronTabHandoff",
  hasBinaryPayload: false,
  requestId: "req-handoff-1",
  sessionId: "session-1",
  tabId: "tab-minted-9",
  registrationId: "native-1",
  capturedUrl: "https://example.com/agent",
  capturedStorageState: null,
  siblingTabs: [],
  reason: "gui-quit",
} as const;

describe("browser.sessions Electron tab birth", () => {
  it("requires the complete host-owned birth identity", () => {
    const parsed = browserSessionsServerFrameSchema.safeParse(CREATE_REQUEST);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(CREATE_REQUEST);

    for (const key of [
      "tabId",
      "requestedUrl",
      "reason",
      "seedStorageState",
    ] as const) {
      const incomplete: Record<string, unknown> = { ...CREATE_REQUEST };
      delete incomplete[key];
      expect(
        browserSessionsServerFrameSchema.safeParse(incomplete).success,
      ).toBe(false);
    }
  });

  it("represents bootstrap as a reason, not a background identity", () => {
    expect(
      browserSessionsServerFrameSchema.safeParse(CREATE_BOOTSTRAP).success,
    ).toBe(true);
  });

  it("requires the native incarnation on release", () => {
    const parsed = browserSessionsServerFrameSchema.safeParse(RELEASE_REQUEST);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(RELEASE_REQUEST);

    const { registrationId: _registrationId, ...incomplete } = RELEASE_REQUEST;
    expect(browserSessionsServerFrameSchema.safeParse(incomplete).success).toBe(
      false,
    );
  });

  it("settles birth with one exact provisioned or failed frame", () => {
    expect(
      browserSessionsClientFrameSchema.safeParse(PROVISIONED).success,
    ).toBe(true);
    expect(browserSessionsClientFrameSchema.safeParse(FAILED).success).toBe(
      true,
    );

    const { tabId: _tabId, ...provisionedWithoutTabId } = PROVISIONED;
    expect(
      browserSessionsClientFrameSchema.safeParse(provisionedWithoutTabId)
        .success,
    ).toBe(false);
  });

  it("rejects every superseded birth frame", () => {
    for (const kind of [
      "electronTabRegistered",
      "electronTabRegistrationFailed",
      "registerElectronTab",
      "electronTabCreated",
      "electronTabReady",
    ]) {
      const schema = kind.startsWith("electronTabR")
        ? browserSessionsServerFrameSchema
        : browserSessionsClientFrameSchema;
      expect(
        schema.safeParse({
          kind,
          hasBinaryPayload: false,
          requestId: "legacy-1",
          registrationId: "native-1",
          sessionId: "session-1",
          tabId: "tab-1",
        }).success,
      ).toBe(false);
    }
  });

  it("confirms the exact accepted native incarnation", () => {
    expect(browserSessionsServerFrameSchema.safeParse(ACCEPTED).success).toBe(
      true,
    );
  });

  it("hands off the exact durable tab incarnation, never a presentation tile", () => {
    const parsed = browserSessionsClientFrameSchema.safeParse(HANDOFF);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(HANDOFF);

    for (const key of ["sessionId", "tabId", "registrationId"] as const) {
      const incomplete: Record<string, unknown> = { ...HANDOFF };
      delete incomplete[key];
      expect(
        browserSessionsClientFrameSchema.safeParse(incomplete).success,
      ).toBe(false);
    }

    const {
      sessionId: _sessionId,
      tabId: _tabId,
      registrationId: _registrationId,
      ...withoutIdentity
    } = HANDOFF;
    expect(
      browserSessionsClientFrameSchema.safeParse({
        ...withoutIdentity,
        tileInstanceId: "tile-legacy",
      }).success,
    ).toBe(false);

    const withSibling = {
      ...HANDOFF,
      siblingTabs: [
        {
          tabId: "tab-minted-10",
          registrationId: "native-2",
          url: "https://example.com/sibling",
          capturedStorageState: null,
        },
      ],
    } as const;
    expect(
      browserSessionsClientFrameSchema.safeParse(withSibling).success,
    ).toBe(true);
    const siblingWithoutIncarnation = {
      ...withSibling,
      siblingTabs: withSibling.siblingTabs.map(
        ({ registrationId: _registrationId, ...sibling }) => sibling,
      ),
    };
    expect(
      browserSessionsClientFrameSchema.safeParse(siblingWithoutIncarnation)
        .success,
    ).toBe(false);
  });
});
