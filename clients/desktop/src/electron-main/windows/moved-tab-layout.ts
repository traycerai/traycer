import type { JsonValue } from "../../ipc-contracts/window-types";

function isRecord(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

/** Keep personal appearance when the existing single-tab move seeds a new window. */
export function movedTabLayout(
  source: JsonValue | null | undefined,
  kind: "epic" | "draft",
  id: string,
): JsonValue | null {
  if (!isRecord(source) || !isRecord(source.customizations)) return null;
  const key = `${kind}:${id}`;
  const customization = source.customizations[key];
  if (!isRecord(customization)) return null;
  const groupId = customization.groupId;
  const group =
    typeof groupId === "string" && isRecord(source.groups)
      ? source.groups[groupId]
      : undefined;
  const itemId = `tab:${key}`;
  return {
    version: 2,
    items: [{ kind: "tab", id: itemId, ref: { kind, id } }],
    activeItemId: itemId,
    activationHistory: [{ kind, id }],
    systemTabs: { history: null, settings: null },
    customizations: { [key]: customization },
    groups:
      typeof groupId === "string" && isRecord(group)
        ? { [groupId]: group }
        : {},
  };
}
