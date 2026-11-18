import { EventEmitter } from "node:events";
import type { Certificate, CertificatePrincipal } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionCertificateErrorChange } from "../../browser-view/browser-session";

type CertificateErrorListener = (
  event: { readonly preventDefault: () => void },
  webContents: { readonly id: number },
  url: string,
  error: string,
  certificate: Certificate,
  callback: (isTrusted: boolean) => void,
) => void;

const electronState = vi.hoisted(() => ({
  listeners: new Map<string, CertificateErrorListener>(),
}));

const storeState = vi.hoisted(() => ({
  payload: {
    entries: [] as Array<{
      readonly scope: "app-shell" | "browser";
      readonly fingerprint: string;
      readonly hostname: string;
      readonly subject: string;
      readonly issuer: string;
      readonly trustedAt: number;
    }>,
  },
  saveCalls: [] as Array<{
    readonly entries: Array<{
      readonly scope: "app-shell" | "browser";
      readonly fingerprint: string;
      readonly hostname: string;
      readonly subject: string;
      readonly issuer: string;
      readonly trustedAt: number;
    }>;
  }>,
}));

vi.mock("electron", () => ({
  app: {
    getPath: (): string => "/tmp/traycer-cert-test",
    on: (event: string, listener: CertificateErrorListener): void => {
      electronState.listeners.set(event, listener);
    },
  },
  dialog: {
    showCertificateTrustDialog: vi.fn(),
  },
}));

vi.mock("../logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../json-file-store", () => ({
  createJsonFileStore: () => ({
    load: async () => storeState.payload,
    save: async (payload: typeof storeState.payload) => {
      storeState.payload = payload;
      storeState.saveCalls.push(payload);
    },
  }),
}));

class FakeTrackedWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }

  once(event: "destroyed", listener: () => void): this {
    return super.once(event, listener);
  }
}

class FakeCertificate implements Certificate {
  data: string;
  fingerprint: string;
  issuer: CertificatePrincipal;
  issuerCert: Certificate = this;
  issuerName: string;
  serialNumber: string;
  subject: CertificatePrincipal;
  subjectName: string;
  validExpiry: number;
  validStart: number;

  constructor(data: string, commonName: string) {
    this.data = data;
    this.fingerprint = `test/${commonName}`;
    this.issuer = createPrincipal(commonName);
    this.issuerName = commonName;
    this.serialNumber = "01";
    this.subject = createPrincipal(commonName);
    this.subjectName = commonName;
    this.validExpiry = 4_102_444_800;
    this.validStart = 1_704_067_200;
  }
}

function createPrincipal(commonName: string): CertificatePrincipal {
  return {
    commonName,
    country: "",
    locality: "",
    organizations: [],
    organizationUnits: [],
    state: "",
  };
}

function readCertificateErrorListener(): CertificateErrorListener {
  const listener = electronState.listeners.get("certificate-error");
  if (listener === undefined) {
    throw new Error("certificate-error listener missing");
  }
  return listener;
}

