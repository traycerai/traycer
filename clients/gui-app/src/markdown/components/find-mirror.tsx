import { FIND_MIRROR_ATTR } from "@/lib/find-engine/find-blocks";

/**
 * The text a block was counted on by chat find, placed inside the block where
 * the find walk can reach it. Laid out but invisible (see `.tc-find-mirror`),
 * inert so assistive technology and the browser's own find never meet the
 * block's content twice. See `find-blocks.ts` for the whole contract.
 */
export function FindMirror(props: { readonly text: string }) {
  if (props.text.length === 0) return null;
  return (
    <span className="tc-find-mirror" inert {...{ [FIND_MIRROR_ATTR]: "" }}>
      {props.text}
    </span>
  );
}
