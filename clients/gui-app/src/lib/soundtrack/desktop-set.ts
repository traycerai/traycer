import { appLogger, describeLogError } from "@/lib/logger";
import { queryClient } from "@/lib/query-client";
import { soundtrackQueryKeys } from "@/lib/query-keys";
import type { DesktopSoundtrackBridge } from "./desktop-soundtrack-bridge";
import type { SoundtrackManifest } from "./manifest";
import { parseRemoteManifest } from "./remote-manifest";

/**
 * The team's set, with a fresh signed link in place of every sample. Null when
 * it cannot be had: main has logged why, or this logs what is wrong with the
 * manifest, which names no link.
 *
 * Reads that overlap share one. Any other read is a real one, because a session
 * asks again for links that stopped working, and its answer leaves the cache on
 * the next garbage-collection turn (`gcTime: 0` schedules it; nothing removes it
 * synchronously), because a link is a credential. A failed read is not repeated: the
 * caller already has what to do without it, and a malformed manifest would only
 * be malformed again.
 */
export async function readDesktopSet(
  bridge: DesktopSoundtrackBridge,
): Promise<SoundtrackManifest | null> {
  try {
    return await queryClient.fetchQuery({
      queryKey: soundtrackQueryKeys.teamSet(),
      queryFn: async () => {
        const result = await bridge.readSoundtrackSet();
        return result.kind === "ok"
          ? parseRemoteManifest(result.manifest)
          : null;
      },
      staleTime: 0,
      gcTime: 0,
      retry: false,
    });
  } catch (error) {
    appLogger.warn("[soundtrack] could not read the team's track set", {
      error: describeLogError(error),
    });
    return null;
  }
}
