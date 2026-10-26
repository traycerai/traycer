import {
  previewFeatureState,
  rawPreviewFeatures,
  readPreviewFeatures,
  type PreviewFeature,
  type PreviewFeatureState,
} from "@/lib/auth/preview-features";
import { useAuthUser } from "@/hooks/auth/use-auth-user-query";

/**
 * One preview feature's state for the signed-in person, from the user record
 * every client already reads. `unread` until that record has answered, and
 * while signed out; each caller decides what `unread` means at its own site.
 */
export function usePreviewFeature(
  feature: PreviewFeature,
): PreviewFeatureState {
  const { data } = useAuthUser();
  return previewFeatureState(
    data === undefined || data === null
      ? { kind: "unread" }
      : { kind: "read", verdict: readPreviewFeatures(rawPreviewFeatures(data)) },
    feature,
  );
}
