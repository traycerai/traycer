import type { del, get, set } from "idb-keyval";
import { vi } from "vitest";

import { idbStringKey } from "./browser-annotation-idb-mock";

import {
  deleteImage,
  imageHashKeys,
  releaseSession,
} from "@/lib/composer/landing-image-store";

export function installIdbWorking(
  idbData: Map<string, unknown>,
  mockedGet: typeof get,
  mockedSet: typeof set,
  mockedDel: typeof del,
): void {
  vi.mocked(mockedSet).mockImplementation((key, value) => {
    idbData.set(idbStringKey(key), value);
    return Promise.resolve();
  });
  vi.mocked(mockedDel).mockImplementation((key) => {
    idbData.delete(idbStringKey(key));
    return Promise.resolve();
  });
  vi.mocked(mockedGet).mockImplementation((key) =>
    Promise.resolve(idbData.get(idbStringKey(key))),
  );
}

export async function drainImages(): Promise<void> {
  for (const hash of await imageHashKeys()) {
    await deleteImage(hash);
    releaseSession(hash);
  }
}

export {
  createIdbKeyvalMock,
  idbStringKey,
} from "./browser-annotation-idb-mock";
