import { EncryptStorage } from "encrypt-storage";

const FALLBACK_KEY = "traycer-desktop-default-secret";

function resolveEncryptionKey(): string {
  const configured =
    typeof import.meta !== "undefined" &&
    import.meta.env !== undefined &&
    typeof import.meta.env.VITE_DESKTOP_LOCAL_STORAGE_KEY === "string" &&
    import.meta.env.VITE_DESKTOP_LOCAL_STORAGE_KEY.length > 0
      ? import.meta.env.VITE_DESKTOP_LOCAL_STORAGE_KEY
      : null;
  if (configured !== null) {
    return configured;
  }
  // Packaged builds must never fall back to the well-known public string - anyone with the bundled asar would otherwise be able to decrypt tokens at rest.
  const isProdBuild =
    typeof import.meta !== "undefined" &&
    import.meta.env !== undefined &&
    import.meta.env.PROD === true;
  if (isProdBuild) {
    throw new Error(
      "[secure-local-storage] VITE_DESKTOP_LOCAL_STORAGE_KEY must be set at build time for packaged Desktop builds - refusing to fall back to a public default secret.",
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[secure-local-storage] VITE_DESKTOP_LOCAL_STORAGE_KEY is unset; falling back to a public default secret. Acceptable for `make dev-desktop` only.",
  );
  return FALLBACK_KEY;
}

const ENCRYPTION_KEY = resolveEncryptionKey();

let encryptStorage: EncryptStorage | null = null;

function getEncryptStorage(): EncryptStorage {
  if (encryptStorage === null) {
    encryptStorage = new EncryptStorage(ENCRYPTION_KEY, {
      storageType: "localStorage",
      encAlgorithm: "AES",
      // `ISecureStorage.get` returns exactly the string `set` was handed - this adapter stores opaque strings and every caller parses its own.
      // For a JWT (the legacy token slots) the parse throws and the raw string comes back, so the default LOOKED correct for years.
      doNotParseValues: true,
    });
  }
  return encryptStorage;
}

export function readEncryptedItem(key: string): string | null {
  try {
    const value = getEncryptStorage().getItem<string>(key);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch (error) {
    console.warn("[secure-local-storage] encrypted item read failed", {
      key,
      error: describeStorageError(error),
    });
    return null;
  }
}

export function writeEncryptedItem(key: string, value: string): void {
  getEncryptStorage().setItem(key, value);
}

export function removeEncryptedItem(key: string): void {
  getEncryptStorage().removeItem(key);
}

function describeStorageError(error: unknown): {
  readonly name: string;
} {
  if (error instanceof Error) {
    return { name: error.name };
  }
  return { name: typeof error };
}
