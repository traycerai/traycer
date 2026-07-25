import type { Environment } from "../runner/environment";
import type { ProgressInfo } from "../runner/output";
import { refreshDownloadSlotClaim } from "../registry";

// Extraction of a ~800MB archive can run for minutes while producing no
// output of its own. Two independent mechanisms read that silence as death:
// Desktop SIGKILLs a CLI whose NDJSON stream goes quiet (`host-controller.ts`'s
// idle budget), and the download cache lets another process take over a slot
// whose archive has stopped being touched - extraction only READS the archive,
// so its mtime stops advancing the moment the transfer ends.
//
// One heartbeat answers both: emit a progress event AND stamp the ownership
// marker. Throttled, because the underlying hook fires once per archive entry.
const EXTRACT_HEARTBEAT_INTERVAL_MS = 2_000;

export function createExtractHeartbeat(opts: {
  readonly environment: Environment;
  readonly archivePath: string;
  readonly version: string;
  readonly onProgress: (info: ProgressInfo) => void;
}): () => void {
  let lastAtMs = 0;
  return () => {
    const nowMs = Date.now();
    if (nowMs - lastAtMs < EXTRACT_HEARTBEAT_INTERVAL_MS) return;
    lastAtMs = nowMs;
    opts.onProgress({
      stage: "extract",
      message: `extracting host ${opts.version}`,
      percent: null,
      bytes: null,
      totalBytes: null,
    });
    void refreshDownloadSlotClaim(opts.environment, opts.archivePath).catch(
      () => undefined,
    );
  };
}
