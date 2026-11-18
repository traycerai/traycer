import { act } from "@testing-library/react";
import { useState } from "react";
import { parseHtmlSource } from "@traycer/html-source";
import type { EpicEditArtboardResponse } from "@traycer/protocol/host/epic/artboard-edit";
import { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import { CanvasFrameRegistry } from "../canvas-frame-registry";
import type { CanvasBoardDocument } from "../canvas-board-document";
import type { CanvasSelection } from "../canvas-selection-store";
import type { CanvasEditVariables } from "../use-artboard-edit";

export const ARTIFACT_ID = "canvas-1";
export const BOARD_PATH = "boards/home.html";

export interface PendingSave {
  readonly variables: CanvasEditVariables;
  readonly settle: (response: EpicEditArtboardResponse) => void;
  readonly fail: (error: Error) => void;
}

/**
 * Each save is a promise the test settles by hand, so a component can be
 * observed while the host is still answering. Reset it in `beforeEach`.
 */
export const pendingSaves: PendingSave[] = [];

/** The module a test installs with `vi.mock("../use-artboard-edit", ...)`. */
export function artboardEditModule() {
  return {
    useArtboardEdit: () => {
      const [inFlight, setInFlight] = useState(0);
      return {
        isPending: inFlight > 0,
        mutateAsync: (variables: CanvasEditVariables) => {
          setInFlight((count) => count + 1);
          return new Promise<EpicEditArtboardResponse>((resolve, reject) => {
            pendingSaves.push({
              variables,
              settle: (response) => {
                setInFlight((count) => count - 1);
                resolve(response);
              },
              fail: (error) => {
                setInFlight((count) => count - 1);
                reject(error);
              },
            });
          });
        },
      };
    },
  };
}

export const SAVED: EpicEditArtboardResponse = {
  ok: true,
  tid: "t",
  sha256After: "a".repeat(64),
  splices: [],
};

export const REFUSED: EpicEditArtboardResponse = {
  ok: false,
  reason: "stale",
  detail: "The artboard changed. Select the element again and retry.",
};

export async function settleSave(
  index: number,
  response: EpicEditArtboardResponse,
): Promise<void> {
  await act(async () => {
    pendingSaves[index].settle(response);
    await Promise.resolve();
  });
}

export async function failSave(index: number): Promise<void> {
  await act(async () => {
    pendingSaves[index].fail(new Error("host unreachable"));
    await Promise.resolve();
  });
}

export function canvasElement(
  overrides: Partial<CanvasElement>,
): CanvasElement {
  return {
    marker: 12,
    tid: "t",
    tagName: "p",
    selector: "p",
    elementId: null,
    classNames: [],
    textPreview: "Hello",
    inlineStyle: "",
    ariaRole: null,
    accessibleName: null,
    box: { x: 40, y: 100, width: 200, height: 24 },
    computedStyles: [],
    generated: false,
    ...overrides,
  };
}

export function textSelection(
  range: { readonly start: number; readonly end: number } | null,
  elementOverrides: Partial<CanvasElement>,
): CanvasSelection {
  const element = canvasElement(elementOverrides);
  return {
    artifactId: ARTIFACT_ID,
    boardPath: BOARD_PATH,
    page: null,
    servedSha256: "sha-served",
    element,
    textRange:
      range === null
        ? null
        : {
            element,
            start: range.start,
            end: range.end,
            quote: "quote",
            rects: [{ x: 40, y: 100, width: 50, height: 20 }],
          },
  };
}

/**
 * A selection of `start..end` inside an element whose text is `text`, quoting
 * exactly what the page would: the toolbar refuses a range whose quote is not
 * the source text at that range.
 */
export function quotedSelection(
  text: string,
  start: number,
  end: number,
  elementOverrides: Partial<CanvasElement>,
): CanvasSelection {
  const selection = textSelection({ start, end }, elementOverrides);
  if (selection.textRange === null) throw new Error("range expected");
  return {
    ...selection,
    textRange: { ...selection.textRange, quote: text.slice(start, end) },
  };
}

/** The same selection with part of its text range replaced. */
export function withTextRange(
  selection: CanvasSelection,
  patch: Partial<NonNullable<CanvasSelection["textRange"]>>,
): CanvasSelection {
  if (selection.textRange === null) throw new Error("range expected");
  return { ...selection, textRange: { ...selection.textRange, ...patch } };
}

export function boardDocument(text: string): CanvasBoardDocument {
  return { sha256: "sha-served", text, parsed: parseHtmlSource(text) };
}

const bridges: SandboxBridgeHost[] = [];

/** A real bridge; a test replaces the one call it cares about with `vi.spyOn`. */
export function realBridge(): SandboxBridgeHost {
  const host = new SandboxBridgeHost({
    document: {
      kind: "served",
      canvas: true,
      nonce: "n",
      forwardedShortcuts: [],
      pages: null,
    },
    hostContext: {
      theme: "light",
      styles: { variables: {} },
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      platform: "desktop",
    },
    hostVersion: "9.9.9",
    post: () => undefined,
    events: {
      onStatus: () => undefined,
      onSize: () => undefined,
      onOpenLink: () => Promise.resolve(true),
      onShortcut: () => undefined,
      onRequestTeardown: () => undefined,
      onScrollGesture: () => undefined,
      onWheel: () => undefined,
    },
    appRequests: null,
  });
  bridges.push(host);
  return host;
}

export function disposeBridges(): void {
  for (const host of bridges.splice(0)) host.dispose();
}

/** A registry whose board is mounted, answering through `bridge`, serving `sha256`. */
export function registryServing(
  bridge: SandboxBridgeHost | null,
  sha256: string | null,
): CanvasFrameRegistry {
  const registry = new CanvasFrameRegistry();
  registry.update(BOARD_PATH, { bridge, sha256, page: null });
  return registry;
}
