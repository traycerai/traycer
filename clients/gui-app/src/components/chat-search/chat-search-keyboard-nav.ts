import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type KeyboardEvent,
  type RefObject,
} from "react";

/**
 * Marks a result control (a row, an expand toggle, a show-more button) as a
 * stop for the dialog's arrow keys. The traversal order is the DOM order,
 * read fresh on each keystroke, so expanded rows and newly loaded pages join
 * it the moment they mount.
 */
const NAV_ATTRIBUTE = "data-chat-search-nav";

type NavKeyDown = (event: KeyboardEvent<HTMLElement>) => void;

const ChatSearchNavKeyDownContext = createContext<NavKeyDown | null>(null);

export const ChatSearchNavProvider = ChatSearchNavKeyDownContext.Provider;

/**
 * Props for a result control: the traversal marker, and the arrow-key handler
 * on the control itself - on the interactive element rather than on the list,
 * which is what `jsx-a11y/no-noninteractive-element-interactions` asks for
 * (the same shape as `use-history-list-keyboard-nav.ts`). Outside the panel
 * (a test rendering the result view alone) the handler is absent.
 */
export function useChatSearchNavProps(): {
  readonly [NAV_ATTRIBUTE]: "";
  readonly onKeyDown: NavKeyDown | undefined;
} {
  const onKeyDown = useContext(ChatSearchNavKeyDownContext);
  return useMemo(
    () => ({ [NAV_ATTRIBUTE]: "", onKeyDown: onKeyDown ?? undefined }),
    [onKeyDown],
  );
}

function navStops(scope: HTMLElement | null): ReadonlyArray<HTMLElement> {
  if (scope === null) return [];
  return Array.from(
    scope.querySelectorAll<HTMLElement>(`[${NAV_ATTRIBUTE}]`),
  ).filter((element) => !element.hasAttribute("disabled"));
}

/**
 * ArrowDown from the query input drops into the first result; ArrowUp/Down on
 * a result walks the results, and ArrowUp from the first returns to the input.
 */
export function useChatSearchKeyboardNav(
  inputRef: RefObject<HTMLInputElement | null>,
  scopeRef: RefObject<HTMLElement | null>,
): {
  readonly onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onResultKeyDown: NavKeyDown;
} {
  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "ArrowDown") return;
      const stops = navStops(scopeRef.current);
      if (stops.length === 0) return;
      event.preventDefault();
      stops[0].focus();
    },
    [scopeRef],
  );
  const onResultKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const stops = navStops(scopeRef.current);
      const index = stops.indexOf(event.currentTarget);
      if (index < 0) return;
      event.preventDefault();
      if (event.key === "ArrowUp" && index === 0) {
        inputRef.current?.focus();
        return;
      }
      const next =
        stops[
          event.key === "ArrowDown"
            ? Math.min(stops.length - 1, index + 1)
            : index - 1
        ];
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    },
    [inputRef, scopeRef],
  );
  return { onInputKeyDown, onResultKeyDown };
}
