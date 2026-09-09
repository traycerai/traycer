import {
  Hooks,
  Lexer,
  Marked,
  Parser,
  Renderer,
  TextRenderer,
  Tokenizer,
  getDefaults,
  marked,
  type MarkedExtension,
  type MarkedOptions,
  type Token,
  type TokensList,
} from "marked";

/**
 * The shape `@tiptap/markdown` accepts for its `marked` option: the module
 * object (`typeof marked`), not a `Marked` instance.
 */
export type MarkedModule = typeof marked;

/**
 * A `marked` module object backed by its own private `Marked` instance.
 *
 * WHY THIS EXISTS. `@tiptap/markdown`'s `MarkdownManager` falls back to the
 * module-level `marked` singleton when no `marked` option is passed, and its
 * `registerTokenizer` calls `marked.use({ extensions: [...] })` once per
 * extension that declares a `markdownTokenizer` - with a closure that captures
 * the manager. Nothing ever unregisters them: `marked.use()` unshifts into the
 * singleton's `defaults.extensions.inline/block` arrays for the life of the
 * page. Every Tiptap editor ever created therefore stayed reachable from
 * module scope through its manager, its extension configs, and their option
 * closures (composer callbacks, the whole chat-messages render scope). The
 * 2026-09-03 staging heap snapshot measured 94 managers for 6 live editors and
 * 161 MB dominated by the singleton's defaults object.
 *
 * Passing an instance built here makes the registrations die with the editor:
 * the manager is the only thing that references this object, and the object
 * is the only thing that references the private `Marked`.
 *
 * WHY AN ADAPTER RATHER THAN `new Marked()`. The option is typed
 * `typeof marked` - a callable with the module's statics - and a `Marked`
 * instance is neither callable nor structurally assignable (it carries private
 * members). The manager itself only touches `use`, `defaults`, `Lexer` and
 * `setOptions`; the rest is filled in so the object is a complete, honest
 * module stand-in rather than a partial one hidden behind a cast. `defaults`
 * is re-read after every `use` / `setOptions` exactly as the real module does
 * (`Marked.use()` replaces `this.defaults` rather than mutating it), because
 * the manager constructs lexers with `new Lexer(markedInstance.defaults)`.
 *
 * One `marked` copy must resolve for both this package and `@tiptap/markdown`
 * (the catalog pins the same major Tiptap depends on) - with two copies the
 * classes come from separate declarations and this object would not type
 * against Tiptap's option.
 */
export function createIsolatedMarked(): MarkedModule {
  const instance = new Marked();

  function parse(
    src: string,
    options: MarkedOptions & { async: true },
  ): Promise<string>;
  function parse(
    src: string,
    options: MarkedOptions & { async: false },
  ): string;
  function parse(
    src: string,
    options: MarkedOptions | null | undefined,
  ): string | Promise<string>;
  function parse(
    src: string,
    options: MarkedOptions | null | undefined,
  ): string | Promise<string> {
    return instance.parse(src, options);
  }

  const setOptions = (options: MarkedOptions): MarkedModule => {
    instance.setOptions(options);
    isolated.defaults = instance.defaults;
    return isolated;
  };

  const use = (...extensions: MarkedExtension[]): MarkedModule => {
    instance.use(...extensions);
    isolated.defaults = instance.defaults;
    return isolated;
  };

  const isolated: MarkedModule = Object.assign(parse, {
    options: setOptions,
    setOptions,
    getDefaults,
    defaults: instance.defaults,
    use,
    walkTokens: instance.walkTokens.bind(instance),
    parseInline: instance.parseInline,
    Parser,
    // The real module exposes the statics `Parser.parse` / `Lexer.lex` here
    // (callers pass options explicitly); mirrored with the same generic
    // signatures rather than routed through the private instance.
    parser: <ParserOutput = string, RendererOutput = string>(
      tokens: Token[],
      options: MarkedOptions<ParserOutput, RendererOutput> | undefined,
    ): ParserOutput =>
      Parser.parse<ParserOutput, RendererOutput>(tokens, options),
    Renderer,
    TextRenderer,
    Lexer,
    lexer: <ParserOutput = string, RendererOutput = string>(
      src: string,
      options: MarkedOptions<ParserOutput, RendererOutput> | undefined,
    ): TokensList => Lexer.lex<ParserOutput, RendererOutput>(src, options),
    Tokenizer,
    Hooks,
    // `marked.parse` IS the module object (`marked.parse = marked`), so the
    // member is self-referential and cannot be named inside its own
    // initializer; the real module is a type-correct placeholder that the
    // next statement replaces before anything can observe it.
    parse: marked,
  });
  isolated.parse = isolated;
  return isolated;
}
