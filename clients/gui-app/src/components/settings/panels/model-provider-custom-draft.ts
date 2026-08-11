/**
 * The form model behind "Add custom provider" - an OpenAI-compatible endpoint
 * the user declares themselves.
 *
 * This is a DELIBERATE MIRROR of upstream's own dialog (`CustomProviderForm` /
 * `validateCustomProvider`, OpenCode desktop 1.18.2), extracted field for
 * field: same fields in the same order, same rules, same messages. An earlier
 * pass mirrored their predicates and then invented the form around them, which
 * is how a surface ends up looking like parity and behaving like something
 * else. Where a rule here looks looser than it "should" be, it is because
 * theirs is - the notes say so at each site.
 *
 * Pure, and separate from the dialog, for the usual two reasons: it is the part
 * worth testing directly, and a component module that exports non-components
 * loses fast refresh for the whole file.
 *
 * The npm package is NOT a field. Upstream fixes it to
 * `@ai-sdk/openai-compatible`, and a custom provider naming a different adapter
 * is not a thing this flow can honestly create.
 */

/**
 * Whether a row is already STORED in the provider's config.
 *
 * The write is a deep merge, so a stored row can be added to and changed but
 * never taken away: the payload has no way to say "delete this key", and the
 * two ways of trying are both worse than refusing. Sending a null model entry
 * is a 400; sending a null header value is accepted and stores the literal
 * null, poisoning a file the provider's own CLI reads.
 *
 * That makes removal impossible rather than merely unimplemented, and it makes
 * a KEY rename a removal wearing a rename - the merge adds the new key and
 * leaves the old one behind, so one edit yields two entries and an orphan
 * nothing can now delete. Hence the split the dialog renders: a locked row's
 * key is read-only, its value is not.
 *
 * False for every row created in the form, which is removable until it is
 * saved, and for both modes of a fresh declaration.
 */
type StoredRow = {
  readonly locked: boolean;
};

/** One model the endpoint serves. Upstream requires a display name per row. */
export type CustomProviderModelRow = StoredRow & {
  /** Stable identity for the list; never sent. */
  readonly row: string;
  readonly id: string;
  readonly name: string;
};

/** One extra request header - upstream's escape hatch for header-based auth. */
export type CustomProviderHeaderRow = StoredRow & {
  readonly row: string;
  readonly key: string;
  readonly value: string;
};

export type CustomProviderDraft = {
  readonly providerId: string;
  readonly name: string;
  readonly baseUrl: string;
  /** Optional. Also accepts upstream's `{env:VAR}` syntax - see below. */
  readonly apiKey: string;
  /**
   * Whether the key field has been EDITED in this session.
   *
   * Load-bearing on an edit. The field can hold at most one `{env:VAR}`
   * reference, but a config block may name several fallbacks - and rendering
   * only the first meant saving an untouched form silently dropped the rest.
   * While this is false the original array below is sent back verbatim; the
   * field is a proposal to REPLACE it, not a lossy mirror of it.
   */
  readonly apiKeyEdited: boolean;
  /** The env fallbacks this row arrived with. Empty when declaring. */
  readonly originalEnv: readonly string[];
  readonly models: readonly CustomProviderModelRow[];
  readonly headers: readonly CustomProviderHeaderRow[];
};

/** Errors for one two-column row, in column order. */
export type CustomProviderRowErrors = {
  readonly first: string | null;
  readonly second: string | null;
};

export type CustomProviderDraftErrors = {
  readonly providerId: string | null;
  readonly name: string | null;
  readonly baseUrl: string | null;
  readonly models: readonly CustomProviderRowErrors[];
  readonly headers: readonly CustomProviderRowErrors[];
};

/**
 * What a validated draft becomes on the wire.
 *
 * `key` and `env` are two readings of ONE field. Upstream treats an API key of
 * the form `{env:OPENAI_KEY}` as a REFERENCE rather than a secret: it goes into
 * the config block as `env: ["OPENAI_KEY"]` and no credential is stored. A
 * plain value is the secret itself. Both cannot be set at once, which is why
 * they are derived together.
 */
export type CustomProviderValues = {
  readonly modelProviderId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly { readonly id: string; readonly name: string }[];
  readonly headers: readonly {
    readonly key: string;
    readonly value: string;
  }[];
  /** The plaintext secret, or null when the field was empty or an env ref. */
  readonly key: string | null;
  /** Env var names the endpoint's key should be read from. */
  readonly env: readonly string[];
};

