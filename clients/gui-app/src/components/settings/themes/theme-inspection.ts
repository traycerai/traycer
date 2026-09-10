import { themeTokens, type ThemeToken } from "@/lib/themes/theme-definition";

interface Inspection {
  element: Element;
  token: ThemeToken;
}

function paints(element: Element): string {
  const style = getComputedStyle(element);
  const values = [
    style.backgroundColor,
    style.backgroundImage,
    style.boxShadow,
  ];
  for (const edge of ["top", "right", "bottom", "left"]) {
    if (
      style.getPropertyValue(`border-${edge}-style`) !== "none" &&
      Number.parseFloat(style.getPropertyValue(`border-${edge}-width`)) > 0
    )
      values.push(style.getPropertyValue(`border-${edge}-color`));
  }
  const hasText =
    element.matches("input,textarea,select") ||
    Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    );
  if (hasText)
    values.push(style.color, style.textShadow, style.textDecorationColor);
  if (element instanceof SVGElement) values.push(style.fill, style.stroke);
  if (element.matches("input,textarea")) values.push(style.caretColor);
  return values.join("|");
}

/** Probe real variable dependencies, including aliases and color-mix(), without painting a sentinel. */
export function findThemeTokenUsage(
  elements: Element[],
  tokens: readonly ThemeToken[],
): Inspection[] {
  const root = document.documentElement;
  const suppression = document.createElement("style");
  suppression.textContent =
    "html *,html *::before,html *::after{transition:none!important}";
  document.head.append(suppression);
  const matches: Inspection[] = [];
  try {
    const baseline = elements.map(paints);
    for (const token of tokens) {
      const variable = `--${token}`;
      const previous = root.style.getPropertyValue(variable);
      const priority = root.style.getPropertyPriority(variable);
      root.style.setProperty(
        variable,
        previous === "#01fea7" ? "#fe01a7" : "#01fea7",
        "important",
      );
      try {
        elements.forEach((element, index) => {
          if (paints(element) !== baseline[index])
            matches.push({ element, token });
        });
      } finally {
        if (previous) root.style.setProperty(variable, previous, priority);
        else root.style.removeProperty(variable);
      }
    }
  } finally {
    // Flush restored values before transitions can observe the temporary color.
    getComputedStyle(root).getPropertyValue("color");
    suppression.remove();
  }
  return matches;
}

export function inspectThemeElement(element: Element): Inspection | null {
  const elements: Element[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    elements.push(current);
    current = current.parentElement;
  }
  const matches = findThemeTokenUsage(
    elements,
    themeTokens.map((token) => token.key),
  );
  for (const candidate of elements) {
    const match = matches.find((entry) => entry.element === candidate);
    if (match) return match;
  }
  return null;
}