async function flushCertificateHandler(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("certificate trust routing", () => {
  beforeEach(() => {
    vi.resetModules();
    electronState.listeners.clear();
    storeState.payload = { entries: [] };
    storeState.saveCalls = [];
    vi.clearAllMocks();
  });

  it("routes browser view certificate errors through browser pending UX before trust", async () => {
    const certTrust = await import("../cert-trust");
    const browserSession = await import("../../browser-view/browser-session");
    const webContents = new FakeTrackedWebContents(9);
    const browserPending: BrowserSessionCertificateErrorChange[] = [];
    const offBrowserPending = browserSession.onBrowserViewCertificateError(
      (change) => {
        browserPending.push(change);
      },
    );
    const certificate = new FakeCertificate(
      "fake-cert",
      "self-signed.localhost",
    );
    browserSession.registerBrowserViewWebContents(webContents);
    certTrust.installCertificateErrorHandler();
    const listener = readCertificateErrorListener();
    const preventDefault = vi.fn();
    let trusted = true;

    listener(
      { preventDefault },
      webContents,
      "https://self-signed.localhost/",
      "ERR_CERT_AUTHORITY_INVALID",
      certificate,
      (value) => {
        trusted = value;
      },
    );
    await flushCertificateHandler();

    expect(trusted).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(certTrust.listPendingCertificateErrors()).toEqual([]);
    expect(browserPending).toHaveLength(1);
    expect(browserPending[0]).toMatchObject({
      webContentsId: 9,
      hostname: "self-signed.localhost",
      error: "ERR_CERT_AUTHORITY_INVALID",
      subject: "self-signed.localhost",
      issuer: "self-signed.localhost",
    });

    await certTrust.trustBrowserCertificate(
      "self-signed.localhost",
      certificate,
    );
    const retryPreventDefault = vi.fn();
    trusted = false;

    listener(
      { preventDefault: retryPreventDefault },
      webContents,
      "https://self-signed.localhost/",
      "ERR_CERT_AUTHORITY_INVALID",
      certificate,
      (value) => {
        trusted = value;
      },
    );
    await flushCertificateHandler();

    expect(trusted).toBe(true);
    expect(retryPreventDefault).toHaveBeenCalledTimes(1);
    expect(storeState.saveCalls).toHaveLength(1);

    const appShellPreventDefault = vi.fn();
    trusted = true;
    listener(
      { preventDefault: appShellPreventDefault },
      { id: 77 },
      "https://self-signed.localhost/",
      "ERR_CERT_AUTHORITY_INVALID",
      certificate,
      (value) => {
        trusted = value;
      },
    );
    await flushCertificateHandler();

    expect(trusted).toBe(false);
    expect(appShellPreventDefault).not.toHaveBeenCalled();
    expect(certTrust.listPendingCertificateErrors()).toHaveLength(1);
    webContents.emit("destroyed");
    offBrowserPending();
  });

  it("does not let app-shell trust satisfy browser certificate errors", async () => {
    const certTrust = await import("../cert-trust");
    const browserSession = await import("../../browser-view/browser-session");
    const webContents = new FakeTrackedWebContents(12);
    const browserPending: BrowserSessionCertificateErrorChange[] = [];
    const offBrowserPending = browserSession.onBrowserViewCertificateError(
      (change) => {
        browserPending.push(change);
      },
    );
    const certificate = new FakeCertificate(
      "fake-cert",
      "self-signed.localhost",
    );

    await certTrust.trustCertificate("self-signed.localhost", certificate);
    browserSession.registerBrowserViewWebContents(webContents);
    certTrust.installCertificateErrorHandler();
    const listener = readCertificateErrorListener();
    const preventDefault = vi.fn();
    let trusted = true;

    listener(
      { preventDefault },
      webContents,
      "https://self-signed.localhost/",
      "ERR_CERT_AUTHORITY_INVALID",
      certificate,
      (value) => {
        trusted = value;
      },
    );
    await flushCertificateHandler();

    expect(trusted).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(browserPending).toHaveLength(1);
    expect(await certTrust.listTrustedCertificates()).toMatchObject([
      {
        scope: "app-shell",
        hostname: "self-signed.localhost",
      },
    ]);

    webContents.emit("destroyed");
    offBrowserPending();
  });

  it("lists and revokes browser-scope trust without touching app-shell trust", async () => {
    const certTrust = await import("../cert-trust");
    const appShellCert = new FakeCertificate("app-cert", "shell.localhost");
    const browserCert = new FakeCertificate("browser-cert", "site.localhost");

    await certTrust.trustCertificate("shell.localhost", appShellCert);
    await certTrust.trustBrowserCertificate("site.localhost", browserCert);

    expect(await certTrust.listTrustedCertificates()).toMatchObject([
      { scope: "app-shell", hostname: "shell.localhost" },
      { scope: "browser", hostname: "site.localhost" },
    ]);

    const browserEntry = (await certTrust.listTrustedCertificates()).find(
      (entry) => entry.scope === "browser",
    );
    if (browserEntry === undefined) throw new Error("browser entry missing");

    // Same fingerprint+hostname under the wrong scope must not revoke it.
    await certTrust.untrustCertificate(
      "app-shell",
      browserEntry.fingerprint,
      browserEntry.hostname,
    );
    expect(await certTrust.listTrustedCertificates()).toHaveLength(2);

    await certTrust.untrustCertificate(
      "browser",
      browserEntry.fingerprint,
      browserEntry.hostname,
    );
    expect(await certTrust.listTrustedCertificates()).toMatchObject([
      { scope: "app-shell", hostname: "shell.localhost" },
    ]);
  });
});
