/**
 * Source of truth for epic node kinds, display registries, and tree
 * conversion. The GUI treats chat + the four backend artifact kinds
 * (spec, ticket, story, review) as a single "EpicNode" concept.
 * `Record<EpicNodeKind, …>` tables below fail compilation until every
 * key is filled in when a kind is added.
 */
import {
  BookOpen,
  Bot,
  ClipboardCheck,
  FileText,
  MessageSquare,
  Terminal,
  Ticket,
  type LucideIcon,
} from "lucide-react";
import type { TreeNodeNested } from "@/lib/tree-types";
import { buildTreeFromFlatRecords } from "@/lib/tree-utils";
import { getRecordSchema } from "@traycer/protocol/framework/index";
import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { type EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";

const epicArtifactKindSchema = getRecordSchema(
  commonRecordRegistry,
  "epic-artifact-kind",
  "latest",
);

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export type EpicNodeKind =
  EpicArtifactKind | "chat" | "terminal-agent" | "terminal";

export const EPIC_NODE_KINDS: ReadonlyArray<EpicNodeKind> = [
  "chat",
  "terminal-agent",
  ...epicArtifactKindSchema.options,
  "terminal",
];

const EPIC_ARTIFACT_KIND_SET: ReadonlySet<string> = new Set(
  epicArtifactKindSchema.options,
);

export function isEpicArtifactKind(
  value: string | null | undefined,
): value is EpicArtifactKind {
  return (
    value !== null && value !== undefined && EPIC_ARTIFACT_KIND_SET.has(value)
  );
}

const EPIC_NODE_KIND_SET: ReadonlySet<string> = new Set(EPIC_NODE_KINDS);

// Single home for node-kind identity (mirrors `isEpicArtifactKind`). Accepts
// `unknown` so callers validating untrusted persisted/wire data can guard a
// raw `type` field directly.
export function isEpicNodeKind(value: unknown): value is EpicNodeKind {
  return typeof value === "string" && EPIC_NODE_KIND_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Display data attached to each tree node. */
export interface EpicNodeData {
  name: string;
  type: EpicNodeKind;
  hostId: string;
}

/**
 * Canonical icon, default icon color, and default-name registries for
 * `EpicNodeKind`. Owned here so sidebars, the store (for newly-created
 * record names), and any other consumer render a single consistent
 * identity per kind.
 */
export const EPIC_NODE_ICONS: Readonly<Record<EpicNodeKind, LucideIcon>> = {
  chat: MessageSquare,
  "terminal-agent": Bot,
  spec: FileText,
  ticket: Ticket,
  story: BookOpen,
  review: ClipboardCheck,
  terminal: Terminal,
};

export const EPIC_NODE_LABELS: Readonly<Record<EpicNodeKind, string>> = {
  chat: "Chat",
  "terminal-agent": "Terminal Agent",
  spec: "Spec",
  ticket: "Ticket",
  story: "Story",
  review: "Review",
  terminal: "Terminal",
};

/**
 * Lower-case noun naming a node inside a sentence - destructive confirmations,
 * summaries, and similar prose.
 *
 * `chat` and `terminal-agent` both collapse to **agent**: Agent is the durable
 * entity the action operates on and Chat/Terminal are only the interfaces used
 * to reach it, so "Delete agent "Foo"?" is true for either. Interpolating the
 * raw node kind here previously leaked the hyphenated `terminal-agent` into
 * user-facing copy.
 */
export const EPIC_NODE_SENTENCE_NOUNS: Readonly<Record<EpicNodeKind, string>> =
  {
    chat: "agent",
    "terminal-agent": "agent",
    spec: "spec",
    ticket: "ticket",
    story: "story",
    review: "review",
    terminal: "terminal",
  };

export type EpicNodeIconColors = Readonly<Record<EpicNodeKind, string>>;

export const DEFAULT_EPIC_NODE_ICON_COLORS: EpicNodeIconColors = {
  chat: "#38bdf8",
  "terminal-agent": "#22d3ee",
  spec: "#fbbf24",
  ticket: "#a78bfa",
  story: "#34d399",
  review: "#fb7185",
  terminal: "#94a3b8",
};
function createEpicNodeIconColors(
  getColor: (kind: EpicNodeKind) => string,
): EpicNodeIconColors {
  return {
    chat: getColor("chat"),
    "terminal-agent": getColor("terminal-agent"),
    spec: getColor("spec"),
    ticket: getColor("ticket"),
    story: getColor("story"),
    review: getColor("review"),
    terminal: getColor("terminal"),
  };
}

export function normalizeEpicNodeIconColor(value: string): string | null {
  return HEX_COLOR_PATTERN.test(value) ? value.toLowerCase() : null;
}

export function normalizeEpicNodeIconColors(
  value: unknown,
): EpicNodeIconColors {
  if (!isRecord(value)) return DEFAULT_EPIC_NODE_ICON_COLORS;
  return createEpicNodeIconColors((kind) =>
    typeof value[kind] === "string"
      ? (normalizeEpicNodeIconColor(value[kind]) ??
        DEFAULT_EPIC_NODE_ICON_COLORS[kind])
      : DEFAULT_EPIC_NODE_ICON_COLORS[kind],
  );
}

/**
 * Empty-document hint per artifact kind, rendered by the Tiptap `Placeholder`
 * extension while the doc is empty and the editor is editable - a fresh
 * manually-created artifact tells the user where to start typing (and what
 * the surface is for) without ever entering the document. A `Record` so a new
 * artifact kind fails compilation until its hint is written.
 */
export const EPIC_NODE_PLACEHOLDER_TEXT: Readonly<
  Record<EpicArtifactKind, string>
> = {
  spec: "Describe what you want to build — goals, requirements, constraints…",
  ticket: "Describe this ticket — what needs to change and how to verify it…",
  story: "Describe this story — the user journey this work serves…",
  review: "Write this review — findings, decisions, and follow-ups…",
};

export const DEFAULT_EPIC_NODE_NAMES: Readonly<Record<EpicNodeKind, string>> = {
  chat: "New chat",
  "terminal-agent": "New terminal agent",
  spec: "New spec",
  ticket: "New ticket",
  story: "New story",
  review: "New review",
  terminal: "Terminal",
};

export const TUI_AGENT_HARNESS_LABELS: Readonly<Record<TuiHarnessId, string>> =
  {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    // Reserved schema value; current runtime catalogs and epic projection hide
    // Cursor terminal agents until the TUI surface is supported.
    cursor: "Cursor",
  };

/**
 * Flat node record - mirrors the shape that the backend will eventually
 * return. Each node has a unique `id` and an optional `parentId` that
 * points to its parent in the hierarchy.
 *
 * `hostId` is the host that hosts the
 * artifact's Y.Doc projection. Stamped at create time and stable for
 * the artifact's lifetime - chat / terminal artifacts are bound to a
 * host for life, and the binding rides through every sidebar
 * projection into `EpicNodeRef.hostId`.
 */
export interface EpicNodeRecord {
  id: string;
  parentId: string | null;
  name: string;
  type: EpicNodeKind;
  hostId: string;
}

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

/**
 * Converts a flat list of `EpicNodeRecord`s into the nested
 * `TreeNodeNested<EpicNodeData>[]` format expected by `TreeView`.
 *
 * Records whose `parentId` is `null` or references an unknown id become
 * root nodes. Maintains insertion order within each level.
 */
export function buildEpicNodeTree(
  records: ReadonlyArray<EpicNodeRecord>,
): TreeNodeNested<EpicNodeData>[] {
  return buildTreeFromFlatRecords(records, {
    getId: (record) => record.id,
    getParentId: (record) => record.parentId,
    getData: (record) => ({
      name: record.name,
      type: record.type,
      hostId: record.hostId,
    }),
    isGroup: (_record, children) => children.length > 0,
  });
}
