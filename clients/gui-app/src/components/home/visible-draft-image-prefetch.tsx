import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  collectImageAtoms,
  hashOnlyImageHashes,
} from "@/lib/composer/image-atoms";
import { LANDING_IMAGE_MAX_BYTES_PER_IMAGE } from "@/lib/composer/landing-image-budget";
import { hasLandingImageBytes } from "@/lib/composer/landing-image-store";
import {
  cloudDraftImageSourceVersion,
  prefetchRecordedCloudDraftImages,
  subscribeCloudDraftImageSources,
} from "@/lib/drafts/cloud-draft-image-recovery";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { getRetentionProfile } from "@/stores/replica-memory/retention-profile";

interface PlannedImage {
  readonly hash: string;
  readonly bytes: number;
}

const subscribeDocumentVisibility = (listener: () => void): (() => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const documentVisible = (): boolean => document.visibilityState === "visible";
const serverDocumentVisible = (): boolean => false;

function plannedImages(content: JsonContent): ReadonlyArray<PlannedImage> {
  const declared = new Map(
    collectImageAtoms(content)
      .filter((atom) => atom.hash !== null)
      .map((atom) => [atom.hash, atom.size] as const),
  );
  let remaining = getRetentionProfile().visibleDraftImagePrefetchBytes;
  const selected: PlannedImage[] = [];
  for (const hash of hashOnlyImageHashes(content)) {
    // Bytes this partition already holds cost no transfer, so they must not
    // spend the allowance a missing image needs.
    if (hasLandingImageBytes(hash)) continue;
    const claimedSize = declared.get(hash);
    const size =
      claimedSize !== undefined && claimedSize !== null && claimedSize > 0
        ? claimedSize
        : LANDING_IMAGE_MAX_BYTES_PER_IMAGE;
    if (size <= 0 || size > remaining) continue;
    remaining -= size;
    selected.push({ hash, bytes: size });
  }
  return selected;
}

/** Only a focused, painted draft may spend its profile's idle byte allowance. */
export function VisibleDraftImagePrefetch(props: {
  readonly content: JsonContent | null;
  readonly active: boolean;
}): null {
  const sourceVersion = useSyncExternalStore(
    subscribeCloudDraftImageSources,
    cloudDraftImageSourceVersion,
    cloudDraftImageSourceVersion,
  );
  const visible = useSyncExternalStore(
    subscribeDocumentVisibility,
    documentVisible,
    serverDocumentVisible,
  );
  const plan = useMemo(
    () => (props.content === null ? [] : plannedImages(props.content)),
    [props.content],
  );

  useEffect(() => {
    if (!props.active || plan.length === 0 || !visible) {
      return;
    }
    let cancelled = false;
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    let secondFrameId: number | null = null;
    const controller = new AbortController();
    const stopWhenHidden = (): void => {
      if (!documentVisible()) controller.abort();
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    const start = (): void => {
      if (cancelled || !documentVisible()) return;
      void prefetchRecordedCloudDraftImages(plan, controller.signal).catch(
        () => undefined,
      );
    };
    // Two animation frames put even WebKit's timer fallback after the first
    // painted frame. requestIdleCallback, where present, defers further.
    const afterPaint = (): void => {
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(start, { timeout: 2_000 });
      } else {
        timeoutId = window.setTimeout(start, 0);
      }
    };
    const hasAnimationFrame =
      typeof window.requestAnimationFrame === "function";
    const frameId = hasAnimationFrame
      ? window.requestAnimationFrame(() => {
          secondFrameId = window.requestAnimationFrame(afterPaint);
        })
      : window.setTimeout(afterPaint, 0);
    return () => {
      cancelled = true;
      controller.abort();
      document.removeEventListener("visibilitychange", stopWhenHidden);
      if (hasAnimationFrame) window.cancelAnimationFrame(frameId);
      else window.clearTimeout(frameId);
      if (secondFrameId !== null) window.cancelAnimationFrame(secondFrameId);
      if (idleId !== null) window.cancelIdleCallback(idleId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [plan, props.active, sourceVersion, visible]);
  return null;
}

/** Isolate content changes from the landing shell's expensive layout tree. */
export function LandingVisibleDraftImagePrefetch(props: {
  readonly draftId: string | null;
  readonly active: boolean;
}): ReactNode {
  const content = useLandingDraftStore(
    (state) =>
      state.drafts.find((draft) => draft.id === props.draftId)?.content ?? null,
  );
  return <VisibleDraftImagePrefetch content={content} active={props.active} />;
}
