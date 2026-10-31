import { useMemo } from "react";
import {
  buildFallbackProfileLabels,
  resolveFallbackProfileLabel,
} from "@/components/chat/fallback/fallback-identity";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";

/**
 * Names a managed profile for the Fallback settings panel.
 *
 * Takes a NON-NULL id, unlike the chat surfaces' resolver. There, `null` is a
 * terminal agent's tuple and is named "Terminal account"; here it means the
 * preview has no particular account to report, and the panel omits the clause
 * entirely rather than naming one. Same wire field, different question - which
 * is why this is a narrower signature rather than a reuse of the other.
 */
export type FallbackSettingsProfileLabel = (profileId: string) => string;

/**
 * The preview's account labels, resolved from the read this panel already makes.
 *
 * D190: the per-row preview used to print `preview.profileId` straight into the
 * sentence, so a row read "resolves to gpt-5.6-sol on 3f2a9c1e-…". That is the
 * defect D118 fixed host-side, reappearing on the one surface whose whole job is
 * to tell the user what a row will do.
 *
 * The RULE is not restated here - `buildFallbackProfileLabels` and
 * `resolveFallbackProfileLabel` are the same ones the chat cards use, including
 * the duplicate-label disambiguation and the short-prefix degradation for an id
 * that cannot be resolved. A second implementation would be a second way to name
 * one account, and a second truncation of one id reads as two accounts.
 *
 * `useProvidersList()` is the app-wide wrapper, which is the correct one INSIDE
 * Settings: the panel re-provides `HostRuntimeContext` with the scoped client,
 * so this resolves the profiles of the host whose policy is being edited. It is
 * also the read the profile-step hint already takes, and both share one cache
 * entry, so this adds no request.
 */
export function useFallbackSettingsProfileLabels(): FallbackSettingsProfileLabel {
  const providers = useProvidersList({ enabled: true, subscribed: true });
  const data = providers.data;
  const byId = useMemo(
    () =>
      data === undefined
        ? new Map<string, string>()
        : buildFallbackProfileLabels(data.providers),
    [data],
  );
  return useMemo(
    () =>
      (profileId: string): string =>
        resolveFallbackProfileLabel(byId, profileId),
    [byId],
  );
}
