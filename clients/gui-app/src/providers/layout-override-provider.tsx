import { use, useMemo, type ReactNode } from "react";
import {
  LayoutOverrideContext,
  mergeOverrides,
  type LayoutOverride,
} from "@/lib/layout-overrides";

/**
 * Draws this subtree under different layout preferences than the store holds -
 * how a Customize popover shows what an option WOULD look like, using the real
 * component rather than a second, drifting copy of it.
 *
 * Nests: an inner provider wins LEAF BY LEAF over the one around it, so an
 * option picture inside a preset thumbnail inherits the preset's values and
 * restates only the one it is about.
 *
 * Read `lib/layout-overrides.ts` before wrapping anything - what may be wrapped
 * is a VISUAL LEAF, and the passivity contract (D11) and the ancestor seams an
 * override cannot reach are both written down there.
 */
export function LayoutOverrideProvider(props: {
  readonly value: LayoutOverride;
  readonly children: ReactNode;
}): ReactNode {
  const parent = use(LayoutOverrideContext);
  const merged = useMemo(
    () => mergeOverrides(parent, props.value),
    [parent, props.value],
  );
  return (
    <LayoutOverrideContext.Provider value={merged}>
      {props.children}
    </LayoutOverrideContext.Provider>
  );
}
