import {
  DEFAULT_ACCOUNT_HARNESS_PROFILES,
  useGuiHarnessCatalog,
} from "@/hooks/harnesses/use-gui-harness-catalog";
import { useHostCompatibility } from "@/lib/host";

/**
 * Renderer-side warmup for the GUI harness catalog. The host already
 * prewarms availability and provider servers; this keeps TanStack Query's
 * model catalog warm before the user opens a new-chat picker.
 *
 * The ONLY `"all-harnesses"` mount in the app: this is the app-load fill the
 * cache-only model contract leans on (see `use-gui-harness-catalog.ts`), and
 * it fans out on the app-wide DEFAULT host - the one whose provider servers
 * the host process prewarms anyway. Every user-facing surface reads
 * `"cached-only"` and warms specific harnesses on its own intent edges, so a
 * composer pinned to a cold remote host never spawns that host's entire
 * provider fleet just by opening a picker.
 */
export function HarnessCatalogPrefetcher() {
  const compatibility = useHostCompatibility();
  const active = compatibility.status === "compatible";
  useGuiHarnessCatalog(
    null,
    {
      enabled: active,
      subscribed: active,
      modelsFetch: "all-harnesses",
    },
    // The app-load fill runs before any profile is selected, and it is the one
    // fan-out allowed to spawn every provider: it warms the default account
    // and nothing else. A profile's slot is filled by the surface that browses
    // it (the picker's own per-harness query).
    DEFAULT_ACCOUNT_HARNESS_PROFILES,
  );
  return null;
}
