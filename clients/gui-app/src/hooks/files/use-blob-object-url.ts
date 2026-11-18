import { useEffect, useState } from "react";

interface HeldUrl {
  readonly blob: Blob;
  readonly url: string;
}

/**
 * An object URL for a Blob, or `null` until one has been made for THIS Blob.
 *
 * Made in a committed effect and revoked in that effect's cleanup, so every URL
 * this hook creates is revoked exactly once - including the one StrictMode's
 * throwaway first run makes. A render-time initializer would create a URL on
 * every render React discards, and nothing would ever revoke those.
 */
export function useBlobObjectUrl(blob: Blob): string | null {
  const [held, setHeld] = useState<HeldUrl | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    let live = true;
    // Published from a callback, like any value an effect subscribes to; a
    // cleanup that runs first (StrictMode's throwaway run) cancels it.
    queueMicrotask(() => {
      if (live) setHeld({ blob, url });
    });
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  // A URL made for a previous Blob is already revoked; never hand it out.
  return held !== null && held.blob === blob ? held.url : null;
}
