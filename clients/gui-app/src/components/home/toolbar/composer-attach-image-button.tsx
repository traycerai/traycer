import { useCallback, useRef, type ChangeEvent } from "react";
import { ImagePlus } from "lucide-react";
import { ToolbarIconButton } from "@/components/home/toolbar/toolbar-buttons";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useLayoutStore } from "@/stores/settings/layout-store";

interface ComposerAttachImageButtonProps {
  readonly onAttachImages: (files: ReadonlyArray<File>) => void;
}

/**
 * The composer's "Attach image" control and the hidden file input it drives,
 * as one unit. Shared by the desktop toolbar's left group and the phone row.
 *
 * The value reset happens twice on purpose - once before opening the picker and
 * once after reading the selection - so re-picking the same file still fires a
 * `change` event. Keeping both halves here means neither caller can copy one
 * and forget the other.
 *
 * Layout ▸ Composer can remove the control, and the whole unit goes with it -
 * the file input exists only to be driven by this button. Attaching itself is
 * untouched: `onAttachImages` is the same callback the composer's paste and
 * drag-drop handlers call, and neither passes through here.
 */
export function ComposerAttachImageButton(
  props: ComposerAttachImageButtonProps,
) {
  const { onAttachImages } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const attachImage = useLayoutStore((state) => state.composer.attachImage);

  const handleOpenImagePicker = useCallback(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.value = "";
    input.click();
  }, []);

  const handleImageChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (files.length === 0) return;
      onAttachImages(files);
    },
    [onAttachImages],
  );

  if (attachImage === "hidden") return null;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={handleImageChange}
      />
      <TooltipWrapper
        label="Attach image"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <ToolbarIconButton
          aria-label="Attach image"
          onClick={handleOpenImagePicker}
        >
          <ImagePlus className="size-4" />
        </ToolbarIconButton>
      </TooltipWrapper>
    </>
  );
}