/**
 * Row identity for the list, counted rather than generated.
 *
 * `Math.random()` and `Date.now()` are unavailable in some of the environments
 * this runs in, and a list key only has to be distinct - upstream's own
 * `row-${row++}` is the same trick.
 */
let rowCounter = 0;
function nextRowId(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

export function emptyCustomProviderModelRow(): CustomProviderModelRow {
  return { row: nextRowId(), id: "", name: "", locked: false };
}

export function emptyCustomProviderHeaderRow(): CustomProviderHeaderRow {
  return { row: nextRowId(), key: "", value: "", locked: false };
}

/**
 * A blank draft. Both row lists start with ONE empty row, like upstream's - an
 * empty list would render a section whose only content is its Add button.
 */
export function emptyCustomProviderDraft(): CustomProviderDraft {
  return {
    providerId: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    apiKeyEdited: false,
    originalEnv: [],
    models: [emptyCustomProviderModelRow()],
    headers: [emptyCustomProviderHeaderRow()],
  };
}

/** The draft for editing a declaration that already exists. */
export function customProviderDraftFrom(
  values: CustomProviderValues,
): CustomProviderDraft {
  return {
    providerId: values.modelProviderId,
    name: values.name,
    baseUrl: values.baseUrl,
    // A STORED secret is never read back - credentials are write-only on this
    // surface - so the field starts empty and leaves the stored key alone
    // unless something is typed.
    //
    // A SINGLE env reference is shown, because it is not a secret and the field
    // can represent it exactly. SEVERAL cannot be shown in one field at all, so
    // the field stays empty and `originalEnv` carries them - showing `env[0]`
    // alone is what dropped `env[1]` on save.
    apiKey: values.env.length === 1 ? `{env:${values.env[0]}}` : "",
    apiKeyEdited: false,
    originalEnv: values.env,
    // The rows that came off the config are LOCKED; the blank row substituted
    // for an empty list is not one of them - nothing is stored under it, so
    // there is nothing the merge could orphan.
    models:
      values.models.length === 0
        ? [emptyCustomProviderModelRow()]
        : values.models.map((model) => ({
            row: nextRowId(),
            id: model.id,
            name: model.name,
            locked: true,
          })),
    headers:
      values.headers.length === 0
        ? [emptyCustomProviderHeaderRow()]
        : values.headers.map((header) => ({
            row: nextRowId(),
            key: header.key,
            value: header.value,
            locked: true,
          })),
  };
}

/**
 * Upstream's id rule, verbatim: `/^[a-z0-9][a-z0-9-_]*$/`.
 *
 * UNDERSCORES ARE LEGAL after the first character. Ours banned them, which
 * refused ids the host accepts and condemned existing declarations that already
 * used one. The leading-character class is also what makes `__proto__` fail
 * this on its own, so the hazard needs no separate rule on the minting path.
 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

/**
 * The one id no path may send, checked where the pattern does not run.
 *
 * The host answers it with `invalid_input`. Reachable only through an EXISTING
 * declaration, since the minting pattern rejects it outright.
 */
const FORBIDDEN_PROVIDER_ID = "__proto__";

/** Upstream's `{env:VAR}` reference, verbatim. */
const ENV_REFERENCE_PATTERN = /^\{env:([^}]+)\}$/;

/**
 * The id proposed from a typed name.
 *
 * A Traycer addition - upstream makes you type the id yourself. A suggestion,
 * not a rule: the field stays editable, and once touched we stop tracking the
 * name, because re-deriving would overwrite what was typed on the next
 * keystroke. Dashes rather than underscores because that is what the catalog's
 * own ids look like; both are legal.
 */
export function suggestCustomProviderId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Which ids the form may mint, and how to judge one it was handed.
 *
 * `disabledIds` is not a courtesy. Upstream SKIPS the already-exists check for
 * an id sitting in `disabled_providers`, because re-declaring a disabled custom
 * provider is how their app re-enables it. Treating it as taken would block the
 * one flow that repairs a disabled row.
 *
 * `existing` says the id came off a row rather than out of this form, which
 * decides whether the minting pattern applies at all.
 */
export type CustomProviderIdScope = {
  readonly takenIds: readonly string[];
  readonly disabledIds: readonly string[];
  readonly existing: boolean;
};

/**
 * Two id policies, because there are two questions.
 *
 * MINTING an id is a house-style decision and the pattern is ours to impose -
 * it is upstream's pattern, and we are the ones proposing the value.
 *
 * An EXISTING id is not ours to judge. The user may have hand-written one into
 * `opencode.json`, and applying the minting pattern to it locked the row: no
 * re-enable, and an Edit whose id field is disabled, so the value being
 * complained about could not be changed.
 */
