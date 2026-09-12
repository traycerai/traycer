import { isRecord } from "../guards";

/**
 * The interactive shape of a page, for an agent that has to act on it.
 *
 * ## Why the accessibility tree rather than the DOM
 *
 * An agent asked to "click Save" needs to know what is clickable and what it is
 * called. The DOM answers neither directly: a button can be a `div` with a click
 * handler, its label can be an `aria-label`, an `alt`, a `title`, or the text of
 * an element referenced by `aria-labelledby`, and its visibility depends on
 * computed style. The accessibility tree is Chromium's own answer to exactly that
 * question, computed with all of those rules already applied - so it is both more
 * accurate than a DOM walk and far smaller than one.
 *
 * ## Why it carries no values
 *
 * Nodes report their ROLE and their NAME, never their value. A text input's value
 * is what the user typed - a password, an address, a token pasted into a form -
 * and this snapshot is built to be put in front of a model. The same reasoning
 * removed markup and attributes from the annotation capture; a name and a role
 * are what an agent needs to aim at a control, and a value is what it needs to be
 * told, not what it should read over the user's shoulder.
 */
export interface BrowserAccessibilityNode {
  /** ARIA role, e.g. `button`. */
  readonly role: string;
  /** Accessible name, computed by Chromium. Empty when the node has none. */
  readonly name: string;
  /** Whether the node can be activated or focused. */
  readonly interactive: boolean;
  /** Depth in the tree, so a flat list still shows structure. */
  readonly depth: number;
}

/**
 * Bounds on what one snapshot can be.
 *
 * A page can have tens of thousands of accessibility nodes; a prompt cannot. The
 * cap is applied while walking rather than after, so a hostile or merely enormous
 * page cannot make main hold the whole tree in memory first.
 */
export const ACCESSIBILITY_SNAPSHOT_MAX_NODES = 200;
export const ACCESSIBILITY_SNAPSHOT_MAX_NAME = 200;
const ACCESSIBILITY_SNAPSHOT_MAX_DEPTH = 32;
/**
 * How many nodes deep the walk itself may go, independent of how many it reports.
 *
 * Much larger than the reported depth because most of what it counts is
 * scaffolding - wrappers a framework emits that the projection drops - and it
 * exists only to keep a pathologically nested document off the stack.
 */
const ACCESSIBILITY_SNAPSHOT_MAX_TRAVERSAL = 1000;

/**
 * The depth asked of `Accessibility.getFullAXTree`.
 *
 * Twice the reported depth: the tree contains nodes the projection drops, so the
 * request has to reach past them to find the reported ones, while still refusing
 * to serialize a document that nests without end.
 */
export const ACCESSIBILITY_TREE_REQUEST_DEPTH =
  ACCESSIBILITY_SNAPSHOT_MAX_DEPTH * 2;

/**
 * Roles that are worth a row.
 *
 * Everything else - the generic containers, the presentational wrappers, the
 * text nodes - is structure the agent does not act on, and including it turns a
 * useful list into a transcript of the DOM. `heading` and `link` are here
 * because they are how a page is navigated even though neither is a control.
 */
