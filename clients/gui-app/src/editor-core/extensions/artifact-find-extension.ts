import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface ArtifactFindMatch {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

export interface ArtifactFindPluginState {
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly matches: ReadonlyArray<ArtifactFindMatch>;
  readonly currentIndex: number;
  readonly decorations: DecorationSet;
  readonly pending: boolean;
}

export interface ArtifactFindSearchParams {
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
}

interface ArtifactFindSearchCommand extends ArtifactFindSearchParams {
  readonly kind: "search";
  readonly preferredPosition: number | null;
}

interface ArtifactFindCurrentCommand {
  readonly kind: "current";
  readonly currentIndex: number;
}

interface ArtifactFindClearCommand {
  readonly kind: "clear";
  readonly requestId: number;
}

type ArtifactFindCommand =
  | ArtifactFindSearchCommand
  | ArtifactFindCurrentCommand
  | ArtifactFindClearCommand;

interface IndexedCharacter {
  readonly from: number;
  readonly to: number;
}

interface IndexedText {
  readonly text: string;
  readonly positions: ReadonlyArray<IndexedCharacter | null>;
}

type UnknownRecord = { readonly [key: string]: unknown };

const ARTIFACT_FIND_META_KEY = "artifact-find:command";

export const artifactFindPluginKey = new PluginKey<ArtifactFindPluginState>(
  "artifact-find",
);

export const ArtifactFindExtension = Extension.create({
  name: "artifactFind",

  addProseMirrorPlugins() {
    return [
      new Plugin<ArtifactFindPluginState>({
        key: artifactFindPluginKey,
        state: {
          init: (_config, state: EditorState): ArtifactFindPluginState =>
            createArtifactFindPluginState({
              doc: state.doc,
              requestId: 0,
              query: "",
              matchCase: false,
              preferredPosition: null,
              pending: false,
            }),
          apply: (tr, prev, _oldState, newState): ArtifactFindPluginState => {
            const command = readArtifactFindCommand(tr);
            if (command !== null) {
              if (command.kind === "clear") {
                return createArtifactFindPluginState({
                  doc: newState.doc,
                  requestId: command.requestId,
                  query: "",
                  matchCase: prev.matchCase,
                  preferredPosition: null,
                  pending: false,
                });
              }
              if (command.kind === "current") {
                return updateCurrentMatch(newState.doc, prev, command);
              }
              return createArtifactFindPluginState({
                doc: newState.doc,
                requestId: command.requestId,
                query: command.query,
                matchCase: command.matchCase,
                preferredPosition: command.preferredPosition,
                pending: false,
              });
            }
            if (!tr.docChanged) return prev;
            if (prev.query.length === 0) {
              return {
                ...prev,
                decorations: DecorationSet.create(newState.doc, []),
                pending: false,
              };
            }
            return mapPendingState(tr, prev, newState.doc);
          },
        },
        props: {
          decorations(state) {
            return artifactFindPluginKey.getState(state)?.decorations;
          },
        },
      }),
    ];
  },
});

export function calculateArtifactFindMatches(
  doc: ProseMirrorNode,
  query: string,
  matchCase: boolean,
): ReadonlyArray<ArtifactFindMatch> {
  if (query.length === 0) return [];
  const indexed = collectIndexedText(doc);
  const needle = matchCase ? query : query.toLowerCase();
  const haystack = matchCase ? indexed.text : indexed.text.toLowerCase();
  const matches: ArtifactFindMatch[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const match = matchFromIndexedText(indexed, index, query.length);
    if (match !== null) matches.push(match);
    index = haystack.indexOf(needle, index + query.length);
  }
  return matches;
}

export function getArtifactFindState(editor: Editor): ArtifactFindPluginState {
  return (
    artifactFindPluginKey.getState(editor.state) ??
    createArtifactFindPluginState({
      doc: editor.state.doc,
      requestId: 0,
      query: "",
      matchCase: false,
      preferredPosition: null,
      pending: false,
    })
  );
}

export function applyArtifactFindSearch(
  editor: Editor,
  params: ArtifactFindSearchParams,
  preferredPosition: number | null,
): void {
  editor.view.dispatch(
    setArtifactFindSearchMeta(editor.state.tr, params, preferredPosition),
  );
}

export function setArtifactFindSearchMeta(
  tr: Transaction,
  params: ArtifactFindSearchParams,
  preferredPosition: number | null,
): Transaction {
  const command: ArtifactFindSearchCommand = {
    kind: "search",
    requestId: params.requestId,
    query: params.query,
    matchCase: params.matchCase,
    preferredPosition,
  };
  return tr.setMeta(artifactFindPluginKey, {
    [ARTIFACT_FIND_META_KEY]: command,
  });
}

export function clearArtifactFind(editor: Editor, requestId: number): void {
  const command: ArtifactFindClearCommand = {
    kind: "clear",
    requestId,
  };
  editor.view.dispatch(
    editor.state.tr.setMeta(artifactFindPluginKey, {
      [ARTIFACT_FIND_META_KEY]: command,
    }),
  );
}

export function setArtifactFindCurrent(
  editor: Editor,
  currentIndex: number,
): void {
  const command: ArtifactFindCurrentCommand = {
    kind: "current",
    currentIndex,
  };
  const tr = editor.state.tr.setMeta(artifactFindPluginKey, {
    [ARTIFACT_FIND_META_KEY]: command,
  });
  editor.view.dispatch(tr);
}

export function hasArtifactFindTransactionMeta(tr: Transaction): boolean {
  return readArtifactFindCommand(tr) !== null;
}

export function findNearestArtifactFindMatchIndex(
  matches: ReadonlyArray<ArtifactFindMatch>,
  position: number | null,
): number {
  if (matches.length === 0) return -1;
  if (position === null) return 0;
  const exactIndex = matches.findIndex(
    (match) => match.from <= position && position < match.to,
  );
  if (exactIndex !== -1) return exactIndex;
  return matches.reduce((nearestIndex, match, index) => {
    const nearest = matches[nearestIndex];
    const nearestDistance = Math.abs(nearest.from - position);
    const candidateDistance = Math.abs(match.from - position);
    return candidateDistance < nearestDistance ? index : nearestIndex;
  }, 0);
}

function createArtifactFindPluginState(args: {
  readonly doc: ProseMirrorNode;
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly preferredPosition: number | null;
  readonly pending: boolean;
}): ArtifactFindPluginState {
  const matches = calculateArtifactFindMatches(
    args.doc,
    args.query,
    args.matchCase,
  );
  const currentIndex = findNearestArtifactFindMatchIndex(
    matches,
    args.preferredPosition,
  );
  return {
    requestId: args.requestId,
    query: args.query,
    matchCase: args.matchCase,
    matches,
    currentIndex,
    decorations: buildDecorations(args.doc, matches, currentIndex),
    pending: args.pending,
  };
}

function updateCurrentMatch(
  doc: ProseMirrorNode,
  prev: ArtifactFindPluginState,
  command: ArtifactFindCurrentCommand,
): ArtifactFindPluginState {
  const currentIndex =
    command.currentIndex >= 0 && command.currentIndex < prev.matches.length
      ? command.currentIndex
      : findNearestArtifactFindMatchIndex(prev.matches, null);
  return {
    ...prev,
    currentIndex,
    decorations: buildDecorations(doc, prev.matches, currentIndex),
  };
}

function mapPendingState(
  tr: Transaction,
  prev: ArtifactFindPluginState,
  doc: ProseMirrorNode,
): ArtifactFindPluginState {
  const priorCurrent = artifactFindMatchAt(prev.matches, prev.currentIndex);
  const preferredPosition =
    priorCurrent === null ? null : tr.mapping.map(priorCurrent.from, 1);
  const matches = prev.matches.flatMap((match) => {
    const from = tr.mapping.map(match.from, 1);
    const to = tr.mapping.map(match.to, -1);
    if (from >= to || from < 0 || to > doc.content.size) return [];
    return [
      {
        from,
        to,
        text: doc.textBetween(from, to, "\n", "\n"),
      },
    ];
  });
  const currentIndex = findNearestArtifactFindMatchIndex(
    matches,
    preferredPosition,
  );
  return {
    ...prev,
    matches,
    currentIndex,
    decorations: buildDecorations(doc, matches, currentIndex),
    pending: true,
  };
}

function buildDecorations(
  doc: ProseMirrorNode,
  matches: ReadonlyArray<ArtifactFindMatch>,
  currentIndex: number,
): DecorationSet {
  const decorations = matches.map((match, index) => {
    const current = index === currentIndex;
    return Decoration.inline(
      match.from,
      match.to,
      {
        class: current
          ? "tc-artifact-find-match tc-artifact-find-match-current"
          : "tc-artifact-find-match",
        "data-artifact-find-match": "true",
        ...(current ? { "data-artifact-find-current": "true" } : {}),
      },
      {
        inclusiveStart: false,
        inclusiveEnd: false,
      },
    );
  });
  return DecorationSet.create(doc, decorations);
}

function collectIndexedText(doc: ProseMirrorNode): IndexedText {
  const chars: string[] = [];
  const positions: Array<IndexedCharacter | null> = [];
  let sawTextBlock = false;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (sawTextBlock) {
      chars.push("\n");
      positions.push(null);
    }
    sawTextBlock = true;
    node.descendants((child, childOffset) => {
      if (!child.isText) {
        // Inline leaf nodes (hard breaks, atoms) break up visible text runs;
        // index a boundary so a search can't match across them (e.g.
        // "foo<HardBreak/>bar" must not be a hit for "foobar").
        if (child.isLeaf) {
          chars.push("\n");
          positions.push(null);
        }
        return true;
      }
      const text = child.text;
      if (typeof text !== "string" || text.length === 0) return true;
      const from = pos + 1 + childOffset;
      text.split("").forEach((character, index) => {
        chars.push(character);
        positions.push({ from: from + index, to: from + index + 1 });
      });
      return false;
    });
    return false;
  });
  return { text: chars.join(""), positions };
}

