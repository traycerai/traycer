/** A list that renders every row: jsdom has no layout for a virtual one. */
import {
  createElement,
  Fragment,
  useImperativeHandle,
  type ReactNode,
  type Ref,
} from "react";

interface VirtuosoStandInProps {
  readonly id?: string;
  readonly role?: string;
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly data?: ReadonlyArray<unknown>;
  readonly totalCount?: number;
  readonly computeItemKey?: (index: number, item: undefined) => string | number;
  readonly itemContent?: (index: number, item: undefined) => ReactNode;
}

interface VirtuosoStandInHandle {
  readonly scrollIntoView: () => void;
  readonly scrollToIndex: () => void;
  readonly scrollBy: () => void;
  readonly scrollTo: () => void;
  readonly autoscrollToBottom: () => void;
  readonly getState: (callback: (state: null) => void) => void;
}

export function VirtuosoStandIn(
  props: VirtuosoStandInProps & {
    readonly ref: Ref<VirtuosoStandInHandle> | undefined;
  },
): ReactNode {
  const { ref, ...list } = props;
  useImperativeHandle(ref, () => ({
    autoscrollToBottom: () => undefined,
    getState: (callback) => {
      callback(null);
    },
    scrollBy: () => undefined,
    scrollIntoView: () => undefined,
    scrollTo: () => undefined,
    scrollToIndex: () => undefined,
  }));
  const total = list.totalCount ?? list.data?.length ?? 0;
  const rows = Array.from({ length: total }, (_unused, index) =>
    createElement(
      Fragment,
      { key: list.computeItemKey?.(index, undefined) ?? index },
      list.itemContent?.(index, undefined),
    ),
  );
  return createElement(
    "div",
    {
      id: list.id,
      role: list.role,
      "aria-label": list["aria-label"],
      className: list.className,
      "data-testid": "virtuoso-scroller",
    },
    ...rows,
  );
}
