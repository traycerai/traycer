
export type ImportCookieSameSite = "Strict" | "Lax" | "None";

/** `encrypted` carries the raw bytes INCLUDING the three-byte version prefix, so the decryptor sees exactly what the browser wrote. */
export type ImportCookieSecret =
  | { readonly kind: "plain"; readonly value: string }
  | {
      readonly kind: "encrypted";
      readonly version: "v10" | "v11";
      readonly bytes: Uint8Array;
    }
  | { readonly kind: "protected" };

export interface ImportCookieRow {
  readonly domain: string;
  readonly name: string;
  readonly path: string;
  /** Unix seconds, or `-1` for a session cookie. */
  readonly expires: number;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: ImportCookieSameSite;
  readonly partitioned: boolean;
  readonly secret: ImportCookieSecret;
}

/** The whole of one source, as read; nothing decided yet. */
export interface ImportCookieRows {
  readonly rows: readonly ImportCookieRow[];
}
