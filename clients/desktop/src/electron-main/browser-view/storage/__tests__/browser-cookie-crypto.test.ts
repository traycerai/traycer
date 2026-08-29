import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserCookieCryptoState,
  BrowserCookieStorageBackend,
  BrowserPersistenceDecision,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserPersistenceProbe } from "../browser-cookie-crypto";
import { createBrowserPersistenceDecisionStore } from "../browser-persistence-decision";

const safeStorageState = vi.hoisted(() => ({
  encryptionAvailable: true,
  storageBackend: "unknown" as BrowserCookieStorageBackend,
  probeCalls: 0,
}));

vi.mock("electron", () => ({
  app: {
    getPath: (_key: string): string => "/tmp/traycer-desktop-test",
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => {
      safeStorageState.probeCalls += 1;
      return safeStorageState.encryptionAvailable;
    },
    getSelectedStorageBackend: (): BrowserCookieStorageBackend =>
      safeStorageState.storageBackend,
  },
}));

vi.mock("../../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

type CryptoModule = typeof import("../browser-cookie-crypto");

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "traycer-crypto-"));
  safeStorageState.encryptionAvailable = true;
  safeStorageState.storageBackend = "unknown";
  safeStorageState.probeCalls = 0;
  vi.resetModules();
});

function decisionFilePath(): string {
  return join(directory, "browser-persistence.json");
}

async function seedDecision(
  decision: BrowserPersistenceDecision,
  storageBackend: BrowserCookieStorageBackend,
): Promise<void> {
  await createBrowserPersistenceDecisionStore(decisionFilePath()).write({
    decision,
    storageBackend,
  });
}

async function loadDecisionFile(): Promise<unknown> {
  return JSON.parse(await readFile(decisionFilePath(), "utf8"));
}

async function loadCryptoModule(
  platform: NodeJS.Platform | string,
): Promise<CryptoModule> {
  const mod: CryptoModule = await import("../browser-cookie-crypto");
  await mod.initBrowserPersistence({
    decisionFilePath: decisionFilePath(),
    platform,
  });
  return mod;
}

function summarize(state: BrowserCookieCryptoState) {
  return {
    mode: state.mode,
    persistence: state.persistence,
    reason: state.reason,
  };
}

const OK: BrowserPersistenceProbe = {
  encryptionAvailable: true,
  storageBackend: null,
};
const DENIED: BrowserPersistenceProbe = {
  encryptionAvailable: false,
  storageBackend: null,
};
const LIBSECRET: BrowserPersistenceProbe = {
  encryptionAvailable: true,
  storageBackend: "gnome_libsecret",
};
const BASIC_TEXT: BrowserPersistenceProbe = {
  encryptionAvailable: true,
  storageBackend: "basic_text",
};

const ENABLED: BrowserPersistenceDecision = { kind: "enabled", decidedAt: 1 };
const UNDECIDED: BrowserPersistenceDecision = { kind: "undecided" };
const DECLINED: BrowserPersistenceDecision = { kind: "declined", decidedAt: 1 };

interface ResolveCase {
  readonly name: string;
  readonly platform: NodeJS.Platform | string;
  readonly decision: BrowserPersistenceDecision;
  readonly probe: BrowserPersistenceProbe | null;
  readonly expected: {
    readonly mode: BrowserCookieCryptoState["mode"];
    readonly persistence: BrowserCookieCryptoState["persistence"];
    readonly reason: BrowserCookieCryptoState["reason"];
  };
}

