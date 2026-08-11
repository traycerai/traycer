/**
 * Runtime watcher-error self-healing, driven by SYNTHETIC FSWatcher stream
 * errors (the FSEvents-reset class that cannot be provoked through the real
 * fs - and module-mocking `node:fs` does not reach the store's transitive
 * import under vitest, hence the injected `watchImpl` seam).
 *
 * Policy under test: an errored watcher is closed and reinstalled on a
 * DOUBLING backoff; the backoff resets only after a stable run
 * (WATCHER_STABILITY_MS) - construction success alone must not reset it, or
 * an install-ok/error-later FSEvents loop would hammer at the initial delay
 * forever.
 */
import { chmodSync, mkdtempSync, rmSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import { writeCredentialsFile } from "@traycer/protocol/config/credentials";
import type { TokenStoreChange } from "@traycer-clients/shared/platform/runner-host";
import { sandboxHome } from "../../__tests__/sandbox-home";
import { FileTokenStore } from "../file-token-store";

vi.mock("electron", () => ({
  app: {
    getPath: (): string =>
      join(tmpdir(), "traycer-file-token-store-watcher-userdata"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// A 0o000 directory still reads for root, so the read-fault retry case cannot
// be provoked there.
const canForceReadFailure =
  process.platform !== "win32" &&
  !(typeof process.getuid === "function" && process.getuid() === 0);

describe("FileTokenStore watcher self-healing (synthetic stream errors)", () => {
  let homeDir: string;
  const stores: FileTokenStore[] = [];
  const decoyDirs: string[] = [];

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "traycer-watcher-error-test-"));
    sandboxHome(homeDir);
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const store of stores) store.dispose();
    stores.length = 0;
    vi.useRealTimers();
    // A test may have left a directory unreadable to force a read fault.
    try {
      chmodSync(dirname(cliCredentialsPath("development")), 0o700);
    } catch {
      // never created - nothing to restore
    }
    rmSync(homeDir, { recursive: true, force: true });
    for (const dir of decoyDirs) rmSync(dir, { recursive: true, force: true });
    decoyDirs.length = 0;
  });

  it("closes into a doubling backoff while unstable, resetting only after a stable run", async () => {
    // Real watchers on the real sandbox dir; the injection only RECORDS them
    // so the test can drive the `error` event the OS will not produce on cue.
    const created: FSWatcher[] = [];
    const store = new FileTokenStore({
      environment: "development",
      authnBaseUrl: "http://authn.watcher-error.test",
      watchImpl: (dir, listener) => {
        const watcher = watch(dir, listener);
        created.push(watcher);
        return watcher;
      },
    });
    stores.push(store);
    expect(created).toHaveLength(1);

    // Stream error right after install: same incident, delay 1s (doubling arms).
    created[0].emit("error", new Error("stream reset"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(created).toHaveLength(2);

    // Instant failure again: the delay has doubled - 1s is no longer enough.
    created[1].emit("error", new Error("stream reset"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(created).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(created).toHaveLength(3);

    // A stable run, then an error: a FRESH incident - backoff resets, and the
    // reinstall lands after the initial 1s again.
    await vi.advanceTimersByTimeAsync(30_000);
    created[2].emit("error", new Error("stream reset"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(created).toHaveLength(4);
  });

  it("emits a catch-up change for a write that landed while the stream was down", async () => {
    const created: FSWatcher[] = [];
    const store = new FileTokenStore({
      environment: "development",
      authnBaseUrl: "http://authn.watcher-error.test",
      watchImpl: (dir, listener) => {
        const watcher = watch(dir, listener);
        created.push(watcher);
        return watcher;
      },
    });
    stores.push(store);
    const changes: TokenStoreChange[] = [];
    store.subscribe((change) => changes.push(change));

    // The stream dies: the watcher is closed, so the write below produces NO
    // filesystem event for this process.
    created[0].emit("error", new Error("stream reset"));
    await writeCredentialsFile(
      cliCredentialsPath("development"),
      {
        token: "written-while-blind",
        refreshToken: "rt",
        savedAt: new Date().toISOString(),
        user: { id: "u1", email: "a@x", name: "A" },
      },
      0,
    );
    expect(changes).toHaveLength(0);

    // Reinstall, then the debounced catch-up read: the missed write surfaces.
    // `waitFor` (not a bare advance) because the read itself is real async fs
    // I/O - fake timers fire the debounce but do not wait for the syscall.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(created).toHaveLength(2);
    await vi.waitFor(() => {
      expect(changes.at(-1)?.present).toBe(true);
    });
  });

  it.runIf(canForceReadFailure)(
    "retries the catch-up read until it succeeds - nothing else redelivers it",
    async () => {
      // Written BEFORE the store exists, so no watcher ever saw it land: the
      // catch-up read is the only thing that can surface it.
      const credsPath = cliCredentialsPath("development");
      await writeCredentialsFile(
        credsPath,
        {
          token: "written-while-blind",
          refreshToken: "rt",
          savedAt: new Date().toISOString(),
          user: { id: "u1", email: "a@x", name: "A" },
        },
        0,
      );

      // Watch a DECOY directory nothing ever touches. The store believes it
      // has a healthy watch, but no filesystem event for the credentials file
      // can ever be delivered - so the catch-up retry is the ONLY thing that
      // can surface the snapshot. (Watching the real dir made this vacuous:
      // the chmod that heals the read is itself an event in that dir, and it
      // delivered the change even with the retry deleted.)
      const decoyDir = mkdtempSync(join(tmpdir(), "traycer-watch-decoy-"));
      decoyDirs.push(decoyDir);
      const created: FSWatcher[] = [];
      const store = new FileTokenStore({
        environment: "development",
        authnBaseUrl: "http://authn.watcher-error.test",
        watchImpl: (_dir, listener) => {
          const watcher = watch(decoyDir, listener);
          created.push(watcher);
          return watcher;
        },
      });
      stores.push(store);
      const changes: TokenStoreChange[] = [];
      store.subscribe((change) => changes.push(change));

      // The FILE becomes unreadable: the reinstall still succeeds and
      // schedules its catch-up, but that read fails EACCES.
      created[0].emit("error", new Error("stream reset"));
      chmodSync(credsPath, 0o000);

      await vi.advanceTimersByTimeAsync(1_000); // reinstall + catch-up armed
      expect(created).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(100); // debounced read -> EACCES
      expect(changes).toHaveLength(0);

      // Heal it. The retry - not a filesystem event, there is none - is what
      // finally delivers the snapshot.
      chmodSync(credsPath, 0o600);
      await vi.advanceTimersByTimeAsync(1_000); // catch-up retry timer
      await vi.advanceTimersByTimeAsync(100); // its debounced read
      await vi.waitFor(() => {
        expect(changes.at(-1)?.present).toBe(true);
      });
    },
  );
});
