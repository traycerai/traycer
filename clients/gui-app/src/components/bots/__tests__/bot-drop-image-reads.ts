/**
 * What the bot panes' file-drop suites hold of the image store: a
 * stored draft's image read waits for the case to release or fail it. Like
 * `bot-channel-question-card-state.ts`, it imports no app module at run time,
 * so a `vi.mock` factory can reach it while the app's modules are loading.
 */
import { vi } from "vitest";

/** What the image store's mock holds: every read the drafts ask for, until the case settles it. */
const imageReads = {
  calls: [] as Array<{
    readonly hash: string;
    readonly read: PromiseWithResolvers<Uint8Array<ArrayBuffer> | undefined>;
  }>,
  outcomes: new Map<
    string,
    | { readonly bytes: Uint8Array<ArrayBuffer> | undefined }
    | { readonly error: Error }
  >(),
};

export function resetImageReads(): void {
  for (const call of imageReads.calls) call.read.resolve(undefined);
  imageReads.calls.length = 0;
  imageReads.outcomes.clear();
}

/** The factory of the image store's `vi.mock`: reading a stored image waits for the case. */
export async function landingImageStoreMock(): Promise<
  typeof import("@/lib/composer/landing-image-store")
> {
  const real = await vi.importActual<
    typeof import("@/lib/composer/landing-image-store")
  >("@/lib/composer/landing-image-store");
  return {
    ...real,
    getImageBytes: (hash: string) => {
      const read = Promise.withResolvers<Uint8Array<ArrayBuffer> | undefined>();
      imageReads.calls.push({ hash, read });
      const outcome = imageReads.outcomes.get(hash);
      if (outcome !== undefined) {
        if ("error" in outcome) read.reject(outcome.error);
        else read.resolve(outcome.bytes);
      }
      return read.promise;
    },
  };
}

/** Every read of the stored image, asked for now or later, answers with its bytes. */
export function releaseImageReads(
  hash: string,
  bytes: Uint8Array<ArrayBuffer>,
): void {
  imageReads.outcomes.set(hash, { bytes });
  for (const call of imageReads.calls) {
    if (call.hash === hash) call.read.resolve(bytes);
  }
}

/** Every read of the stored image fails. */
export function failImageReads(hash: string): void {
  const error = new Error("the image store cannot be read");
  imageReads.outcomes.set(hash, { error });
  for (const call of imageReads.calls) {
    if (call.hash === hash) call.read.reject(error);
  }
}
