import { stat } from "node:fs/promises";
import { isCredentialsReserveComplete } from "@traycer/protocol/config/credentials-reserve";
import { expect, vi } from "vitest";
import { createCliCredentialsStore } from "../../store/credentials-store";

/**
 * Leaves the credentials file's space reserve full and its lock free, for a
 * test that then runs under fake timers. A store that waits for the file's
 * lock polls on `setTimeout` and `Date.now`, which stand still under fake
 * timers; the only holder besides the stores' own operations is a store's
 * background fill of that reserve, and a full reserve is never refilled under
 * the lock. Run it under real timers, before `vi.useFakeTimers()`, with the
 * store already pointed at `credentialsPath`.
 */
export async function completeCredentialsReserve(
  credentialsPath: string,
): Promise<void> {
  const store = createCliCredentialsStore();
  try {
    await vi.waitFor(
      async () => {
        expect(await isCredentialsReserveComplete(credentialsPath)).toBe(true);
        await expect(stat(`${credentialsPath}.lock`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { timeout: 30_000, interval: 5 },
    );
  } finally {
    store.dispose();
  }
}
