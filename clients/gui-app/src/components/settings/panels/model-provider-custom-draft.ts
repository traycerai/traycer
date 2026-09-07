/** Mirroring their predicates while inventing the form around them would not be a mirror - a surface can
 * satisfy every rule and still behave like a different app. The npm package is not a field. */

/** The write is a deep merge, so a stored row can be added to and changed but never taken away: the payload has
 * no way to say "delete this key", and the two ways of trying are both worse than refusing. */
type StoredRow = {
  readonly locked: boolean;
};

export type CustomProviderModelRow = StoredRow & {
  /** Stable identity for the list; never sent. */
  readonly row: string;
  readonly id: string;
  readonly name: string;
};

export type CustomProviderHeaderRow = StoredRow & {
  readonly row: string;
  readonly key: string;
  readonly value: string;
};

export type CustomProviderDraft = {
  readonly providerId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Load-bearing on an edit, because the field is a proposal to replace the credential rather than a mirror of
   * it: it can hold at most one `{env:VAR}` reference, while a config block may name several fallbacks. */
  readonly apiKeyEdited: boolean;
  readonly models: readonly CustomProviderModelRow[];
  readonly headers: readonly CustomProviderHeaderRow[];
};

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

/** Upstream treats an API key of the form `{env:OPENAI_KEY}` as a reference rather than a secret: it goes into
 * the config block as `env: ["OPENAI_KEY"]` and no credential is stored. */
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
  /** The distinction exists because deleting the block's `env` key needs an explicit signal, which forces `[]` to
   * mean clear. */
  readonly env: readonly string[] | null;
};

/** `Math.random` and `Date.now` are unavailable in some of the environments this runs in, and a list key only
 * has to be distinct - upstream's own `row-${row++}` is the same trick. */
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

/** Both row lists start with one empty row, like upstream's - an empty list would render a section whose only
 * content is its Add button. */
export function emptyCustomProviderDraft(): CustomProviderDraft {
  return {
    providerId: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    apiKeyEdited: false,
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
    // A stored secret is never read back - credentials are write-only on this surface - so the field starts empty
    // and leaves the stored key alone unless something is typed.
    apiKey: values.env?.length === 1 ? `{env:${values.env[0]}}` : "",
    apiKeyEdited: false,
    // The rows that came off the config are locked; the blank row substituted for an empty list is not one of them
    // - nothing is stored under it, so there is nothing the merge could orphan.
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

/** The keys a provider's config actually declares right now, straight off the catalog - the authority on what
 * is stored, as opposed to what a form was opened with. */
export type StoredCustomKeys = {
  readonly models: readonly string[];
  readonly headers: readonly string[];
};

/** The locks a form opens with are provenance captured at that moment, and a write can land underneath them. */
export function relockCustomProviderDraft(
  draft: CustomProviderDraft,
  stored: StoredCustomKeys,
): CustomProviderDraft {
  const modelIds = new Set(stored.models);
  // HTTP header names are case-insensitive, so `x-org` and `X-Org` are the same
  // stored key - matching case-sensitively would leave one of them unlocked.
  const headerKeys = new Set(stored.headers.map((key) => key.toLowerCase()));
  const models = draft.models.map((row) =>
    row.locked || !modelIds.has(row.id.trim()) ? row : { ...row, locked: true },
  );
  const headers = draft.headers.map((row) =>
    row.locked || !headerKeys.has(row.key.trim().toLowerCase())
      ? row
      : { ...row, locked: true },
  );
  const changed = models.some((row, at) => row !== draft.models[at]);
  const headersChanged = headers.some((row, at) => row !== draft.headers[at]);
  if (!changed && !headersChanged) return draft;
  return { ...draft, models, headers };
}

/** Underscores are legal after the first character. Ours banned them, which refused ids the host accepts and
 * condemned existing declarations that already used one. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

/** The one id no path may send, checked where the pattern does not run. Reachable only through an existing
 * declaration, since the minting pattern rejects it outright. */
const FORBIDDEN_PROVIDER_ID = "__proto__";

const ENV_REFERENCE_PATTERN = /^\{env:([^}]+)\}$/;

/** A suggestion, not a rule: the field stays editable, and once touched we stop tracking the name, because
 * re-deriving would overwrite what was typed on the next keystroke. */
export function suggestCustomProviderId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Treating it as taken would block the one flow that repairs a disabled row. `existing` says the id came off a
 * row rather than out of this form, which decides whether the minting pattern applies at all. */
export type CustomProviderIdScope = {
  readonly takenIds: readonly string[];
  readonly disabledIds: readonly string[];
  readonly existing: boolean;
};

/** Two id policies, because there are two questions. */
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

/** Upstream's base-URL rule, verbatim: a prefix test, not a URL parse. */
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

/** A locked row's key is not judged, for the same reason an existing provider id is not: it came off the config
 * rather than out of this form, the field is read-only, and `opencode.json` is hand-editable. */
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

/** Names are compared case-insensitively - HTTP header names are, and two rows differing only in case would
 * silently collapse when written. */
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

/** `{env:VAR}` is a reference: the config block gets `env: ["VAR"]` and NO credential is stored. */
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

/** Re-validates rather than trusting the caller's last render: the submit path is the only place the values are
 * read, so it is the only place worth being sure at. */
export function customProviderValues(
  draft: CustomProviderDraft,
  scope: CustomProviderIdScope,
): CustomProviderValues | null {
  if (hasCustomProviderDraftError(validateCustomProviderDraft(draft, scope))) {
    return null;
  }
  // Untouched means untouched, in the wire's own word for it: `null` leaves the stored secret and every env
  // fallback exactly as they are, including the ones this single field could never have displayed.
  const credential = draft.apiKeyEdited
    ? customProviderKeyOf(draft.apiKey)
    : { key: null, env: null };
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

/** Refusing to carry those values would leave Edit - the only surface that can fix them - with nothing to open. */
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
    // The read side carries NO key, by design - credentials are write-only on this surface.
    key: null,
    env: entry.custom.env,
  };
}

/** False for a declaration the write side would reject (the hand-edited `opencode.json` case). */
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
        // Judged unlocked, deliberately: this asks whether the write side would accept these values, and locking would
        // skip the very key checks that question is about.
        models:
          values.models.length === 0
            ? [emptyCustomProviderModelRow()]
            : values.models.map((model) => ({
                row: model.id,
                id: model.id,
                name: model.name,
                locked: false,
              })),
        // The row's real headers, not a blank row. Re-enable sends `updateCustom` with these, so judging viability
        // without them judges a different payload than the one that would go out.
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
      // An existing declaration, so its id is judged as one.
      { takenIds: [], disabledIds: [], existing: true },
    ) !== null
  );
}
