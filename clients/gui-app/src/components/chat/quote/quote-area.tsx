import { use, type ReactNode, type RefObject } from "react";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { QuoteSelectionPopover } from "./quote-selection-popover";
import { QuoteSinkContext } from "./quote-sink-context";
import { useNativeQuoteRequest } from "./use-native-quote-request";
import { useQuoteSelection } from "./use-quote-selection";

/**
 * Select-to-quote over one region of a conversation (`containerRef`): the
 * floating Quote button above a selection inside it, and a native shell's
 * edit-menu "Quote" item for the same selection, the phone's path, where no
 * mouseup ever arms the button. Both put the quote where the surface's sink
 * (`QuoteSinkContext`) says, as a selection of the chat `chatId`.
 *
 * Nothing is offered while the setting is off, while the region is not
 * `active`, or under a surface with no sink: the hooks attach no listeners
 * then, so a disabled affordance costs nothing. The button is clipped to the
 * region, above the `bottomOverlayInsetPx` an overlay covers at its bottom.
 */
export function QuoteArea(props: {
  readonly chatId: string;
  readonly containerRef: RefObject<HTMLElement | null>;
  /** Whether the region is on screen and not under a system overlay. */
  readonly active: boolean;
  readonly bottomOverlayInsetPx: number;
  /** Called once a quote is placed, before its button is dismissed. */
  readonly onQuoted: () => void;
}): ReactNode {
  const { chatId, containerRef, active, bottomOverlayInsetPx, onQuoted } =
    props;
  const quoteReplyEnabled = useSettingsStore(
    (state) => state.quoteReplyEnabled,
  );
  const quoteSink = use(QuoteSinkContext);
  const enabled = quoteReplyEnabled && active && quoteSink !== null;
  const quoteSelection = useQuoteSelection({ containerRef, enabled });
  useNativeQuoteRequest({
    containerRef,
    enabled,
    onQuote: (snapshot) => {
      if (quoteSink === null) return;
      quoteSink(chatId, snapshot);
      onQuoted();
      quoteSelection.dismiss();
    },
  });
  if (quoteSink === null || quoteSelection.snapshot === null) return null;
  return (
    <QuoteSelectionPopover
      snapshot={quoteSelection.snapshot}
      onQuote={(snapshot) => quoteSink(chatId, snapshot)}
      onDismiss={quoteSelection.dismiss}
      onQuoted={onQuoted}
      boundaryRef={containerRef}
      bottomOverlayInsetPx={bottomOverlayInsetPx}
    />
  );
}
