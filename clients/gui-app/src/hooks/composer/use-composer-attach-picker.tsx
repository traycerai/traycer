import { useCallback, useRef, type ChangeEvent, type ReactNode } from "react";
import { isImageFile } from "@/hooks/composer/use-composer-paste";

/**
 * The hidden file input behind an Attach control and the function that opens
 * it: the task composer's control, and a bot's message box, which is no
 * Layout region.
 *
 * A pick is split with the same predicate paste and drop use, so images keep
 * their own route and everything else goes to the file route. `accept` is
 * the platform picker's filter; whatever it lets through still meets the
 * surface's own refusals.
 *
 * The value reset happens twice on purpose - once before opening the picker and
 * once after reading the selection - so re-picking the same file still fires a
 * `change` event. Keeping both halves here means no caller can copy one and
 * forget the other.
 */
export function useComposerAttachPicker(options: {
  readonly accept: string | undefined;
  readonly onAttachImages: (files: ReadonlyArray<File>) => void;
  readonly onAttachFiles: (files: ReadonlyArray<File>) => void;
}): { readonly input: ReactNode; readonly open: () => void } {
  const { accept, onAttachImages, onAttachFiles } = options;
  const inputRef = useRef<HTMLInputElement>(null);

  const open = useCallback(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.value = "";
    input.click();
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (files.length === 0) return;
      const images = files.filter(isImageFile);
      const others = files.filter((file) => !isImageFile(file));
      if (images.length > 0) onAttachImages(images);
      if (others.length > 0) onAttachFiles(others);
    },
    [onAttachFiles, onAttachImages],
  );

  return {
    input: (
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={handleChange}
      />
    ),
    open,
  };
}