const RESOLVE_CASES: readonly ResolveCase[] = [
  {
    name: "darwin / undecided / never probed",
    platform: "darwin",
    decision: UNDECIDED,
    probe: null,
    expected: {
      mode: "degraded",
      persistence: "ephemeral",
      reason: "not-enabled",
    },
  },
  {
    name: "darwin / declined / never probed",
    platform: "darwin",
    decision: DECLINED,
    probe: null,
    expected: {
      mode: "degraded",
      persistence: "ephemeral",
      reason: "not-enabled",
    },
  },
  {
    name: "darwin / enabled / probe ok",
    platform: "darwin",
    decision: ENABLED,
    probe: OK,
    expected: {
      mode: "real",
      persistence: "persistent",
      reason: "os-backed",
    },
  },
  {
    name: "darwin / enabled / probe denied",
    platform: "darwin",
    decision: ENABLED,
    probe: DENIED,
    expected: {
      mode: "degraded",
      persistence: "ephemeral",
      reason: "keychain-denied",
    },
  },
  {
    name: "darwin / undecided / probe ok (enable failed to persist)",
    platform: "darwin",
    decision: UNDECIDED,
    probe: OK,
    expected: {
      mode: "degraded",
      persistence: "ephemeral",
      reason: "not-enabled",
    },
  },
  {
    name: "win32 / enabled / probe ok",
    platform: "win32",
    decision: ENABLED,
    probe: OK,
    expected: {
      mode: "real",
      persistence: "persistent",
      reason: "os-backed",
    },
  },
  {
    name: "win32 / enabled / probe unavailable",
    platform: "win32",
    decision: ENABLED,
    probe: DENIED,
    expected: {
      mode: "degraded",
      persistence: "ephemeral",
      reason: "encryption-unavailable",
    },
  },
  {
    name: "linux / enabled / libsecret",
    platform: "linux",
    decision: ENABLED,
    probe: LIBSECRET,
    expected: {
      mode: "real",
      persistence: "persistent",
      reason: "os-backed",
    },
  },
  {
    // Decision #15: basic_text is degraded, never "basic persistence".
    name: "linux / enabled / basic_text",
    platform: "linux",
    decision: ENABLED,
    probe: BASIC_TEXT,
    expected: {
      mode: "degraded",
      persistence: "ephemeral",
      reason: "linux-basic-text",
    },
  },
  {
    name: "linux / enabled / no keyring",
    platform: "linux",
    decision: ENABLED,
    probe: DENIED,
    expected: {
      mode: "degraded",
      persistence: "ephemeral",
      reason: "encryption-unavailable",
    },
  },
];

describe("browser cookie crypto state resolution", () => {
  it.each(RESOLVE_CASES)("$name", async (testCase) => {
    const mod: CryptoModule = await import("../browser-cookie-crypto");
    expect(
      summarize(
        mod.resolveBrowserCookieCryptoStateFromInputs({
          platform: testCase.platform,
          decision: testCase.decision,
          probe: testCase.probe,
          recordedStorageBackend: null,
        }),
      ),
    ).toEqual(testCase.expected);
  });
});

