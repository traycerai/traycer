import { fireEvent } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";

/**
 * Drop and paste gestures, as the composer suites fire them at a zone: the
 * transfers a browser or the desktop shell hands over, and the copy a chat on
 * another computer refuses an entry with.
 */

interface FakeTransferItem {
  readonly kind: string;
  readonly type: string;
  readonly getAsFile?: () => File | null;
  readonly webkitGetAsEntry?: () => {
    readonly name: string;
    readonly isDirectory: boolean;
    readonly isFile: boolean;
  } | null;
}

export interface FakeTransfer {
  readonly files: ReadonlyArray<File>;
  readonly types: ReadonlyArray<string>;
  readonly items: ReadonlyArray<FakeTransferItem>;
  readonly getData: (type: string) => string;
}

/** A transfer from a browser with no `webkitGetAsEntry`: files, nothing more. */
export function fileTransfer(files: ReadonlyArray<File>): FakeTransfer {
  return {
    files,
    types: ["Files"],
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
    })),
    getData: () => "",
  };
}

/** What the DOM clipboard holds when only the native clipboard has the files. */
export function emptyTransfer(): FakeTransfer {
  return { files: [], types: [], items: [], getData: () => "" };
}

/** A file reference with no `File` behind it: only a URI flavor. */
export function uriOnlyTransfer(uri: string): FakeTransfer {
  return {
    files: [],
    types: ["text/uri-list"],
    items: [],
    getData: (type) => (type === "text/uri-list" ? uri : ""),
  };
}

export type Gesture = "paste" | "drop";

export function perform(
  gesture: Gesture,
  zone: HTMLElement,
  transfer: FakeTransfer,
): void {
  if (gesture === "paste") fireEvent.paste(zone, { clipboardData: transfer });
  else fireEvent.drop(zone, { dataTransfer: transfer });
}

/**
 * A gesture whose items carry `webkitGetAsEntry`, answering only while the
 * gesture's own handlers run: a browser empties the transfer once they return.
 */
export function performWithEntries(
  gesture: Gesture,
  zone: HTMLElement,
  files: ReadonlyArray<File>,
  directoryNames: ReadonlySet<string>,
): void {
  let live = true;
  perform(gesture, zone, {
    ...fileTransfer(files),
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
      webkitGetAsEntry: () =>
        live
          ? {
              name: file.name,
              isDirectory: directoryNames.has(file.name),
              isFile: !directoryNames.has(file.name),
            }
          : null,
    })),
  });
  live = false;
}

export function pdfFile(name: string): File {
  return new File([crypto.randomUUID()], name, { type: "application/pdf" });
}

/**
 * What a folder is to the page in Electron: an empty type and a `File` whose
 * bytes cannot be read.
 */
export function folderFile(name: string): File {
  const folder = new File([], name, { type: "" });
  Object.defineProperty(folder, "arrayBuffer", {
    value: () =>
      Promise.reject(
        new DOMException(
          "A requested file or directory could not be found.",
          "NotFoundError",
        ),
      ),
  });
  return folder;
}

export const REMOTE_REFUSAL_TITLE =
  "Could not attach to a chat on another computer";
export const REMOTE_REFUSAL_DESCRIPTION =
  "This chat runs on another computer. Use the attach button.";

function nodesOfType(
  content: JsonContent,
  type: string,
): ReadonlyArray<JsonContent> {
  const own = content.type === type ? [content] : [];
  return [
    ...own,
    ...(content.content ?? []).flatMap((child) => nodesOfType(child, type)),
  ];
}

/** The text of every inline-code span: how a typed path sits in a document. */
export function typedPathSpans(content: JsonContent): ReadonlyArray<string> {
  return nodesOfType(content, "text").flatMap((node) =>
    node.marks?.some((mark) => mark.type === "code") === true &&
    node.text !== undefined
      ? [node.text]
      : [],
  );
}

/** The id of every attachment node: the key of its upload's status. */
export function attachedFileIds(content: JsonContent): ReadonlyArray<string> {
  return nodesOfType(content, "fileAttachment").flatMap((node) =>
    typeof node.attrs?.id === "string" ? [node.attrs.id] : [],
  );
}

/** The file name of every attachment node: how an uploaded file sits in a document. */
export function attachedFileNames(content: JsonContent): ReadonlyArray<string> {
  return nodesOfType(content, "fileAttachment").flatMap((node) =>
    typeof node.attrs?.fileName === "string" ? [node.attrs.fileName] : [],
  );
}
