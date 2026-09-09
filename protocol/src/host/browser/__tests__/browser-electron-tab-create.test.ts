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
  profile: "primary",
  seedStorageState: { cookies: [], origins: [] },
} as const;

const CREATE_ISOLATED = {
  ...CREATE_REQUEST,
  requestId: "req-isolated-1",
  profile: "isolated",
  seedStorageState: null,
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

describe("browser.sessions Electron tab birth", () => {
  it("requires the complete host-owned birth identity", () => {
    const parsed = browserSessionsServerFrameSchema.safeParse(CREATE_REQUEST);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(CREATE_REQUEST);

    for (const key of [
      "tabId",
      "requestedUrl",
      "reason",
      "profile",
      "seedStorageState",
    ] as const) {
      const incomplete: Record<string, unknown> = { ...CREATE_REQUEST };
      delete incomplete[key];
      expect(
        browserSessionsServerFrameSchema.safeParse(incomplete).success,
      ).toBe(false);
    }
  });

  it("carries the jar the guest must be born into", () => {
    const parsed = browserSessionsServerFrameSchema.safeParse(CREATE_ISOLATED);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(CREATE_ISOLATED);

    expect(
      browserSessionsServerFrameSchema.safeParse({
        ...CREATE_REQUEST,
        profile: "ephemeral",
      }).success,
    ).toBe(false);
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

  it("carries no arm for any superseded birth frame", () => {
    // Asserted on the DISCRIMINATOR, not on a hand-built payload: a
    // `safeParse` of one made-up body fails for whatever reason comes first,
    // so it would keep passing even if the arm came back with different
    // fields. The absent `kind` literal is the actual claim.
    for (const kind of [
      "electronTabRegistered",
      "electronTabRegistrationFailed",
      "registerElectronTab",
      "electronTabCreated",
      "electronTabReady",
      "electronTabHandoff",
    ]) {
      expect(
        browserSessionsServerFrameSchema.options.every(
          (option) => option.shape.kind.value !== kind,
        ),
      ).toBe(true);
      expect(
        browserSessionsClientFrameSchema.options.every(
          (option) => option.shape.kind.value !== kind,
        ),
      ).toBe(true);
    }
  });

  it("confirms the exact accepted native incarnation", () => {
    expect(browserSessionsServerFrameSchema.safeParse(ACCEPTED).success).toBe(
      true,
    );
  });
});
