import {
  useCallback,
  useRef,
  type ButtonHTMLAttributes,
  type Ref,
  type ChangeEvent,
} from "react";
import { Paperclip } from "lucide-react";
import { ToolbarIconButton } from "@/components/home/toolbar/toolbar-buttons";
import { isImageFile } from "@/hooks/composer/use-composer-paste";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRegionShown } from "@/lib/layout-overrides";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import { useComposerTileId } from "@/components/home/composer/composer-tile-hooks";

interface ComposerAttachImageButtonProps {
  readonly onAttachImages: (files: ReadonlyArray<File>) => void;
  readonly onAttachFiles: (files: ReadonlyArray<File>) => void;
}

/**
 * The composer's "Attach" control and the hidden file input it drives, as one
 * unit. Shared by the desktop toolbar's left group and the phone row.
 *
 * The input takes ANY file: an `accept` filter is what made iOS grey out
 * everything but photos under "Choose Files". A pick is split with the same
 * predicate paste and drop use, so images keep their own route unchanged and
 * everything else goes to the file route.
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
  const { onAttachImages, onAttachFiles } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const tileId = useComposerTileId();
  const { ref: hotspotRef, ghost } = useLayoutRegion({
    regionId: "attachImage",
    instanceId: tileId,
  });
  // A hidden control materialises while the editor points at it (L-14); the
  // button and its file input draw from props alone, so a preview starts
  // nothing.
  const shown = useRegionShown("attachImage") || ghost;

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
      const images = files.filter(isImageFile);
      const others = files.filter((file) => !isImageFile(file));
      if (images.length > 0) onAttachImages(images);
      if (others.length > 0) onAttachFiles(others);
    },
    [onAttachFiles, onAttachImages],
  );

  if (!shown) return null;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={handleImageChange}
      />
      <TooltipWrapper
        label="Attach"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <ComposerAttachImageTrigger
          ref={hotspotRef}
          onClick={handleOpenImagePicker}
        />
      </TooltipWrapper>
    </>
  );
}

export function ComposerAttachImageTrigger(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    ref?: Ref<HTMLButtonElement>;
  },
) {
  return (
    <ToolbarIconButton aria-label="Attach" {...props}>
      <Paperclip className="size-4" />
    </ToolbarIconButton>
  );
}