function matchFromIndexedText(
  indexed: IndexedText,
  fromIndex: number,
  length: number,
): ArtifactFindMatch | null {
  const toIndex = fromIndex + length - 1;
  const from = indexed.positions[fromIndex] ?? null;
  const to = indexed.positions[toIndex] ?? null;
  if (from === null || to === null) return null;
  if (
    indexed.positions
      .slice(fromIndex, toIndex + 1)
      .some((position) => position === null)
  ) {
    return null;
  }
  return {
    from: from.from,
    to: to.to,
    text: indexed.text.slice(fromIndex, fromIndex + length),
  };
}

function artifactFindMatchAt(
  matches: ReadonlyArray<ArtifactFindMatch>,
  index: number,
): ArtifactFindMatch | null {
  if (index < 0) return null;
  return matches.at(index) ?? null;
}

function readArtifactFindCommand(tr: Transaction): ArtifactFindCommand | null {
  const meta: unknown = tr.getMeta(artifactFindPluginKey);
  if (!isRecord(meta)) return null;
  const command = meta[ARTIFACT_FIND_META_KEY];
  if (!isRecord(command)) return null;
  if (command.kind === "clear") return readClearCommand(command);
  if (command.kind === "current") return readCurrentCommand(command);
  if (command.kind === "search") return readSearchCommand(command);
  return null;
}

function readClearCommand(
  command: UnknownRecord,
): ArtifactFindClearCommand | null {
  const requestId = command.requestId;
  if (typeof requestId !== "number") return null;
  return { kind: "clear", requestId };
}

function readCurrentCommand(
  command: UnknownRecord,
): ArtifactFindCurrentCommand | null {
  const currentIndex = command.currentIndex;
  if (typeof currentIndex !== "number") return null;
  return { kind: "current", currentIndex };
}

function readSearchCommand(
  command: UnknownRecord,
): ArtifactFindSearchCommand | null {
  const requestId = command.requestId;
  const query = command.query;
  const matchCase = command.matchCase;
  const preferredPosition = command.preferredPosition;
  if (
    typeof requestId !== "number" ||
    typeof query !== "string" ||
    typeof matchCase !== "boolean"
  ) {
    return null;
  }
  return {
    kind: "search",
    requestId,
    query,
    matchCase,
    preferredPosition:
      typeof preferredPosition === "number" ? preferredPosition : null,
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}
