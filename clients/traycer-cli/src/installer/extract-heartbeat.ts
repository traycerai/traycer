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
//
// Deliberately driven by entries rather than by a wall-clock interval, even
// though that leaves one gap: an archive whose payload is a single enormous
// member ticks once and then goes quiet until that member is written. The
// trade is what makes it the right default anyway - an entry tick is evidence
// of PROGRESS, while an interval only proves the process still exists, so an
// interval would keep Desktop's inactivity budget armed forever around an
// extract that is genuinely wedged on I/O. That budget is the only thing that
// ever catches a stuck extract.
//
// The residual risk is small and now cheap: crossing the 10-minute budget
// inside one member needs pathological I/O, and if it does happen the child
// is killed, the staging temp is swept, and the verified archive SURVIVES
// (download-stage.ts releases ownership rather than the file on a throw), so
// the retry re-extracts without re-downloading. Revisit if the host archive
// ever becomes a single-member archive.
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
