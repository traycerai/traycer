import type { Environment } from "../runner/environment";
import type { ProgressInfo } from "../runner/output";
import { refreshDownloadSlotClaim } from "../registry";

// Extraction of a large archive can run for minutes with no bytes out; heartbeat so the caller does not treat silence as a hang.
const EXTRACT_HEARTBEAT_INTERVAL_MS = 2_000;

export function createExtractHeartbeat(opts: {
  readonly environment: Environment;
  readonly archivePath: string;
  readonly version: string;
  readonly onProgress: (info: ProgressInfo) => void;
}): () => void {
  let lastAtMs = 0;
  // Entries seen, not heartbeats sent.
  // Counted on EVERY call and reported on the throttled ones, so the number a consumer sees is real work completed rather than a count of how often we spoke - and it advances even while the throttle is suppressing output.
  let entriesSeen = 0;
  return () => {
    entriesSeen += 1;
    const nowMs = Date.now();
    if (nowMs - lastAtMs < EXTRACT_HEARTBEAT_INTERVAL_MS) return;
    lastAtMs = nowMs;
    opts.onProgress({
      stage: "extract",
      message: `extracting host ${opts.version}`,
      percent: null,
      bytes: null,
      totalBytes: null,
      // Entry-driven by construction - see this file's header.
      // The hook fires once per archive entry, so a rising count IS evidence of work completing.
      workUnits: entriesSeen,
    });
    void refreshDownloadSlotClaim(opts.environment, opts.archivePath).catch(
      () => undefined,
    );
  };
}
