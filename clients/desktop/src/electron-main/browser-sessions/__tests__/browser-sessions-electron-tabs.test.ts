import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserCdpResult,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
  BrowserStorageState,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabStatusChange,
} from "@traycer-clients/shared/platform/browser-view";
import {
  createElectronTabs,
  type BrowserSessionsTabPort,
  type ElectronTabs,
} from "../browser-sessions-electron-tabs";
import { createTabRecorder } from "./browser-sessions-stream-fixture";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

type CreateElectronTabFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "createElectronTab" }
>;
type ReleaseElectronTabFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "releaseElectronTab" }
>;
type CdpRequestFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "cdpRequest" }
>;

const CREATE: CreateElectronTabFrame = {
  kind: "createElectronTab",
  hasBinaryPayload: false,
  requestId: "request-1",
  sessionId: "session-1",
  tabId: "tab-1",
  requestedUrl: "https://example.com/",
  reason: "agent-open",
  profile: "primary",
  seedStorageState: null,
};

function acceptedFrame(
  registrationId: string,
): Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "electronTabAccepted" }
> {
  return {
    kind: "electronTabAccepted",
    hasBinaryPayload: false,
    requestId: CREATE.requestId,
    sessionId: CREATE.sessionId,
    tabId: CREATE.tabId,
    registrationId,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const activeElectronTabs = new Set<ElectronTabs>();

interface Harness {
  readonly sent: BrowserSessionsClientFrame[];
  readonly bound: BrowserViewNativeTabCapability[];
  readonly released: BrowserViewNativeTabCapability[];
  readonly electronTabs: ElectronTabs;
}

function setup(
  tabs: BrowserSessionsTabPort,
  connectionId: () => string | null,
): Harness {
  const sent: BrowserSessionsClientFrame[] = [];
  const bound: BrowserViewNativeTabCapability[] = [];
  const released: BrowserViewNativeTabCapability[] = [];
  const electronTabs = createElectronTabs({
    hostId: "host-1",
    windowId: "window-1",
    tabs,
    connectionId,
    sendFrame: (frame) => sent.push(frame),
    onTabBound: (capability) => bound.push(capability),
    onTabReleased: (capability) => released.push(capability),
  });
  activeElectronTabs.add(electronTabs);
  return { sent, bound, released, electronTabs };
}

function provisionedFrames(
  sent: readonly BrowserSessionsClientFrame[],
): readonly BrowserSessionsClientFrame[] {
  return sent.filter((frame) => frame.kind === "electronTabProvisioned");
}

describe("createElectronTabs", () => {
  afterEach(() => {
    for (const tabs of activeElectronTabs) tabs.dispose();
    activeElectronTabs.clear();
  });

  it("reads connectionId at frame-arrival time, not at construction", async () => {
    const recorder = createTabRecorder();
    // Set to the PREVIOUS incarnation at construction and reconnected before
    // the frame arrives: a thunk captured at construction would price the
    // seed against a connection that has acked nothing.
    let connectionId: string | null = "stale-connection";
    const { sent, electronTabs } = setup(recorder.port, () => connectionId);
    connectionId = "connection-1";

    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(recorder.ensured).toEqual([
      {
        windowId: "window-1",
        input: {
          hostId: "host-1",
          sessionId: "session-1",
          tabId: "tab-1",
          requestedUrl: "https://example.com/",
          profile: "primary",
          seedStorageState: null,
          // The seed is a host->jar write, so main prices it against the
          // stream incarnation that sent it. Read at call time, not
          // captured at construction.
          connectionId: "connection-1",
        },
      },
    ]);
  });

  it("forwards a non-null seed verbatim to ensureTab", async () => {
    const recorder = createTabRecorder();
    const { sent, electronTabs } = setup(recorder.port, () => "connection-1");
    const seed: BrowserStorageState = {
      cookies: [
        {
          name: "session",
          value: "s3cret",
          domain: ".example.com",
          path: "/",
          expires: 4102444800,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          partitionKey: null,
        },
      ],
      origins: [],
    };

    electronTabs.handleFrame({ ...CREATE, seedStorageState: seed });
    await vi.waitFor(() => expect(recorder.ensured).toHaveLength(1));

    expect(recorder.ensured[0]?.input.seedStorageState).toBe(seed);
    expect(sent).toHaveLength(1);
  });

  it("ignores a duplicate create with identical content without creating or settling twice", async () => {
    const recorder = createTabRecorder();
    const { sent, electronTabs } = setup(recorder.port, () => "connection-1");

    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    electronTabs.handleFrame({ ...CREATE });
    await Promise.resolve();

    expect(recorder.ensured).toHaveLength(1);
    expect(sent.map((frame) => frame.kind)).toEqual(["electronTabProvisioned"]);
  });

  it("answers identity_violation for a duplicate requestId with different content", async () => {
    const recorder = createTabRecorder();
    const { sent, electronTabs } = setup(recorder.port, () => "connection-1");

    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    electronTabs.handleFrame({
      ...CREATE,
      requestedUrl: "https://example.com/other",
    });
    await Promise.resolve();

    expect(recorder.ensured).toHaveLength(1);
    expect(sent.at(-1)).toEqual({
      kind: "electronTabCreateFailed",
      hasBinaryPayload: false,
      requestId: "request-1",
      sessionId: "session-1",
      tabId: "tab-1",
      code: "identity_violation",
      message:
        "Electron tab identity violation for request request-1, session session-1, tab tab-1.",
    });
  });

  it("answers identity_violation for a second birth on the same tab key when the reason is not restore", async () => {
    const recorder = createTabRecorder();
    const { sent, electronTabs } = setup(recorder.port, () => "connection-1");

    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    electronTabs.handleFrame({
      ...CREATE,
      requestId: "request-2",
      reason: "agent-open",
    });
    await Promise.resolve();

    expect(recorder.ensured).toHaveLength(1);
    expect(sent.at(-1)).toEqual({
      kind: "electronTabCreateFailed",
      hasBinaryPayload: false,
      requestId: "request-2",
      sessionId: "session-1",
      tabId: "tab-1",
      code: "identity_violation",
      message:
        "Electron tab identity violation for request request-2, session session-1, tab tab-1.",
    });
  });

  it("reauthorizes a retained native tab through an explicit restore birth", async () => {
    const recorder = createTabRecorder();
    const { sent, electronTabs } = setup(recorder.port, () => "connection-1");

    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    electronTabs.handleFrame(acceptedFrame("registration-1"));
    sent.length = 0;

    electronTabs.handleFrame({
      ...CREATE,
      requestId: "request-restore",
      reason: "restore",
    });
    await vi.waitFor(() => expect(recorder.ensured).toHaveLength(2));

    expect(provisionedFrames(sent)).toContainEqual(
      expect.objectContaining({
        kind: "electronTabProvisioned",
        requestId: "request-restore",
        tabId: "tab-1",
        registrationId: "registration-2",
      }),
    );
    expect(
      sent.filter((frame) => frame.kind === "electronTabCreateFailed"),
    ).toEqual([]);
  });

  it("answers identity_violation when the provisioned native key doesn't match the birth", async () => {
    const tabs: BrowserSessionsTabPort = {
      ensureTab: () =>
        Promise.resolve({
          hostId: "host-1",
          sessionId: "session-mismatched",
          tabId: "tab-1",
          registrationId: "registration-1",
        }),
      acceptTab: () => Promise.resolve(),
      releaseTab: () => Promise.resolve(true),
      dispatchElectronTabCdp: () => Promise.reject(new Error("not used")),
      onNativeTabStatusChange: () => () => undefined,
    };
    const released: BrowserViewNativeTabCapability[] = [];
    const wrapped: BrowserSessionsTabPort = {
      ...tabs,
      releaseTab: (input) => {
        released.push(input);
        return Promise.resolve(true);
      },
    };
    const { sent, electronTabs } = setup(wrapped, () => "connection-1");

    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(released).toHaveLength(1));

    expect(released[0]).toEqual({
      hostId: "host-1",
      sessionId: "session-mismatched",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    expect(
      sent.filter((frame) => frame.kind === "electronTabProvisioned"),
    ).toEqual([]);
  });

  it("releases only the exact native incarnation and makes replay harmless", async () => {
    const recorder = createTabRecorder();
    const { electronTabs } = setup(recorder.port, () => "connection-1");
    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(recorder.ensured).toHaveLength(1));

    const staleRelease: ReleaseElectronTabFrame = {
      kind: "releaseElectronTab",
      hasBinaryPayload: false,
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-old",
    };
    electronTabs.handleFrame(staleRelease);
    await Promise.resolve();
    expect(recorder.released).toEqual([]);

    const release: ReleaseElectronTabFrame = {
      kind: "releaseElectronTab",
      hasBinaryPayload: false,
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    };
    electronTabs.handleFrame(release);
    await vi.waitFor(() => expect(recorder.released).toHaveLength(1));
    electronTabs.handleFrame(release);
    await Promise.resolve();

    expect(recorder.released).toEqual([
      {
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      },
    ]);
  });

  it("rolls back a provisioned native guest when its stream disappears before acceptance", async () => {
    const recorder = createTabRecorder();
    const { electronTabs } = setup(recorder.port, () => "connection-1");
    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(recorder.ensured).toHaveLength(1));

    electronTabs.disconnect();

    expect(recorder.released).toEqual([
      {
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
        registrationId: "registration-1",
      },
    ]);
  });

  it("preserves an accepted native tab when its coordinator is disposed", async () => {
    const recorder = createTabRecorder();
    const { sent, electronTabs } = setup(recorder.port, () => "connection-1");
    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    electronTabs.handleFrame(acceptedFrame("registration-1"));

    electronTabs.dispose();

    expect(recorder.released).toEqual([]);
  });

  it("rolls back a native birth that becomes provisioned after its stream closes", async () => {
    const ready = deferred<BrowserViewNativeTabCapability>();
    const released: BrowserViewNativeTabCapability[] = [];
    const tabs: BrowserSessionsTabPort = {
      ensureTab: () => ready.promise,
      acceptTab: () => Promise.resolve(),
      releaseTab: (input) => {
        released.push(input);
        return Promise.resolve(true);
      },
      dispatchElectronTabCdp: () => Promise.reject(new Error("not used")),
      onNativeTabStatusChange: () => () => undefined,
    };
    const { sent, electronTabs } = setup(tabs, () => "connection-1");
    electronTabs.handleFrame(CREATE);

    electronTabs.dispose();
    ready.resolve({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });

    await vi.waitFor(() => expect(released).toHaveLength(1));
    expect(sent).toEqual([]);
  });

  it("retires a pending birth before disconnect can block its replacement", async () => {
    const first = deferred<BrowserViewNativeTabCapability>();
    let ensureCalls = 0;
    const released: BrowserViewNativeTabCapability[] = [];
    const tabs: BrowserSessionsTabPort = {
      ensureTab: () => {
        ensureCalls += 1;
        if (ensureCalls === 1) return first.promise;
        return Promise.resolve({
          hostId: "host-1",
          sessionId: "session-1",
          tabId: "tab-1",
          registrationId: "registration-2",
        });
      },
      acceptTab: () => Promise.resolve(),
      releaseTab: (input) => {
        released.push(input);
        return Promise.resolve(true);
      },
      dispatchElectronTabCdp: () => Promise.reject(new Error("not used")),
      onNativeTabStatusChange: () => () => undefined,
    };
    const { sent, electronTabs } = setup(tabs, () => "connection-1");

    electronTabs.handleFrame(CREATE);
    electronTabs.disconnect();
    electronTabs.connect();
    electronTabs.handleFrame({
      ...CREATE,
      requestId: "request-restore",
      reason: "restore",
    });

    first.resolve({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    await vi.waitFor(() => {
      expect(ensureCalls).toBe(2);
      expect(sent).toContainEqual(
        expect.objectContaining({
          kind: "electronTabProvisioned",
          requestId: "request-restore",
          registrationId: "registration-2",
        }),
      );
      expect(released).toEqual([
        {
          hostId: "host-1",
          sessionId: "session-1",
          tabId: "tab-1",
          registrationId: "registration-1",
        },
      ]);
    });
  });

  it("does not report a late native rejection on a closed stream", async () => {
    const ready = deferred<BrowserViewNativeTabCapability>();
    const tabs: BrowserSessionsTabPort = {
      ensureTab: () => ready.promise,
      acceptTab: () => Promise.resolve(),
      releaseTab: () => Promise.resolve(true),
      dispatchElectronTabCdp: () => Promise.reject(new Error("not used")),
      onNativeTabStatusChange: () => () => undefined,
    };
    const { sent, electronTabs } = setup(tabs, () => "connection-1");
    electronTabs.handleFrame(CREATE);

    electronTabs.dispose();
    ready.reject(new Error("late failure"));
    await Promise.resolve();

    expect(sent).toEqual([]);
  });

  it("calls onTabBound only after acceptance and onTabReleased on exact release", async () => {
    const recorder = createTabRecorder();
    const { bound, released, electronTabs } = setup(
      recorder.port,
      () => "connection-1",
    );
    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(recorder.ensured).toHaveLength(1));

    expect(bound).toEqual([]);
    electronTabs.handleFrame(acceptedFrame("registration-1"));

    const capability: BrowserViewNativeTabCapability = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    };
    expect(bound).toEqual([capability]);

    electronTabs.handleFrame({
      kind: "releaseElectronTab",
      hasBinaryPayload: false,
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
    });
    await vi.waitFor(() => expect(recorder.released).toHaveLength(1));

    expect(released).toEqual([capability]);
  });

  it("routes Electron CDP by tab identity without requiring acceptance", async () => {
    const dispatched: Array<{
      readonly registrationId: string;
      readonly command: unknown;
    }> = [];
    const tabs: BrowserSessionsTabPort = {
      ensureTab: () =>
        Promise.resolve({
          hostId: "host-1",
          sessionId: "session-1",
          tabId: "tab-1",
          registrationId: "registration-1",
        }),
      acceptTab: () => Promise.resolve(),
      releaseTab: () => Promise.resolve(true),
      dispatchElectronTabCdp: (input) => {
        dispatched.push({
          registrationId: input.registrationId,
          command: input.command,
        });
        return Promise.resolve({
          kind: "cdpGetFrameTree",
          ok: true,
          frames: [],
        });
      },
      onNativeTabStatusChange: () => () => undefined,
    };
    const { sent, electronTabs } = setup(tabs, () => "connection-1");
    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    sent.length = 0;

    const cdp: CdpRequestFrame = {
      kind: "cdpRequest",
      hasBinaryPayload: false,
      requestId: "cdp-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      target: { kind: "root" },
      command: { kind: "cdpGetFrameTree" },
    };
    electronTabs.handleFrame(cdp);

    await vi.waitFor(() => {
      expect(dispatched).toEqual([
        {
          registrationId: "registration-1",
          command: { kind: "cdpGetFrameTree" },
        },
      ]);
      expect(sent).toEqual([
        {
          kind: "cdpResult",
          hasBinaryPayload: false,
          requestId: "cdp-1",
          result: { kind: "cdpGetFrameTree", ok: true, frames: [] },
        },
      ]);
    });
  });

  it("reports a mismatched Electron route as tab_not_found, never a tile error", () => {
    const recorder = createTabRecorder();
    const { sent, electronTabs } = setup(recorder.port, () => "connection-1");

    const cdp: CdpRequestFrame = {
      kind: "cdpRequest",
      hasBinaryPayload: false,
      requestId: "cdp-missing",
      tabId: "tab-missing",
      registrationId: "registration-missing",
      target: { kind: "root" },
      command: { kind: "cdpGetFrameTree" },
    };
    electronTabs.handleFrame(cdp);

    expect(recorder.cdp).toEqual([]);
    expect(sent).toEqual([
      {
        kind: "cdpResult",
        hasBinaryPayload: false,
        requestId: "cdp-missing",
        result: {
          kind: "cdpGetFrameTree",
          ok: false,
          error: {
            kind: "tab_not_found",
            message: "Electron tab incarnation is not active on this desktop.",
            code: null,
          },
        },
      },
    ]);
  });

  it("drops a CDP result that resolves after the connection generation has moved on", async () => {
    const dispatch = deferred<BrowserCdpResult>();
    const tabs: BrowserSessionsTabPort = {
      ensureTab: () =>
        Promise.resolve({
          hostId: "host-1",
          sessionId: "session-1",
          tabId: "tab-1",
          registrationId: "registration-1",
        }),
      acceptTab: () => Promise.resolve(),
      releaseTab: () => Promise.resolve(true),
      dispatchElectronTabCdp: () => dispatch.promise,
      onNativeTabStatusChange: () => () => undefined,
    };
    const { sent, electronTabs } = setup(tabs, () => "connection-1");
    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    electronTabs.handleFrame(acceptedFrame("registration-1"));
    sent.length = 0;

    const cdp: CdpRequestFrame = {
      kind: "cdpRequest",
      hasBinaryPayload: false,
      requestId: "cdp-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      target: { kind: "root" },
      command: { kind: "cdpGetFrameTree" },
    };
    electronTabs.handleFrame(cdp);

    // Bumps the connection generation without retiring the already-accepted
    // birth, so the dispatch in flight now belongs to an obsolete generation.
    electronTabs.disconnect();
    electronTabs.connect();

    dispatch.resolve({ kind: "cdpGetFrameTree", ok: true, frames: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toEqual([]);
  });

  it("buffers native status until acceptance, then emits the exact accepted incarnation's status", async () => {
    const recorder = createTabRecorder();
    const { sent, electronTabs } = setup(recorder.port, () => "connection-1");
    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    recorder.emitStatus({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      url: "https://example.com/intermediate",
      title: "Intermediate",
      status: "loading",
      reason: null,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
      viewed: false,
    });
    recorder.emitStatus({
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      registrationId: "registration-1",
      url: "https://example.com/accepted",
      title: "Accepted",
      status: "ready",
      reason: null,
      canGoBack: true,
      canGoForward: false,
      zoomPercent: 100,
      viewed: true,
    });

    expect(sent.filter((frame) => frame.kind === "electronTabState")).toEqual(
      [],
    );

    electronTabs.handleFrame(acceptedFrame("registration-1"));

    expect(sent.filter((frame) => frame.kind === "electronTabState")).toEqual([
      {
        kind: "electronTabState",
        hasBinaryPayload: false,
        registrationId: "registration-1",
        sessionId: "session-1",
        tabId: "tab-1",
        url: "https://example.com/accepted",
        title: "Accepted",
        status: "ready",
        viewed: true,
      },
    ]);
  });

  it("drops stale native status and forwards the exact accepted incarnation", async () => {
    const recorder = createTabRecorder();
    const { sent, electronTabs } = setup(recorder.port, () => "connection-1");
    electronTabs.handleFrame(CREATE);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    electronTabs.handleFrame(acceptedFrame("registration-1"));
    sent.length = 0;

    const statusFields = {
      hostId: "host-1",
      sessionId: "session-1",
      tabId: "tab-1",
      url: "https://example.com/next",
      title: "Next",
      status: "ready",
      reason: null,
      canGoBack: true,
      canGoForward: false,
      zoomPercent: 100,
      viewed: false,
    } as const;
    recorder.emitStatus({
      ...statusFields,
      registrationId: "registration-stale",
    });
    expect(sent).toEqual([]);

    recorder.emitStatus({
      ...statusFields,
      registrationId: "registration-1",
      viewed: true,
    });
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "electronTabState",
        registrationId: "registration-1",
        viewed: true,
      }),
    ]);
  });
});
