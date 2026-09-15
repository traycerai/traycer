import { boundedString } from "../guards";
import { ELEMENT_PICKER_LIMITS } from "./browser-element-picker-script";

/**
 * What framework component an annotated element belongs to, and where that
 * component is written.
 *
 * ## Why this is worth capturing
 *
 * A selector and a computed-style list say what the element IS; neither says
 * what a developer has to EDIT. `div > div:nth-of-type(2) > button` is a
 * faithful description of a button and a useless instruction, because the file
 * that produced it is named nowhere in it. The component name and its source
 * line are the two facts that turn a marked pixel into a place in the codebase.
 *
 * ## Why it reads private framework state
 *
 * There is no standard for this: every framework keeps its component graph on
 * the DOM node under its own key, and none of them is public API. So every read
 * here is defensive by construction - unknown shapes, getters that throw, and
 * a production build that stripped the metadata all have to be ordinary
 * outcomes rather than errors, because they are the common case. A miss returns
 * `null` and the capture is exactly as good as it was before.
 *
 * ## What it deliberately does NOT collect
 *
 * Props, state, and hook values. They are the obvious next field and they are
 * page CONTENT - a form's typed value, a token in a context provider - which
 * `browserViewElementCaptureSchema` documents as having been deliberately
 * removed from this payload once already. A component name and a file path are
 * facts about the SOURCE, which is the thing the agent is being pointed at.
 */
export interface BrowserElementComponentHint {
  /** Nearest component display name, e.g. `SubmitButton`. */
  readonly componentName: string | null;
  /** Where that component is written, when the framework recorded it. */
  readonly sourceFile: string | null;
  readonly sourceLine: number | null;
}

const EMPTY_COMPONENT_HINT: BrowserElementComponentHint = {
  componentName: null,
  sourceFile: null,
  sourceLine: null,
};

/**
 * How far up the DOM to look for an owning component.
 *
 * A marked element is often a leaf a component rendered rather than the
 * component's own root, so stopping at the element itself misses most of the
 * useful answers. The walk is bounded because a deep tree would otherwise pay
 * a full ancestor scan per marked element, and because a component fifteen
 * levels above a button is not the one that owns it in any useful sense.
 */
const COMPONENT_HINT_MAX_DEPTH = 12;

/** Names that identify a wrapper rather than the component a developer edits. */
const UNINFORMATIVE_COMPONENT_NAMES = new Set<string>([
  "Anonymous",
  "Fragment",
  "ForwardRef",
  "Memo",
  "Provider",
  "Consumer",
  "Suspense",
  "StrictMode",
  "Unknown",
  "",
]);

export function readComponentHint(
  element: Element,
): BrowserElementComponentHint {
  let node: Element | null = element;
  let depth = 0;
  while (node !== null && depth < COMPONENT_HINT_MAX_DEPTH) {
    const hint = readNodeComponentHint(node);
    if (hint !== null) return hint;
    node = node.parentElement;
    depth += 1;
  }
  return EMPTY_COMPONENT_HINT;
}

function readNodeComponentHint(
  node: Element,
): BrowserElementComponentHint | null {
  return (
    readSvelteHint(node) ?? readVueHint(node) ?? readReactHint(node) ?? null
  );
}

/**
 * Svelte is read first because it is the only one that records a file and line
 * without a debug build: `__svelte_meta.loc` is emitted by the compiler.
 */
function readSvelteHint(node: Element): BrowserElementComponentHint | null {
  const meta = propertyOf(node, "__svelte_meta");
  const loc = isRecordValue(meta) ? propertyOf(meta, "loc") : undefined;
  if (!isRecordValue(loc)) return null;
  const file = stringValue(propertyOf(loc, "file"));
  if (file === null) return null;
  return {
    componentName: componentNameFromPath(file),
    sourceFile: boundedPath(file),
    sourceLine: lineValue(propertyOf(loc, "line")),
  };
}

