import { useCustomizeStore } from "@/stores/customize/customize-store";

export function findCustomizeProxy(key: string): HTMLButtonElement | null {
  return (
    Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-customize-proxy]"),
    ).find((node) => node.dataset.customizeProxy === key) ?? null
  );
}
export function focusCustomizeInvoker(): void {
  const { invoker } = useCustomizeStore.getState();
  let node: HTMLElement | null = null;
  if (invoker === "search")
    node = document.querySelector<HTMLInputElement>("[data-customize-search]");
  else if (invoker) node = findCustomizeProxy(invoker);
  (
    node ??
    document.querySelector<HTMLElement>(
      "[data-customize-proxy], [data-customize-search]",
    )
  )?.focus({ preventScroll: true });
}
