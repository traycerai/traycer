import { useCallback, useEffect, useRef, useState } from "react";
import { appLogger } from "@/lib/logger";

interface UseClipboardCopyOptions {
  resetMs: number;
  onSuccess: (() => void) | null;
  onError: (() => void) | null;
}

interface UseClipboardCopy {
  copied: boolean;
  copy: (value: string) => void;
  copyWith: (write: () => Promise<void>) => void;
}

export function useClipboardCopy(
  options: UseClipboardCopyOptions,
): UseClipboardCopy {
  const { resetMs, onSuccess, onError } = options;
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  const copyWith = useCallback(
    (write: () => Promise<void>) => {
      let writePromise: Promise<void>;
      try {
        writePromise = write();
      } catch (error) {
        appLogger.error(
          "[clipboard] copy action threw synchronously",
          {},
          error,
        );
        setCopied(false);
        if (onError !== null) onError();
        return;
      }
      writePromise.then(
        () => {
          setCopied(true);
          window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setCopied(false), resetMs);
          if (onSuccess !== null) onSuccess();
        },
        (error: unknown) => {
          appLogger.error("[clipboard] copy action failed", {}, error);
          setCopied(false);
          if (onError !== null) onError();
        },
      );
    },
    [resetMs, onSuccess, onError],
  );

  const copy = useCallback(
    (value: string) => {
      // `navigator.clipboard` is absent in insecure contexts; reading
      // `.writeText` then throws synchronously. Catch that boundary and
      // a rejected write alike - both route to `onError`.
      copyWith(() => navigator.clipboard.writeText(value));
    },
    [copyWith],
  );

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return { copied, copy, copyWith };
}
