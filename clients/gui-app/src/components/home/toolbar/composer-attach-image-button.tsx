import { type ButtonHTMLAttributes, type Ref } from "react";
import { Paperclip } from "lucide-react";
import { ToolbarIconButton } from "@/components/home/toolbar/toolbar-buttons";
import { useComposerAttachPicker } from "@/hooks/composer/use-composer-attach-picker";
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
 * everything but photos under "Choose Files".
 *
 * Layout ▸ Composer can remove the control, and the whole unit goes with it -
 * the file input exists only to be driven by this button. Attaching itself is
 * untouched: `onAttachImages` is the same callback the composer's paste and
 * drag-drop handlers call, and neither passes through here.
 */
export function ComposerAttachImageButton(
  props: ComposerAttachImageButtonProps,
) {
  const tileId = useComposerTileId();
  const { ref: hotspotRef, ghost } = useLayoutRegion({
    regionId: "attachImage",
    instanceId: tileId,
  });
  // A hidden control materialises while the editor points at it (L-14); the
  // button and its file input draw from props alone, so a preview starts
  // nothing.
  const shown = useRegionShown("attachImage") || ghost;
  const picker = useComposerAttachPicker({
    accept: undefined,
    onAttachImages: props.onAttachImages,
    onAttachFiles: props.onAttachFiles,
  });

  if (!shown) return null;

  return (
    <>
      {picker.input}
      <TooltipWrapper
        label="Attach"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <ComposerAttachImageTrigger ref={hotspotRef} onClick={picker.open} />
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