function providerIdError(
  id: string,
  scope: CustomProviderIdScope,
): string | null {
  if (id.length === 0) return "Provider ID is required";
  if (id === FORBIDDEN_PROVIDER_ID) return "That provider ID isn't allowed";
  if (scope.existing) return null;
  if (!PROVIDER_ID_PATTERN.test(id)) {
    return "Use lowercase letters, numbers, hyphens, or underscores";
  }
  if (scope.takenIds.includes(id) && !scope.disabledIds.includes(id)) {
    return "That provider ID already exists";
  }
  return null;
}

/**
 * Upstream's base-URL rule, verbatim: a PREFIX test, not a URL parse.
 *
 * Ours parsed with `new URL`, which rejects values their form accepts. Being
 * stricter than the thing we are mirroring is still being wrong - whether the
 * endpoint answers is not knowable from the string.
 */
function baseUrlError(baseUrl: string): string | null {
  if (baseUrl.length === 0) return "Base URL is required";
  if (!/^https?:\/\//.test(baseUrl)) {
    return "Must start with http:// or https://";
  }
  return null;
}

function requiredRowError(value: string, duplicate: boolean): string | null {
  if (value.length === 0) return "Required";
  return duplicate ? "Duplicate" : null;
}

/**
 * Per-row model errors. Ids are compared CASE-SENSITIVELY, because a model id
 * is sent to the endpoint verbatim and `GPT-4o` is not `gpt-4o` to it.
 *
 * A LOCKED row's key is not judged, for the same reason an existing provider id
 * is not: it came off the config rather than out of this form, the field is
 * read-only, and `opencode.json` is hand-editable - so a complaint there is one
 * the user cannot act on and would strand the only surface that can repair the
 * rest of the row. Its key still enters `seen`, so a NEW row colliding with it
 * is still flagged, on the row that can actually change.
 */
function modelRowErrors(
  rows: readonly CustomProviderModelRow[],
): readonly CustomProviderRowErrors[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const id = row.id.trim();
    const duplicate = seen.has(id);
    if (id.length > 0) seen.add(id);
    return {
      first: row.locked ? null : requiredRowError(id, duplicate),
      second: row.name.trim().length === 0 ? "Required" : null,
    };
  });
}

/**
 * Per-row header errors.
 *
 * A wholly empty row is SKIPPED rather than flagged: the list always carries a
 * blank row and the section is optional, so complaining about the row that is
 * simply unused would make every valid form invalid.
 *
 * Names are compared case-INSENSITIVELY - HTTP header names are, and two rows
 * differing only in case would silently collapse when written.
 */
function headerRowErrors(
  rows: readonly CustomProviderHeaderRow[],
): readonly CustomProviderRowErrors[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const key = row.key.trim();
    const value = row.value.trim();
    if (key.length === 0 && value.length === 0) {
      return { first: null, second: null };
    }
    const duplicate = seen.has(key.toLowerCase());
    if (key.length > 0) seen.add(key.toLowerCase());
    return {
      // Locked keys go unjudged - see {@link modelRowErrors}.
      first: row.locked ? null : requiredRowError(key, duplicate),
      second: value.length === 0 ? "Required" : null,
    };
  });
}

export function validateCustomProviderDraft(
  draft: CustomProviderDraft,
  scope: CustomProviderIdScope,
): CustomProviderDraftErrors {
  return {
    providerId: providerIdError(draft.providerId.trim(), scope),
    name: draft.name.trim().length === 0 ? "Display name is required" : null,
    baseUrl: baseUrlError(draft.baseUrl.trim()),
    models: modelRowErrors(draft.models),
    headers: headerRowErrors(draft.headers),
  };
}

export function hasCustomProviderDraftError(
  errors: CustomProviderDraftErrors,
): boolean {
  const rowBad = (row: CustomProviderRowErrors): boolean =>
    row.first !== null || row.second !== null;
  return (
    errors.providerId !== null ||
    errors.name !== null ||
    errors.baseUrl !== null ||
    errors.models.some(rowBad) ||
    errors.headers.some(rowBad)
  );
}

/**
 * The API key field as the two things it can be.
 *
 * `{env:VAR}` is a reference: the config block gets `env: ["VAR"]` and NO
 * credential is stored. Anything else non-empty is the secret itself.
 */