function readVueHint(node: Element): BrowserElementComponentHint | null {
  const instance = propertyOf(node, "__vueParentComponent");
  const type = isRecordValue(instance)
    ? propertyOf(instance, "type")
    : undefined;
  if (!isRecordValue(type)) return null;
  // `__name` is what the SFC compiler infers from the filename; `name` is an
  // explicit declaration and wins where both exist.
  const name =
    stringValue(propertyOf(type, "name")) ??
    stringValue(propertyOf(type, "__name"));
  const file = stringValue(propertyOf(type, "__file"));
  if (name === null && file === null) return null;
  return {
    componentName: usefulName(name ?? componentNameFromPath(file ?? "")),
    sourceFile: file === null ? null : boundedPath(file),
    sourceLine: null,
  };
}

/**
 * React keeps its fiber under a per-instance key, so the key itself has to be
 * discovered. From the fiber, `_debugOwner` walks the OWNER chain - the
 * component that rendered this element - which is the question being asked;
 * `return` would walk the host tree instead and answer with whatever DOM
 * happened to be above it.
 */
function readReactHint(node: Element): BrowserElementComponentHint | null {
  const fiber = readReactFiber(node);
  if (fiber === null) return null;
  let owner: unknown = fiber;
  let depth = 0;
  while (isRecordValue(owner) && depth < COMPONENT_HINT_MAX_DEPTH) {
    const name = usefulName(reactFiberName(owner));
    if (name !== null) {
      const source = reactFiberSource(owner);
      return {
        componentName: name,
        sourceFile: source?.file ?? null,
        sourceLine: source?.line ?? null,
      };
    }
    owner = propertyOf(owner, "_debugOwner");
    depth += 1;
  }
  return null;
}

function readReactFiber(node: Element): Record<string, unknown> | null {
  let keys: string[] = [];
  try {
    keys = Object.keys(node);
  } catch {
    return null;
  }
  for (const key of keys) {
    if (
      !key.startsWith("__reactFiber$") &&
      !key.startsWith("__reactInternalInstance$")
    ) {
      continue;
    }
    const fiber = propertyOf(node, key);
    if (isRecordValue(fiber)) return fiber;
  }
  return null;
}

function reactFiberName(fiber: Record<string, unknown>): string | null {
  const type = propertyOf(fiber, "elementType") ?? propertyOf(fiber, "type");
  // A component is a FUNCTION, and `typeof function` is not `"object"`, so the
  // record guard cannot be reused here - reading its name through the same
  // guarded accessor is what keeps a page-defined getter from escaping.
  if (typeof type === "function") {
    return (
      stringValue(propertyOf(type, "displayName")) ??
      stringValue(propertyOf(type, "name"))
    );
  }
  // `React.memo` and `forwardRef` wrap the component in an object whose own
  // name is the wrapper's, so the inner render function is the useful one.
  if (isRecordValue(type)) {
    const display = stringValue(propertyOf(type, "displayName"));
    if (display !== null) return display;
    const inner = propertyOf(type, "render") ?? propertyOf(type, "type");
    if (typeof inner === "function") {
      return (
        stringValue(propertyOf(inner, "displayName")) ??
        stringValue(propertyOf(inner, "name"))
      );
    }
  }
  return null;
}

function reactFiberSource(
  fiber: Record<string, unknown>,
): { readonly file: string; readonly line: number | null } | null {
  const source = propertyOf(fiber, "_debugSource");
  if (!isRecordValue(source)) return null;
  const file = stringValue(propertyOf(source, "fileName"));
  if (file === null) return null;
  return {
    file: boundedPath(file),
    line: lineValue(propertyOf(source, "lineNumber")),
  };
}

function componentNameFromPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop();
  if (base === undefined) return null;
  const stem = base.replace(/\.[a-z0-9]+$/i, "");
  return usefulName(stem);
}

function usefulName(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.trim();
  if (UNINFORMATIVE_COMPONENT_NAMES.has(trimmed)) return null;
  // A lowercase first letter is a host element (`div`) rather than a component,
  // which the tag name already reports.
  if (trimmed.length === 0 || trimmed[0] !== trimmed[0]?.toUpperCase()) {
    return null;
  }
  return boundedString(trimmed, ELEMENT_PICKER_LIMITS.componentName, "");
}

function boundedPath(file: string): string {
  return boundedString(file, ELEMENT_PICKER_LIMITS.sourceFile, "");
}

function lineValue(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || value < 1) return null;
  return Math.floor(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Reads one property without letting a getter's throw escape. Framework state
 * is full of accessors, and a page can define its own on these very keys.
 */
function propertyOf(target: object, key: string): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return undefined;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