describe("lazy browser persistence state machine", () => {
  it("never touches the keystore at boot while undecided", async () => {
    const mod = await loadCryptoModule("darwin");

    expect(safeStorageState.probeCalls).toBe(0);
    expect(summarize(mod.getBrowserCookieCryptoState())).toEqual({
      mode: "degraded",
      persistence: "ephemeral",
      reason: "not-enabled",
    });
    expect(mod.getBrowserPersistenceDecision()).toEqual({ kind: "undecided" });
  });

  it("never touches the keystore at boot after a decline", async () => {
    await seedDecision({ kind: "declined", decidedAt: 5 }, null);
    const mod = await loadCryptoModule("darwin");

    expect(safeStorageState.probeCalls).toBe(0);
    expect(mod.getBrowserCookieCryptoState().reason).toBe("not-enabled");
  });

  it("probes eagerly at boot once the user has consented", async () => {
    await seedDecision({ kind: "enabled", decidedAt: 5 }, null);
    const mod = await loadCryptoModule("darwin");

    expect(safeStorageState.probeCalls).toBe(1);
    expect(summarize(mod.getBrowserCookieCryptoState())).toEqual({
      mode: "real",
      persistence: "persistent",
      reason: "os-backed",
    });
  });

  it("promotes relaunch-pending to enabled when the post-restart probe succeeds", async () => {
    await seedDecision({ kind: "relaunch-pending", decidedAt: 5 }, null);
    const mod = await loadCryptoModule("darwin");

    expect(safeStorageState.probeCalls).toBe(1);
    expect(mod.getBrowserPersistenceDecision().kind).toBe("enabled");
    expect(mod.getBrowserCookieCryptoState().reason).toBe("os-backed");
    expect(await loadDecisionFile()).toMatchObject({
      decision: { kind: "enabled" },
    });
  });

  it("keeps relaunch-pending when the post-restart probe is denied again", async () => {
    safeStorageState.encryptionAvailable = false;
    await seedDecision({ kind: "relaunch-pending", decidedAt: 5 }, null);
    const mod = await loadCryptoModule("darwin");

    expect(mod.getBrowserPersistenceDecision().kind).toBe("relaunch-pending");
    expect(mod.getBrowserCookieCryptoState().reason).toBe("keychain-denied");
  });

  it("persists enabled and reports os-backed when enable succeeds", async () => {
    const mod = await loadCryptoModule("darwin");

    const state = await mod.enableBrowserPersistence();

    expect(safeStorageState.probeCalls).toBe(1);
    expect(summarize(state)).toEqual({
      mode: "real",
      persistence: "persistent",
      reason: "os-backed",
    });
    expect(await loadDecisionFile()).toMatchObject({
      decision: { kind: "enabled" },
      storageBackend: null,
    });
  });

  it("records the resolved Linux backend so the next run can auto-enable", async () => {
    safeStorageState.storageBackend = "gnome_libsecret";
    const mod = await loadCryptoModule("linux");

    await mod.enableBrowserPersistence();

    expect(await loadDecisionFile()).toMatchObject({
      decision: { kind: "enabled" },
      storageBackend: "gnome_libsecret",
    });
  });

  it("escalates a denial to relaunch-pending only on the second in-process failure", async () => {
    safeStorageState.encryptionAvailable = false;
    const mod = await loadCryptoModule("darwin");

    const first = await mod.enableBrowserPersistence();
    expect(summarize(first)).toEqual({
      mode: "degraded",
      persistence: "ephemeral",
      reason: "keychain-denied",
    });
    expect(mod.getBrowserPersistenceDecision().kind).toBe("undecided");

    const second = await mod.enableBrowserPersistence();
    expect(second.reason).toBe("keychain-denied");
    expect(mod.getBrowserPersistenceDecision().kind).toBe("relaunch-pending");
    expect(await loadDecisionFile()).toMatchObject({
      decision: { kind: "relaunch-pending" },
    });
  });

  it("counts a boot denial as the first failure, so one retry earns the relaunch", async () => {
    safeStorageState.encryptionAvailable = false;
    await seedDecision({ kind: "enabled", decidedAt: 5 }, null);
    const mod = await loadCryptoModule("darwin");

    await mod.enableBrowserPersistence();

    expect(mod.getBrowserPersistenceDecision().kind).toBe("relaunch-pending");
  });

  it("never escalates a Linux basic_text verdict to relaunch-pending", async () => {
    safeStorageState.storageBackend = "basic_text";
    const mod = await loadCryptoModule("linux");

    await mod.enableBrowserPersistence();
    const state = await mod.enableBrowserPersistence();

    expect(summarize(state)).toEqual({
      mode: "degraded",
      persistence: "ephemeral",
      reason: "linux-basic-text",
    });
    expect(mod.getBrowserPersistenceDecision().kind).toBe("undecided");
  });

  it("persists declined without probing", async () => {
    const mod = await loadCryptoModule("darwin");

    const state = await mod.declineBrowserPersistence();

    expect(safeStorageState.probeCalls).toBe(0);
    expect(state.reason).toBe("not-enabled");
    expect(await loadDecisionFile()).toMatchObject({
      decision: { kind: "declined" },
    });
  });

  it("auto-enables silently on Windows at first tile open", async () => {
    const mod = await loadCryptoModule("win32");

    expect(safeStorageState.probeCalls).toBe(0);
    const state = mod.ensureBrowserPersistenceForTileOpen();

    expect(safeStorageState.probeCalls).toBe(1);
    expect(summarize(state)).toEqual({
      mode: "real",
      persistence: "persistent",
      reason: "os-backed",
    });
    expect(mod.getBrowserPersistenceDecision().kind).toBe("enabled");
  });

  it("auto-enables on Linux only when a real backend was already recorded", async () => {
    await seedDecision({ kind: "undecided" }, "gnome_libsecret");
    safeStorageState.storageBackend = "gnome_libsecret";
    const mod = await loadCryptoModule("linux");

    expect(mod.ensureBrowserPersistenceForTileOpen().reason).toBe("os-backed");
  });

  it("treats an unknown Linux machine like macOS at first tile open", async () => {
    const mod = await loadCryptoModule("linux");

    const state = mod.ensureBrowserPersistenceForTileOpen();

    expect(safeStorageState.probeCalls).toBe(0);
    expect(summarize(state)).toEqual({
      mode: "degraded",
      persistence: "ephemeral",
      reason: "not-enabled",
    });
  });

  it("never auto-enables a Linux machine that last resolved basic_text", async () => {
    await seedDecision({ kind: "undecided" }, "basic_text");
    const mod = await loadCryptoModule("linux");

    expect(mod.ensureBrowserPersistenceForTileOpen().reason).toBe(
      "not-enabled",
    );
    expect(safeStorageState.probeCalls).toBe(0);
  });

  it("never auto-enables macOS at first tile open", async () => {
    const mod = await loadCryptoModule("darwin");

    expect(mod.ensureBrowserPersistenceForTileOpen().reason).toBe(
      "not-enabled",
    );
    expect(safeStorageState.probeCalls).toBe(0);
  });

  it("reports the decision alongside the crypto state", async () => {
    await seedDecision({ kind: "enabled", decidedAt: 9 }, null);
    const mod = await loadCryptoModule("darwin");

    expect(mod.getBrowserPersistenceState()).toEqual({
      decision: { kind: "enabled", decidedAt: 9 },
      cryptoState: mod.getBrowserCookieCryptoState(),
    });
  });
});
