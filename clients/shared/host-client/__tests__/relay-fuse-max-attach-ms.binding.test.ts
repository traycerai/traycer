import { describe, expect, it } from "vitest";
import { RELAY_FUSE_MAX_ATTACH_MS } from "../remote-fetcher";

/**
 * Cross-repo binding for the relay attach fuse (audit F23). `remote-fetcher.ts`
 * documents (lines 182-192) that `RELAY_FUSE_MAX_ATTACH_MS` mirrors the relay
 * worker's own hard cap because the OSS client cannot import worker code:
 * `workers/relay-do/src/config.ts` `MAX_REAUTH_INTERVAL_MS` (traycer-internal,
 * not in this repo). No import path bridges the two repos, so this is a
 * golden-value assertion, not a real binding — it exists so an edit to either
 * constant alone fails a test in that side's own CI, naming the other side.
 *
 * If this fails: `RELAY_FUSE_MAX_ATTACH_MS` changed here without updating
 * `MAX_REAUTH_INTERVAL_MS` in `workers/relay-do/src/config.ts` (traycer-internal
 * repo), or vice versa. Keep the two numerically identical.
 */
describe("RELAY_FUSE_MAX_ATTACH_MS — mirrors workers/relay-do's MAX_REAUTH_INTERVAL_MS", () => {
  it("stays at the relay worker's 4h hard cap", () => {
    expect(
      RELAY_FUSE_MAX_ATTACH_MS,
      "RELAY_FUSE_MAX_ATTACH_MS (clients/shared/host-client/remote-fetcher.ts) " +
        "diverged from the relay worker's MAX_REAUTH_INTERVAL_MS " +
        "(traycer-internal workers/relay-do/src/config.ts) — these two must be " +
        "kept numerically identical by hand.",
    ).toBe(4 * 60 * 60 * 1000);
  });
});
