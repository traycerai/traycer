/**
 * The one row shape every login-import reader emits, before normalisation.
 *
 * A reader's job is to get bytes off disk and into this shape without
 * deciding anything: whether the cookie is still valid, which site it belongs
 * to, or whether it may be imported at all is `normalize.ts`'s call, and the
 * scan and the import both go through that one place so their counts agree.
 */

export type ImportCookieSameSite = "Strict" | "Lax" | "None";

/**
 * The value, or what stands in its way. `encrypted` carries the raw bytes
 * INCLUDING the three-byte version prefix, so the decryptor sees exactly what
 * the browser wrote; `protected` is Chromium's `v20` App-Bound Encryption,
 * which no other process can open and which the import reports rather than
 * attempts.
 */
export type ImportCookieSecret =
  | { readonly kind: "plain"; readonly value: string }
  | {
      readonly kind: "encrypted";
      readonly version: "v10" | "v11";
      readonly bytes: Uint8Array;
    }
  | { readonly kind: "protected" };

export interface ImportCookieRow {
  /**
   * RFC 6265 wire form as the source browser stores it: a leading dot for a
   * domain cookie, none for a host-only cookie. `normalize.ts` keeps that
   * distinction, because it is the cookie's identity in the host's store.
   */
  readonly domain: string;
  readonly name: string;
  readonly path: string;
  /** Unix seconds, or `-1` for a session cookie. */
  readonly expires: number;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: ImportCookieSameSite;
  /**
   * CHIPS-partitioned (Chromium `top_frame_site_key`), or a Firefox
   * container / private-window cookie (`originAttributes`). Electron's jar has
   * no partition key, so such a cookie has no home there: importing it would
   * make it readable from the top-level sites it was scoped out of.
   */
  readonly partitioned: boolean;
  readonly secret: ImportCookieSecret;
}

/** The whole of one source, as read; nothing decided yet. */
export interface ImportCookieRows {
  readonly rows: readonly ImportCookieRow[];
}
