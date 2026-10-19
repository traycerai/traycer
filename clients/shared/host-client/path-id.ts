/**
 * An id as a URL may carry it: one plain path segment. `encodeURIComponent`
 * leaves `.` and `..` alone and `new URL` resolves them as dot segments, so
 * an id that is not this shape is refused before a URL is built (as
 * `sandbox-control.ts` refuses a sandbox id). An environment id is read as
 * opaque within it: the `env_` form and the older uuid form both fit.
 */
export const PATH_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
