import { vi } from "vitest";

/** Captured before fake timers: a real turn lets WebCrypto's completions in. */
const realSetImmediate = globalThis.setImmediate;

/**
 * The fake clock moves everything here but Noise, which runs on WebCrypto's
 * thread pool. These count its operations, so a test awaits them finishing
 * rather than sleeping for as long as they usually take.
 */
let webCryptoInFlight = 0;

function countedWebCrypto<T>(operation: Promise<T>): Promise<T> {
  webCryptoInFlight += 1;
  return operation.finally(() => {
    webCryptoInFlight -= 1;
  });
}

export function countWebCrypto(): void {
  const subtle = globalThis.crypto.subtle;
  const decrypt = subtle.decrypt.bind(subtle);
  const digest = subtle.digest.bind(subtle);
  const encrypt = subtle.encrypt.bind(subtle);
  const importKey = subtle.importKey.bind(subtle);
  const sign = subtle.sign.bind(subtle);
  vi.spyOn(subtle, "decrypt").mockImplementation((...args) =>
    countedWebCrypto(decrypt(...args)),
  );
  vi.spyOn(subtle, "digest").mockImplementation((...args) =>
    countedWebCrypto(digest(...args)),
  );
  vi.spyOn(subtle, "encrypt").mockImplementation((...args) =>
    countedWebCrypto(encrypt(...args)),
  );
  vi.spyOn(subtle, "importKey").mockImplementation((...args) =>
    countedWebCrypto(importKey(...args)),
  );
  vi.spyOn(subtle, "sign").mockImplementation((...args) =>
    countedWebCrypto(sign(...args)),
  );
}

/**
 * Returns once no Noise operation is running. It takes two quiet turns because
 * the continuation of a finished operation can start the next one.
 */
export async function settleNoise(): Promise<void> {
  let quietTurns = 0;
  while (quietTurns < 2) {
    await new Promise((resolve) => {
      realSetImmediate(resolve);
    });
    quietTurns = webCryptoInFlight === 0 ? quietTurns + 1 : 0;
  }
}
