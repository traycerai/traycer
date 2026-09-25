import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLanguage,
  getOrCreateHighlighter,
  highlightCode,
  resetShikiHighlighterForTests,
} from "@/markdown/shiki-highlighter";

// Every assertion here is about what a FRESH core has fetched, so the
// singleton and its memoized grammar loads have to be dropped per test - the
// module keeps them for the process lifetime in production on purpose.
beforeEach(() => {
  resetShikiHighlighterForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetShikiHighlighterForTests();
});

describe("on-demand grammar loading", () => {
  it("boots the core with no grammars at all", async () => {
    const core = await getOrCreateHighlighter();

    // The whole point: the first code block used to pay for all 30 grammars.
    expect(core.getLoadedLanguages()).toEqual([]);
    // The theme pair is still eager - it is one chunk and every block needs it.
    expect(core.getLoadedThemes()).toHaveLength(2);
  });

  it("loads only the grammar the fence asked for", async () => {
    const core = await getOrCreateHighlighter();

    const readiness = ensureLanguage(core, "python");
    expect(readiness.state).toBe("loading");
    if (readiness.state !== "loading") return;
    await readiness.load;

    const langs = core.getLoadedLanguages();
    expect(langs).toContain("python");
    // Declared aliases still come registered with the grammar.
    expect(langs).toContain("py");
    // Nothing else in the curated set was pulled along.
    expect(langs).not.toContain("typescript");
    expect(langs).not.toContain("shellscript");
    expect(langs).not.toContain("json");
  });

  it("reports a loaded grammar as ready without fetching again", async () => {
    const core = await getOrCreateHighlighter();
    const readiness = ensureLanguage(core, "typescript");
    if (readiness.state !== "loading") throw new Error("expected a load");
    await readiness.load;

    const loadLanguage = vi.spyOn(core, "loadLanguage");

    expect(ensureLanguage(core, "typescript").state).toBe("ready");
    // An alias of an already-loaded grammar is ready too - shiki registers the
    // aliases, so `codeToHtml` takes them.
    expect(ensureLanguage(core, "ts").state).toBe("ready");
    expect(loadLanguage).not.toHaveBeenCalled();
    expect(highlightCode(core, "const a = 1;", "ts", "github-dark")).toContain(
      "<pre",
    );
  });

  it("shares one load between concurrent requests, aliases included", async () => {
    const core = await getOrCreateHighlighter();
    const loadLanguage = vi.spyOn(core, "loadLanguage");

    const first = ensureLanguage(core, "typescript");
    const viaAlias = ensureLanguage(core, "ts");
    const third = ensureLanguage(core, "mts");
    if (
      first.state !== "loading" ||
      viaAlias.state !== "loading" ||
      third.state !== "loading"
    ) {
      throw new Error("expected three in-flight loads");
    }

    // One fetch, one promise: a visible code block re-asks on every streamed
    // frame, and `ts`/`typescript` are the same grammar.
    expect(loadLanguage).toHaveBeenCalledTimes(1);
    expect(viaAlias.load).toBe(first.load);
    expect(third.load).toBe(first.load);

    await first.load;
    expect(core.getLoadedLanguages()).toContain("typescript");
  });

  it("treats an out-of-set language as unsupported and fetches nothing", async () => {
    const core = await getOrCreateHighlighter();
    const loadLanguage = vi.spyOn(core, "loadLanguage");

    expect(ensureLanguage(core, "haskell").state).toBe("unsupported");
    // Grammars that only ever arrived as another grammar's embedded dependency
    // are outside the curated set, and no longer highlight by accident.
    expect(ensureLanguage(core, "lua").state).toBe("unsupported");
    // Exact match, like the loaded-language check it replaced: an uppercase
    // fence info would not be usable even if its chunk were fetched.
    expect(ensureLanguage(core, "TS").state).toBe("unsupported");

    expect(loadLanguage).not.toHaveBeenCalled();
    expect(
      highlightCode(core, "main = pure ()", "haskell", "github-dark"),
    ).toBe(null);
  });

  it("answers plaintext infos from the core itself", async () => {
    const core = await getOrCreateHighlighter();
    const loadLanguage = vi.spyOn(core, "loadLanguage");

    for (const info of ["text", "txt", "plain", "plaintext"]) {
      expect(ensureLanguage(core, info).state).toBe("ready");
    }
    expect(loadLanguage).not.toHaveBeenCalled();
  });

  it("settles a failed grammar load without retrying it", async () => {
    const core = await getOrCreateHighlighter();
    const loadLanguage = vi
      .spyOn(core, "loadLanguage")
      .mockRejectedValue(new Error("chunk 404"));

    const readiness = ensureLanguage(core, "rust");
    if (readiness.state !== "loading") throw new Error("expected a load");
    // The load resolves either way; the loaded-language check is what decides.
    await expect(readiness.load).resolves.toBeUndefined();
    expect(core.getLoadedLanguages()).not.toContain("rust");

    // Memoized, like a failed theme pair: the block renders plain for the
    // session instead of re-fetching a dead chunk on every re-render.
    const again = ensureLanguage(core, "rust");
    expect(again.state).toBe("loading");
    expect(loadLanguage).toHaveBeenCalledTimes(1);
  });
});
