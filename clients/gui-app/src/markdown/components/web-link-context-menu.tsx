import { use, type PointerEvent, type ReactElement } from "react";
import { Copy, ExternalLink, Globe2 } from "lucide-react";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { NESTED_CONTEXT_MENU_PROPS } from "@/lib/dom/nested-context-menu";
import { useOpenLinkIn, type LinkDestination } from "@/lib/links/open-link";
import { MarkdownLinkContext } from "@/markdown/links/markdown-link-context";

// The menu closing is the feedback for Copy Link, so the copied flag this
// hook keeps is never read; it still needs a reset window.
const COPY_FEEDBACK_RESET_MS = 2000;

interface WebLinkContextMenuProps {
  /** The link's parsed http(s) URL. */
  readonly url: string;
  /**
   * The rendered anchor. Exactly ONE element: the trigger merges its handlers
   * onto it through Radix's `Slot`.
   */
  readonly children: ReactElement;
}

/**
 * The right-click menu on a web link in rendered markdown. A plain click
 * follows the per-kind link setting; this menu lets the user pick the
 * destination for one link without changing that setting, and replaces the
 * OS menu that offered only "Copy Link".
 */
export function WebLinkContextMenu(props: WebLinkContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        ref={standDownForWiderSelection}
        onPointerDown={skipLongPressForWiderSelection}
        {...NESTED_CONTEXT_MENU_PROPS}
      >
        {props.children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <WebLinkContextMenuItems url={props.url} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A drag selection that runs past the link is about the selection, not the
 * link, so the OS menu's Copy is the right answer. Stopping the press in the
 * capture phase keeps it from React - the trigger never opens and never
 * default-prevents - which leaves Chromium free to show that menu.
 *
 * A selection inside the link (macOS selects the word under a right-click)
 * still opens this menu.
 */
function standDownForWiderSelection(
  node: HTMLElement | null,
): (() => void) | undefined {
  if (node === null) return undefined;
  const standDown = (event: Event): void => {
    if (selectionReachesPast(node)) event.stopPropagation();
  };
  node.addEventListener("contextmenu", standDown, true);
  return () => {
    node.removeEventListener("contextmenu", standDown, true);
  };
}

/**
 * The same rule on the touch path: a touch or pen press arms Radix's 700 ms
 * long-press opener on `pointerdown`, before any `contextmenu`. Default-
 * preventing it makes Radix skip arming the timer, so a wider selection keeps
 * the OS's own selection menu there too.
 */
function skipLongPressForWiderSelection(event: PointerEvent<HTMLElement>) {
  if (
    event.pointerType !== "mouse" &&
    selectionReachesPast(event.currentTarget)
  ) {
    event.preventDefault();
  }
}

function selectionReachesPast(link: HTMLElement): boolean {
  const selection = link.ownerDocument.getSelection();
  if (selection === null || selection.isCollapsed) return false;
  return Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index),
  ).some(
    (range) =>
      range.intersectsNode(link) &&
      !(
        link.contains(range.startContainer) && link.contains(range.endContainer)
      ),
  );
}

// Mounted only while the menu is open, so a transcript full of links does not
// carry an opener and a clipboard hook per anchor.
function WebLinkContextMenuItems(props: { readonly url: string }) {
  const linkPolicy = use(MarkdownLinkContext);
  const { openLinkIn, canOpenInApp } = useOpenLinkIn();
  const openIn = (destination: LinkDestination): void => {
    // As on a plain click: opening a web link supersedes a file link that is
    // still resolving, so a slow artifact lookup cannot land over this page.
    linkPolicy?.supersedePendingFileLink();
    openLinkIn(props.url, destination);
  };
  const { copy } = useClipboardCopy({
    resetMs: COPY_FEEDBACK_RESET_MS,
    onSuccess: null,
    onError: () => {
      toast.error("Couldn't copy link");
    },
  });

  return (
    <>
      {canOpenInApp ? (
        <ContextMenuItem onSelect={() => openIn("in-app")}>
          <Globe2 className="size-3.5" aria-hidden />
          <span>Open in Browser</span>
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onSelect={() => openIn("external")}>
        <ExternalLink className="size-3.5" aria-hidden />
        <span>Open in External Browser</span>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => copy(props.url)}>
        <Copy className="size-3.5" aria-hidden />
        <span>Copy Link</span>
      </ContextMenuItem>
    </>
  );
}
