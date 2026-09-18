import { useEffect, useRef } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { registerReleasableImageContentSource } from "@/lib/composer/landing-image-budget";

/**
 * ROOTS THE IMAGES IN A DOCUMENT HELD BY A COMPONENT, for as long as that
 * component holds it.
 *
 * Every other holder of hash-only content in this renderer is a store, and a
 * store roots its own hashes from module scope because it outlives everything.
 * Two holders are not: an open inline edit (the chat tile's own reducer state)
 * and a pending steer-conflict confirm (the composer hook's `useState`). Both
 * can hold a freshly pasted image that exists NOWHERE else - the inline editor
 * writes to no draft store until Submit - while an unrelated draft clear
 * schedules the reconcile that releases unrooted bytes and then deletes them.
 * The picture stays on screen and its bytes are gone underneath it.
 *
 * Registered once per mount and released on unmount, with the document read
 * LAZILY through a ref: the content changes on every keystroke, and
 * re-registering per keystroke would churn the root list for no gain. The ref
 * is seeded with the first value, so there is no window on mount where the
 * reader would see `null`.
 *
 * `null` content is a live registration contributing nothing - correct for a
 * holder that is mounted but currently empty, and it keeps the hook
 * unconditional at the call site.
 *
 * Registered as a CONTENT source, not a root source: the document carries
 * `size` on each node, so these images are priced into the byte budget as well
 * as rooted. A composer that rooted without pricing is what let sequential
 * pastes each see an empty store (W-6).
 */
export function useImageContentRoot(content: JsonContent | null): void {
  const contentRef = useRef<JsonContent | null>(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);
  useEffect(
    () =>
      registerReleasableImageContentSource({
        contents: () => {
          const held = contentRef.current;
          return held === null ? [] : [held];
        },
      }),
    [],
  );
}
