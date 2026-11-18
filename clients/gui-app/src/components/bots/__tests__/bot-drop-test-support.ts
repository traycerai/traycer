/**
 * What the bot panes' file-drop suites share (T386): the drags a browser hands
 * a zone, the notices the zones raise, and a stored draft whose image read the
 * case holds and releases. Each suite keeps its own `vi.mock` calls and hands
 * the image store's to {@link landingImageStoreMock}.
 */
import { fireEvent } from "@testing-library/react";
import { toast } from "sonner";
import { vi, type MockInstance } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  fileTransfer,
  uriOnlyTransfer,
  type FakeTransfer,
} from "@/lib/composer/__tests__/file-drop-fixtures";
import { botBoxDraftsKey } from "@/lib/persist/keys";
import {
  BOT_ID,
  boxDoc,
  hashedImage,
  IMAGE_B64,
} from "@/stores/bots/__tests__/bot-box-draft-persist-support";

export const PNG_BYTES = Uint8Array.from(atob(IMAGE_B64), (char) =>
  char.charCodeAt(0),
);

export function imageFile(name: string): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

export function textFile(name: string): File {
  return new File(["notes"], name, { type: "text/plain" });
}

/** A transfer whose `dropEffect` the zone can write, as a browser's is. */
export interface DragTransfer extends FakeTransfer {
  dropEffect: string;
}

function writable(transfer: FakeTransfer): DragTransfer {
  return { ...transfer, dropEffect: "copy" };
}

export function filesTransfer(...files: ReadonlyArray<File>): DragTransfer {
  return writable(fileTransfer(files));
}

export function fileReferenceTransfer(path: string): DragTransfer {
  return writable(uriOnlyTransfer(`file://${path}`));
}

export function linkTransfer(url: string): DragTransfer {
  return writable({
    files: [],
    types: ["text/uri-list", "text/plain"],
    items: [],
    getData: (type) =>
      type === "text/uri-list" || type === "text/plain" ? url : "",
  });
}

export function textTransfer(text: string): DragTransfer {
  return writable({
    files: [],
    types: ["text/plain"],
    items: [],
    getData: (type) => (type === "text/plain" ? text : ""),
  });
}

/** What a zone made of a gesture: whether it was default-prevented, and the drop effect it left. */
export interface Verdict {
  readonly prevented: boolean;
  readonly dropEffect: string;
}

export function dragOver(target: Element, transfer: DragTransfer): Verdict {
  const prevented = !fireEvent.dragOver(target, { dataTransfer: transfer });
  return { prevented, dropEffect: transfer.dropEffect };
}

export function dropOn(target: Element, transfer: DragTransfer): Verdict {
  const prevented = !fireEvent.drop(target, { dataTransfer: transfer });
  return { prevented, dropEffect: transfer.dropEffect };
}

/** A file drag that has entered `target`, as the overlay shows it. */
export function dragEnter(target: Element, transfer: DragTransfer): void {
  fireEvent.dragEnter(target, { dataTransfer: transfer });
}

/** The notices the zones raised, as `toast.info` was called with them. */
export function spyOnNotices(): MockInstance<typeof toast.info> {
  return vi.spyOn(toast, "info");
}

export function noticeMessages(
  spy: MockInstance<typeof toast.info>,
): ReadonlyArray<unknown> {
  return spy.mock.calls.map(([message]) => message);
}

export function noticeIds(
  spy: MockInstance<typeof toast.info>,
): ReadonlyArray<string | number | undefined> {
  return spy.mock.calls.map(([, options]) => options?.id);
}

/** The hash a draft's image is stored under: the bytes' own. */
export async function storedImageHash(): Promise<string> {
  const { sha256Hex } = await vi.importActual<
    typeof import("@/lib/composer/landing-image-store")
  >("@/lib/composer/landing-image-store");
  return sha256Hex(new Uint8Array(PNG_BYTES));
}

export const STORED_TEXT = "Words stored with an image";

/** The stored document of `account`: the box `key` holds `STORED_TEXT` and `count` images named by one hash. */
export function storeDraftWithImages(
  account: string,
  key: string,
  hash: string,
  count: number,
): string {
  const image = hashedImage(hash);
  const content: JsonContent = boxDoc(
    STORED_TEXT,
    Array.from({ length: count }, (_unused, index) => ({
      ...image,
      attrs: { ...image.attrs, id: `image-${String(index + 1)}` },
    })),
  );
  const raw = JSON.stringify({
    state: {
      threadBoxes: {
        [BOT_ID]: { [key]: { text: STORED_TEXT, content, seedId: 1 } },
      },
    },
    version: 1,
  });
  localStorage.setItem(botBoxDraftsKey(account), raw);
  return raw;
}
