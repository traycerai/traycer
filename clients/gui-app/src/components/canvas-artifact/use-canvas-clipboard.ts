import type { ClipboardEvent } from "react";
import { canvasSourceOuterHtml } from "./canvas-board-document";
import type { CanvasBoardDocument } from "./canvas-board-document";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import { canvasImageBase64, canvasImageRefusal } from "./canvas-image-transfer";
import {
  useCanvasSelectionStore,
  type CanvasSelection,
} from "./canvas-selection-store";
import {
  canvasSelectionIsCurrent,
  useCanvasEditAction,
} from "./use-canvas-edit-action";

export function useCanvasClipboard(
  artifactId: string,
  registry: CanvasFrameRegistry,
) {
  const action = useCanvasEditAction(artifactId);
  const selected = (): CanvasSelection | null => {
    const selection = useCanvasSelectionStore.getState().selection;
    return selection?.artifactId === artifactId ? selection : null;
  };
  const writeImage = async (
    file: File,
    selection: CanvasSelection | null,
  ): Promise<void> => {
    if (selection?.element.tagName !== "img") {
      action.setMessage("Select an image to replace.");
      return;
    }
    const refusal = canvasImageRefusal(file);
    if (refusal !== null) {
      action.setMessage(refusal);
      return;
    }
    try {
      const bytesBase64 = await canvasImageBase64(file);
      if (!canvasSelectionIsCurrent(selection)) return;
      await action.apply(selection, {
        kind: "write-asset",
        fileName: file.name,
        mediaType: file.type,
        bytesBase64,
        replace: false,
      });
    } catch (error) {
      action.setMessage(
        error instanceof Error
          ? error.message
          : "This image could not be read.",
      );
    }
  };
  const replaceImage = (file: File): Promise<void> =>
    writeImage(file, selected());
  const insert = async (
    html: string,
    selection: CanvasSelection | null,
  ): Promise<void> => {
    if (selection === null) {
      action.setMessage("Select an element to paste after.");
      return;
    }
    if (new TextEncoder().encode(html).length > 65_536) {
      action.setMessage("This element is too large to paste here.");
      return;
    }
    if (canvasSelectionIsCurrent(selection))
      await action.apply(selection, { kind: "insert-html-after", html });
  };
  const copy = async (document: CanvasBoardDocument | null): Promise<void> => {
    const selection = selected();
    if (selection === null) return;
    if (selection.element.generated) {
      action.setMessage("Ask the agent to change this element.");
      return;
    }
    const mounted = registry.get(selection.boardPath);
    let locator: { tid: string } | { marker: number } | null = null;
    if (selection.element.tid !== null)
      locator = { tid: selection.element.tid };
    else if (selection.element.marker !== null)
      locator = { marker: selection.element.marker };
    try {
      const described =
        locator === null
          ? null
          : await mounted.bridge?.describeElement(locator);
      if (
        !canvasSelectionIsCurrent(selection) ||
        registry.get(selection.boardPath).bridge !== mounted.bridge
      )
        return;
      const html =
        described?.outerHtml ??
        (document?.sha256 === selection.servedSha256
          ? canvasSourceOuterHtml(document, selection.element)
          : null);
      if (html === null) {
        action.setMessage("This element is too large or unavailable to copy.");
        return;
      }
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([html], { type: "text/plain" }),
        }),
      ]);
      action.setMessage(null);
    } catch {
      action.setMessage("The element could not be copied. Try again.");
    }
  };
  const readClipboard = async (imagesOnly: boolean): Promise<void> => {
    const selection = selected();
    try {
      const items = await navigator.clipboard.read();
      const image = items
        .flatMap((item) => {
          const type = item.types.find((value) => value.startsWith("image/"));
          return type === undefined ? [] : [{ item, type }];
        })
        .at(0);
      if (image !== undefined) {
        const blob = await image.item.getType(image.type);
        await writeImage(
          new File([blob], `pasted-image.${image.type.split("/")[1]}`, {
            type: image.type,
          }),
          selection,
        );
        return;
      }
      const markup = items.find((item) => item.types.includes("text/html"));
      if (!imagesOnly && markup !== undefined) {
        await insert(
          await (await markup.getType("text/html")).text(),
          selection,
        );
        return;
      }
      action.setMessage("Copy an element or image first.");
    } catch {
      action.setMessage(
        "The clipboard could not be read. Use the Paste keyboard shortcut.",
      );
    }
  };
  const paste = (): Promise<void> => readClipboard(false);
  const pasteImage = (): Promise<void> => readClipboard(true);
  const onPaste = (event: ClipboardEvent<HTMLElement>): void => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input,textarea,[contenteditable=true]")
    )
      return;
    const image = Array.from(event.clipboardData.files).find((file) =>
      file.type.startsWith("image/"),
    );
    if (image !== undefined) {
      event.preventDefault();
      void replaceImage(image);
      return;
    }
    const html = event.clipboardData.getData("text/html");
    if (html) {
      event.preventDefault();
      void insert(html, selected());
    }
  };
  return { ...action, replaceImage, copy, paste, pasteImage, onPaste };
}
