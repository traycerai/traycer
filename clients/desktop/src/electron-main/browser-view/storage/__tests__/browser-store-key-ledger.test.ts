import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initBrowserSavedLogins,
  unwrapStoreKey,
  wrapStoreKey,
} from "../browser-saved-logins";
import {
  flushBrowserStoreKeyLedgerForTests,
  resetBrowserStoreKeyLedgerForTests,
} from "../browser-store-key-ledger";

/**
 * A stand-in for `safeStorage` that is reversible without being secret, so the
 * tests can tell "this desktop refused" from "the keystore failed": every
 * refusal below must happen with `decryptString` never reaching the keystore
 * at all, which is the whole point of the ledger - the oracle is the CALL, not
 * its answer.
 */
const keystore = vi.hoisted(() => ({
  available: true,
  backend: "gnome_libsecret",
  encrypt: vi.fn((value: string) => Buffer.from(`sealed:${value}`)),
  decrypt: vi.fn((blob: Buffer) => {
    const text = blob.toString("utf8");
    if (!text.startsWith("sealed:")) throw new Error("not ours");
    return text.slice("sealed:".length);
  }),
}));

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => keystore.available,
    getSelectedStorageBackend: () => keystore.backend,
    encryptString: (value: string) => keystore.encrypt(value),
    decryptString: (blob: Buffer) => keystore.decrypt(blob),
  },
}));

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

const USER_A = "user-a";
const USER_B = "user-b";
const RAW_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString(
  "base64",
);

describe("desktop store-key custody", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "store-key-ledger-"));
    keystore.available = true;
    keystore.backend = "gnome_libsecret";
    keystore.encrypt.mockClear();
    keystore.decrypt.mockClear();
    await initBrowserSavedLogins(join(directory, "browser-saved-logins.json"));
  });

  afterEach(async () => {
    // Settled, not polled: the wrap deliberately does not await its own
    // durable write, so a temp file would otherwise still be landing here.
    await flushBrowserStoreKeyLedgerForTests();
    resetBrowserStoreKeyLedgerForTests();
    await rm(directory, { recursive: true, force: true });
  });

  it("unwraps a blob it wrapped", async () => {
    const wrapped = wrapStoreKey(RAW_KEY, USER_A);
    if (wrapped === null) throw new Error("expected a wrap");

    expect(unwrapStoreKey(wrapped, USER_A)).toBe(RAW_KEY);
  });

  it("refuses a blob it did not wrap, without asking the keystore", async () => {
    // The refused input is a blob this stand-in COULD open. A desktop that
    // decrypts whatever an attached host names is a padding oracle against its
    // own cookie database (OSCrypt is AES-CBC, fixed IV, no MAC), and a forged
    // blob that decrypted would install a host-chosen store key. So the pin is
    // that the keystore is never reached, not that the answer was null.
    const foreign = Buffer.from("sealed:someone-elses-key").toString("base64");

    expect(unwrapStoreKey(foreign, USER_A)).toBeNull();
    expect(keystore.decrypt).not.toHaveBeenCalled();
  });

  it("refuses to wrap when the keystore does not encrypt", async () => {
    // Linux with no keyring: `safeStorage` silently falls back to `basic_text`,
    // which round-trips, so a wrap would SUCCEED and hand the host a blob
    // anyone holding the file can open. `null` leaves the host sealed, which is
    // the honest state for such a machine.
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    keystore.backend = "basic_text";
    try {
      expect(wrapStoreKey(RAW_KEY, USER_A)).toBeNull();
      expect(keystore.encrypt).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });

  it("keeps the ledger across a restart", async () => {
    const wrapped = wrapStoreKey(RAW_KEY, USER_A);
    if (wrapped === null) throw new Error("expected a wrap");
    await flushBrowserStoreKeyLedgerForTests();
    expect(
      await readFile(join(directory, "browser-store-key-ledger.json"), "utf8"),
    ).toContain("digests");

    // A fresh process: the durable ledger is the only thing that can still
    // recognise a blob this machine produced before the restart.
    resetBrowserStoreKeyLedgerForTests();
    await initBrowserSavedLogins(join(directory, "browser-saved-logins.json"));

    expect(unwrapStoreKey(wrapped, USER_A)).toBe(RAW_KEY);
  });

  it("bounds the ledger, keeping the newest 64 digests", async () => {
    // A file-size bound, not a machine count: this desktop wraps once per
    // (host, user) pair, and evicting a digest a host still holds costs that
    // host its encrypted slice on the next cold boot.
    const wrapped = Array.from({ length: 65 }, (_, index) =>
      wrapStoreKey(`${RAW_KEY}-${index}`, USER_A),
    );

    const [oldest, ...rest] = wrapped;
    if (oldest === undefined || oldest === null) {
      throw new Error("expected a wrap");
    }
    expect(unwrapStoreKey(oldest, USER_A)).toBeNull();
    for (const blob of rest) {
      if (blob === null) throw new Error("expected a wrap");
      expect(unwrapStoreKey(blob, USER_A)).not.toBeNull();
    }
  });

  it("refuses this machine's own blob when another account names it", async () => {
    // A store key is per USER. Without the account in the entry, one signed-in
    // account's host could name another account's blob and this machine would
    // open it - handing a slice of someone else's jar to a host that was never
    // given custody of it.
    const wrapped = wrapStoreKey(RAW_KEY, USER_A);
    if (wrapped === null) throw new Error("expected a wrap");
    keystore.decrypt.mockClear();

    expect(unwrapStoreKey(wrapped, USER_B)).toBeNull();
    expect(keystore.decrypt).not.toHaveBeenCalled();
    // ...and the rightful account is unaffected.
    expect(unwrapStoreKey(wrapped, USER_A)).toBe(RAW_KEY);
  });
});
