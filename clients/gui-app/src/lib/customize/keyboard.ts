import { exitCustomize } from "@/lib/customize/enter-exit";
import { focusCustomizeInvoker } from "@/lib/customize/focus";
import { undo, redo } from "@/lib/customize/history";
import { useCustomizeStore } from "@/stores/customize/customize-store";

function escape(): void {
  const state = useCustomizeStore.getState();
  if (state.popoverKey) {
    state.closePopover();
    focusCustomizeInvoker();
  } else if (state.activeKey) {
    state.setActive(null);
    state.setSearch(state.search.query, -1);
  } else if (state.search.query) state.setSearch("", -1);
  else exitCustomize("escape");
}
function moveProxy(event: KeyboardEvent): boolean {
  const target = event.target;
  if (
    !(target instanceof HTMLButtonElement) ||
    !target.matches("[data-customize-proxy]")
  )
    return false;
  if (
    ![
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ].includes(event.key)
  )
    return false;
  const proxies = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-customize-proxy]"),
  );
  const index = proxies.indexOf(target);
  let next =
    (index +
      (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
      proxies.length) %
    proxies.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = proxies.length - 1;
  proxies[next]?.focus({ preventScroll: true });
  return true;
}
export function handleCustomizeKeydown(event: KeyboardEvent): void {
  if (!useCustomizeStore.getState().session) return;
  let handled = false;
  if (event.key === "Escape") {
    if (document.querySelector("[data-customize-dragging]")) return;
    if (
      document.querySelector(
        '[data-slot="dropdown-menu-content"][data-state="open"]',
      )
    )
      return;
    escape();
    handled = true;
  } else if (
    event.key.toLowerCase() === "z" &&
    (event.metaKey || event.ctrlKey)
  ) {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-customize-search]")
    )
      return;
    if (event.shiftKey) redo();
    else undo();
    handled = true;
  } else handled = moveProxy(event);
  if (handled) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
