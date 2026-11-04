import { useEffect, type RefObject } from "react";
import { CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS } from "@/components/chat/chat-navigation-highlight";
import { queryMountedChatMessageRoots } from "@/components/chat/chat-find-highlighter";
import { foldBotSearchText } from "@/lib/bots/bot-search-model";
import { RangeHighlighter } from "@/lib/find-engine/range-highlighter";
import { useBotSearchStore } from "@/stores/bots/bot-search-store";

/** Every place one of `words`, folded, stands in the text under `root`. */
function wordRanges(root: HTMLElement, words: readonly string[]): Range[] {
  const ranges: Range[] = [];
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = foldBotSearchText(node.nodeValue ?? "");
    for (const word of words) {
      for (
        let at = text.indexOf(word);
        at >= 0;
        at = text.indexOf(word, at + word.length)
      ) {
        const range = root.ownerDocument.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

/**
 * Marks a search result's words on its row with the find colours, for as
 * long as the row's landing ring lasts. The row may not be there yet (a jump
 * outside the loaded window hydrates around it) and may be drawn again, so
 * the marks follow what is mounted, and the time starts once they show.
 *
 * `rowId` is the row that renders the marked message, in this transcript;
 * `null` while it has none.
 */
export function useBotSearchWordMarks(
  transcript: RefObject<HTMLElement | null>,
  chatId: string,
  rowIdOf: (messageId: string) => string | null,
): void {
  const marks = useBotSearchStore((state) =>
    state.marks?.chatId === chatId ? state.marks : null,
  );
  const rowId = marks === null ? null : rowIdOf(marks.messageId);
  useEffect(() => {
    const root = transcript.current;
    if (marks === null || rowId === null || root === null) return undefined;
    const highlighter = new RangeHighlighter();
    let expiry: number | null = null;
    const paint = (): void => {
      const ranges = queryMountedChatMessageRoots(root, rowId).flatMap((row) =>
        wordRanges(row, marks.words),
      );
      highlighter.paintRanges(root, ranges, ranges.at(0) ?? null);
      if (ranges.length === 0 || expiry !== null) return;
      expiry = window.setTimeout(() => {
        useBotSearchStore.getState().clearMarks();
      }, CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS);
    };
    const observer = new MutationObserver(paint);
    observer.observe(root, { childList: true, subtree: true });
    paint();
    return () => {
      observer.disconnect();
      if (expiry !== null) window.clearTimeout(expiry);
      highlighter.dispose();
    };
  }, [marks, rowId, transcript]);
}
