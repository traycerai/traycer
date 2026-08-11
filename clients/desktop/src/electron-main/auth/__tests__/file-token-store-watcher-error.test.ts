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
import { mkdtempSync, rmSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("FileTokenStore watcher self-healing (synthetic stream errors)", () => {
  let homeDir: string;
  const stores: FileTokenStore[] = [];

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "traycer-watcher-error-test-"));
    sandboxHome(homeDir);
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const store of stores) store.dispose();
    stores.length = 0;
    vi.useRealTimers();
    rmSync(homeDir, { recursive: true, force: true });
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
});
