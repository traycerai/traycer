import { useMemo } from "react";
import { useStableValue } from "@/hooks/ui/use-stable-value";
import {
  accumulatedChangeRowListsEqual,
  activeTurnChangeRows,
  mergeAccumulatedChangeRows,
  type AccumulatedChangeRow,
} from "@/lib/chat/accumulated-change-rows";
import type { ChatMessage } from "@/stores/composer/chat-store";

/**
 * The accumulated-changes panel's rows, with an identity that moves only when
 * a row does.
 *
 * The rendered messages take a new identity on every streamed flush, and the
 * active turn's rows are re-derived from them each time. Keyed on those
 * messages directly, a reasoning or text delta - which touches no file - handed
 * the panel a new list about thirty times a second, and every row of it
 * re-rendered, each re-sanitising its file icon: with 1,849 rows open the
 * renderer saturated and a streamed token took two seconds to reach the
 * screen. So the active turn's rows are held by value, and the merged list is
 * rebuilt only when they or the host's rows change.
 */
export function useAccumulatedChangeRows(
  messages: ReadonlyArray<ChatMessage>,
  fromHost: ReadonlyArray<AccumulatedChangeRow>,
  activeTurnId: string | null,
): ReadonlyArray<AccumulatedChangeRow> {
  const derivedActiveRows = useMemo(
    () => activeTurnChangeRows(messages, activeTurnId),
    [messages, activeTurnId],
  );
  const activeRows = useStableValue(
    derivedActiveRows,
    accumulatedChangeRowListsEqual,
  );
  return useMemo(
    () => mergeAccumulatedChangeRows(fromHost, activeRows),
    [fromHost, activeRows],
  );
}
