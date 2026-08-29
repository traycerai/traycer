import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserCookieCryptoState } from "@traycer-clients/shared/platform/browser-view";

const OS_BACKED: BrowserCookieCryptoState = {
  mode: "real",
  persistence: "persistent",
  reason: "os-backed",
  storageBackend: null,
  encryptionAvailable: true,
};

const cryptoState = vi.hoisted(() => ({
  current: null as BrowserCookieCryptoState | null,
}));

const safeStorageCalls = vi.hoisted(() => ({ encrypt: 0, decrypt: 0 }));

vi.mock("electron", () => ({
  safeStorage: {
    encryptString: (plaintext: string): Buffer => {
      safeStorageCalls.encrypt += 1;
      return Buffer.from(`os-sealed:${plaintext}`, "utf8");
    },
    decryptString: (blob: Buffer): string => {
      safeStorageCalls.decrypt += 1;
      const text = blob.toString("utf8");
      if (!text.startsWith("os-sealed:")) {
        throw new Error("Error while decrypting the ciphertext provided");
      }
      return text.slice("os-sealed:".length);
    },
  },
}));

vi.mock("../browser-cookie-crypto", () => ({
  getBrowserCookieCryptoState: (): BrowserCookieCryptoState => {
    const state = cryptoState.current;
    if (state === null) throw new Error("crypto state not set by the test");
    return state;
  },
}));

type StoreKeyModule = typeof import("../browser-store-key");

async function loadModule(): Promise<StoreKeyModule> {
  return await import("../browser-store-key");
}

/** 32 zero bytes, exactly as the host mints and sends them. */
const RAW_KEY = Buffer.alloc(32).toString("base64");

beforeEach(() => {
  cryptoState.current = OS_BACKED;
  safeStorageCalls.encrypt = 0;
  safeStorageCalls.decrypt = 0;
  vi.resetModules();
});

describe("browser store key", () => {
  it("round-trips the host's key through the OS keystore", async () => {
    const { unwrapStoreKey, wrapStoreKey } = await loadModule();

    const wrapped = wrapStoreKey(RAW_KEY);

    // Base64 on the wire, and never the raw key itself.
    expect(wrapped).not.toBe(RAW_KEY);
    expect(Buffer.from(wrapped, "base64").toString("utf8")).toBe(
      `os-sealed:${RAW_KEY}`,
    );
    expect(unwrapStoreKey(wrapped)).toBe(RAW_KEY);
    expect(safeStorageCalls).toEqual({ encrypt: 1, decrypt: 1 });
  });

  it("refuses both directions when the keystore is not os-backed", async () => {
    const { BrowserStoreKeyUnavailableError, unwrapStoreKey, wrapStoreKey } =
      await loadModule();

    for (const state of [
      {
        ...OS_BACKED,
        mode: "degraded",
        persistence: "ephemeral",
        reason: "not-enabled",
        encryptionAvailable: false,
      },
      {
        ...OS_BACKED,
        mode: "degraded",
        persistence: "ephemeral",
        reason: "keychain-denied",
        encryptionAvailable: false,
      },
      {
        ...OS_BACKED,
        mode: "degraded",
        persistence: "ephemeral",
        reason: "linux-basic-text",
        storageBackend: "basic_text",
      },
      {
        ...OS_BACKED,
        mode: "degraded",
        persistence: "ephemeral",
        reason: "encryption-unavailable",
        encryptionAvailable: false,
      },
    ] satisfies BrowserCookieCryptoState[]) {
      cryptoState.current = state;

      expect(() => wrapStoreKey(RAW_KEY)).toThrow(
        BrowserStoreKeyUnavailableError,
      );
      expect(() => unwrapStoreKey("d3JhcHBlZA==")).toThrow(
        BrowserStoreKeyUnavailableError,
      );
      // The whole point: a refusal never reaches `safeStorage`, so it can
      // never be the thing that raises an OS prompt.
      expect(safeStorageCalls).toEqual({ encrypt: 0, decrypt: 0 });
    }
  });

  it("names the reason it refused", async () => {
    const { BrowserStoreKeyUnavailableError, wrapStoreKey } =
      await loadModule();
    cryptoState.current = {
      ...OS_BACKED,
      mode: "degraded",
      persistence: "ephemeral",
      reason: "keychain-denied",
      encryptionAvailable: false,
    };

    try {
      wrapStoreKey(RAW_KEY);
      expect.unreachable("wrapStoreKey should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserStoreKeyUnavailableError);
      if (error instanceof BrowserStoreKeyUnavailableError) {
        expect(error.reason).toBe("keychain-denied");
      }
    }
  });

  it("propagates a keystore that cannot open the blob", async () => {
    const { unwrapStoreKey } = await loadModule();

    expect(() =>
      unwrapStoreKey(Buffer.from("junk").toString("base64")),
    ).toThrow(/decrypting/);
  });
});
