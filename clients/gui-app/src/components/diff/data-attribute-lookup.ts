export function queryElementByDataAttribute(args: {
  readonly root: ParentNode;
  readonly attributeName: string;
  readonly value: string;
}): HTMLElement | null {
  return queryElementsByDataAttribute(args).at(0) ?? null;
}

export function queryElementsByDataAttribute(args: {
  readonly root: ParentNode;
  readonly attributeName: string;
  readonly value: string;
}): ReadonlyArray<HTMLElement> {
  return Array.from(
    args.root.querySelectorAll<HTMLElement>(`[${args.attributeName}]`),
  ).filter(
    (element) =>
      element instanceof HTMLElement &&
      element.getAttribute(args.attributeName) === args.value,
  );
}
