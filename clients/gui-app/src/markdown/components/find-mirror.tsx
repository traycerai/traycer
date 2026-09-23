import { FIND_MIRROR_ATTR } from "@/lib/find-engine/find-blocks";
import { normalizeSearchableText } from "@/lib/find-engine/searchable-text";

/**
 * The text a block was counted on by chat find, placed inside the block where
 * the find walk can reach it. Laid out but invisible (see `.tc-find-mirror`),
 * inert so assistive technology and the browser's own find never meet the
 * block's content twice. Carries the same whitespace shape the counter used,
 * so a query spanning a run of spaces in the source counts and paints alike.
 * See `find-blocks.ts` for the whole contract.
 */
export function FindMirror(props: { readonly text: string }) {
  const text = normalizeSearchableText(props.text);
  if (text.length === 0) return null;
  return (
    <span className="tc-find-mirror" inert {...{ [FIND_MIRROR_ATTR]: "" }}>
      {text}
    </span>
  );
}