const REPORTED_ROLES = new Set<string>([
  "button",
  "checkbox",
  "combobox",
  "heading",
  "link",
  "listbox",
  "menu",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/** Roles a caller can act on, as opposed to read. */
const INTERACTIVE_ROLES = new Set<string>([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/**
 * Projects a `Accessibility.getFullAXTree` result into a bounded, flat list.
 *
 * Pure over the CDP payload so the suite needs no browser: every shape the
 * protocol can hand back - a missing `nodes` array, a node with no role, an
 * ignored node, a child id pointing at nothing - is an ordinary input here
 * rather than an error, because a page under test produces all of them.
 */
export function projectAccessibilityTree(
  payload: unknown,
): readonly BrowserAccessibilityNode[] {
  const nodesById = indexNodes(payload);
  const root = findRoot(payload, nodesById);
  if (root === null) return [];
  const out: BrowserAccessibilityNode[] = [];
  walk(root, 0, 0, nodesById, out, new Set<string>());
  return out;
}

/**
 * @param depth How deep the node is in the REPORTED tree, which is what an agent
 *   reads as structure. Only advances past a node that was projected.
 * @param traversed How deep the walk itself is. Advances on EVERY node, which is
 *   what actually bounds the recursion: a page can nest a few thousand generic
 *   or ignored wrappers, none of which are projected, and a limit that only
 *   counted reported depth would recurse through all of them with `out.length`
 *   still at zero - a stack overflow reached by a document, not a cycle.
 */
function walk(
  node: Record<string, unknown>,
  depth: number,
  traversed: number,
  nodesById: Map<string, Record<string, unknown>>,
  out: BrowserAccessibilityNode[],
  seen: Set<string>,
): void {
  if (out.length >= ACCESSIBILITY_SNAPSHOT_MAX_NODES) return;
  if (depth > ACCESSIBILITY_SNAPSHOT_MAX_DEPTH) return;
  if (traversed > ACCESSIBILITY_SNAPSHOT_MAX_TRAVERSAL) return;
  const id = stringOf(node.nodeId);
  // A cycle is not supposed to be representable here, but the ids come off the
  // wire and a walk that trusts them is a hang rather than a bad answer.
  if (id !== null) {
    if (seen.has(id)) return;
    seen.add(id);
  }
  const projected = projectNode(node, depth);
  if (projected !== null) out.push(projected);
  const nextDepth = projected === null ? depth : depth + 1;
  for (const childId of childIdsOf(node)) {
    const child = nodesById.get(childId);
    if (child === undefined) continue;
    walk(child, nextDepth, traversed + 1, nodesById, out, seen);
  }
}

function projectNode(
  node: Record<string, unknown>,
  depth: number,
): BrowserAccessibilityNode | null {
  if (node.ignored === true) return null;
  const role = valueOf(node.role);
  if (role === null || !REPORTED_ROLES.has(role)) return null;
  return {
    role,
    name: bounded(valueOf(node.name) ?? ""),
    interactive: INTERACTIVE_ROLES.has(role) && !isDisabled(node),
    depth,
  };
}

/**
 * Whether the page has marked this node as not currently operable.
 *
 * Reported as non-interactive rather than omitted: a disabled Submit button is
 * part of what the page is showing and often the answer to "why did nothing
 * happen", but telling an agent it can be clicked invites a click that cannot
 * work. Chromium exposes this as an AX property rather than on the node.
 */
function isDisabled(node: Record<string, unknown>): boolean {
  const properties = node.properties;
  if (!Array.isArray(properties)) return false;
  for (const property of properties) {
    if (!isRecord(property)) continue;
    if (stringOf(property.name) !== "disabled") continue;
    const value = property.value;
    if (!isRecord(value)) continue;
    if (value.value === true) return true;
    if (stringOf(value.value) === "true") return true;
  }
  return false;
}

function indexNodes(payload: unknown): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  if (!isRecord(payload) || !Array.isArray(payload.nodes)) return index;
  for (const node of payload.nodes) {
    if (!isRecord(node)) continue;
    const id = stringOf(node.nodeId);
    if (id === null) continue;
    index.set(id, node);
  }
  return index;
}

/**
 * The first node nothing else claims as a child. Chromium reports the root
 * first, but deriving it costs one pass and does not depend on that ordering.
 */
function findRoot(
  payload: unknown,
  nodesById: Map<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  const claimed = new Set<string>();
  for (const node of nodesById.values()) {
    for (const childId of childIdsOf(node)) claimed.add(childId);
  }
  for (const [id, node] of nodesById) {
    if (!claimed.has(id)) return node;
  }
  // Every node is claimed, so the tree is cyclic or empty; fall back to the
  // reported order rather than answering nothing.
  if (!isRecord(payload) || !Array.isArray(payload.nodes)) return null;
  const first = payload.nodes[0];
  return isRecord(first) ? first : null;
}

function childIdsOf(node: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(node.childIds)) return [];
  return node.childIds.flatMap((id) => {
    const value = stringOf(id);
    return value === null ? [] : [value];
  });
}

/** Reads the `{ type, value }` shape CDP wraps role and name in. */
function valueOf(field: unknown): string | null {
  if (!isRecord(field)) return null;
  const value = field.value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bounded(value: string): string {
  return value.length > ACCESSIBILITY_SNAPSHOT_MAX_NAME
    ? value.slice(0, ACCESSIBILITY_SNAPSHOT_MAX_NAME)
    : value;
}
