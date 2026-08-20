import type { AuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { appLogger, type AppLogValue } from "@/lib/logger";

/**
 * The app logger, in the shape the selection authority's kernel wants.
 *
 * Its own module because the kernel is constructed by the composition root
 * (`host-runtime-provider`) while the bridge that renders from it lives
 * elsewhere - and both would otherwise import a private of the other.
 */
export const selectionAuthorityLog: AuthorityLog = {
  debug: (message, detail) => {
    appLogger.debug(message, loggable(detail));
  },
  warn: (message, detail) => {
    appLogger.warn(message, loggable(detail));
  },
};

/**
 * The authority's log detail is `Record<string, unknown>`; the app logger
 * takes structured values. Anything outside that vocabulary is JSON-encoded
 * rather than dropped - a diagnostic that silently loses its subject is worse
 * than one that prints a shape. `JSON.stringify`, not `String(...)`: the
 * kernel's details are plain objects, which stringify to `[object Object]`
 * and would take the field's meaning with them.
 */
function loggable(
  detail: Record<string, unknown>,
): Record<string, AppLogValue> {
  const fields: Record<string, AppLogValue> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      fields[key] = value;
      continue;
    }
    fields[key] = describeLogValue(value);
  }
  return fields;
}

function describeLogValue(value: unknown): string {
  // Primitives are already handled by the caller, so what is left is an
  // object/array (encode it) or a type that has no useful log form at all
  // (name the type - a `[function]` in a diagnostic is a bug report, and
  // `JSON.stringify` would answer `undefined` for it).
  if (typeof value !== "object") {
    return `[${typeof value}]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "unserializable";
  }
}