export function customProviderKeyOf(apiKey: string): {
  readonly key: string | null;
  readonly env: readonly string[];
} {
  const trimmed = apiKey.trim();
  const reference = ENV_REFERENCE_PATTERN.exec(trimmed);
  if (reference === null) {
    return { key: trimmed.length === 0 ? null : trimmed, env: [] };
  }
  const name = reference[1].trim();
  return { key: null, env: name.length === 0 ? [] : [name] };
}

/**
 * The validated draft as values, or null when it does not validate.
 *
 * Re-validates rather than trusting the caller's last render: the submit path
 * is the only place the values are read, so it is the only place worth being
 * sure at.
 */
export function customProviderValues(
  draft: CustomProviderDraft,
  scope: CustomProviderIdScope,
): CustomProviderValues | null {
  if (hasCustomProviderDraftError(validateCustomProviderDraft(draft, scope))) {
    return null;
  }
  // Untouched means UNCHANGED: send back exactly the fallbacks this row
  // arrived with, however many there were, and leave any stored secret alone.
  const credential = draft.apiKeyEdited
    ? customProviderKeyOf(draft.apiKey)
    : { key: null, env: draft.originalEnv };
  return {
    modelProviderId: draft.providerId.trim(),
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    models: draft.models.map((row) => ({
      id: row.id.trim(),
      name: row.name.trim(),
    })),
    // Only rows carrying BOTH halves are written - the trailing blank row is
    // not a header the endpoint should be sent.
    headers: draft.headers
      .map((row) => ({ key: row.key.trim(), value: row.value.trim() }))
      .filter((row) => row.key.length > 0 && row.value.length > 0),
    key: credential.key,
    env: credential.env,
  };
}

/**
 * What a declared custom row is currently declared WITH, ready to prefill the
 * edit form - or null for a row that is not a declared custom provider.
 *
 * Unvalidated on purpose. The read side of the wire is deliberately looser than
 * the write side: `opencode.json` is hand-editable, so a declared base URL may
 * be malformed. Refusing to carry those values would leave Edit - the only
 * surface that can fix them - with nothing to open.
 */
export function customProviderValuesOf(entry: {
  readonly id: string;
  readonly name: string;
  readonly custom: {
    readonly baseUrl: string;
    readonly models: readonly {
      readonly id: string;
      readonly name: string;
    }[];
    readonly headers: readonly {
      readonly key: string;
      readonly value: string;
    }[];
    readonly env: readonly string[];
  } | null;
}): CustomProviderValues | null {
  if (entry.custom === null) return null;
  return {
    modelProviderId: entry.id,
    name: entry.name,
    baseUrl: entry.custom.baseUrl,
    models: entry.custom.models,
    headers: entry.custom.headers,
    // The read side carries NO key, by design - credentials are write-only on
    // this surface. `null` here is what makes an edit leave the stored one
    // alone; it is not "there is no credential".
    key: null,
    env: entry.custom.env,
  };
}

/**
 * Whether a declared row could be re-enabled AS IS - no typing.
 *
 * False for a declaration the write side would reject (the hand-edited
 * `opencode.json` case). Offering a one-click re-enable there would send the
 * user's own broken values back and report a failure they had no chance to fix;
 * the row offers Edit instead, which opens the form on exactly what is wrong.
 */
export function canReenableCustomProvider(
  values: CustomProviderValues,
): boolean {
  return (
    customProviderValues(
      {
        providerId: values.modelProviderId,
        name: values.name,
        baseUrl: values.baseUrl,
        apiKey: "",
        apiKeyEdited: false,
        originalEnv: values.env,
        // Judged UNLOCKED, deliberately: this asks whether the write side would
        // accept these values, and locking would skip the very key checks that
        // question is about. The dialog locks rows to protect a stored key from
        // being orphaned by an edit; nothing is being edited here.
        models:
          values.models.length === 0
            ? [emptyCustomProviderModelRow()]
            : values.models.map((model) => ({
                row: model.id,
                id: model.id,
                name: model.name,
                locked: false,
              })),
        // The row's REAL headers, not a blank row. Re-enable sends
        // `updateCustom` with these, so judging viability without them judges a
        // different payload than the one that would go out.
        headers:
          values.headers.length === 0
            ? [emptyCustomProviderHeaderRow()]
            : values.headers.map((header) => ({
                row: header.key,
                key: header.key,
                value: header.value,
                locked: false,
              })),
      },
      // An EXISTING declaration, so its id is judged as one.
      { takenIds: [], disabledIds: [], existing: true },
    ) !== null
  );
}
