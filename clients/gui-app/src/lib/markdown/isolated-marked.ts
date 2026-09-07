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
 * The shape `@tiptap/markdown` accepts for its `marked` option: the module object (`typeof marked`), not a `Marked` instance.
 */
export type MarkedModule = typeof marked;

/**
 * Private `marked` module stand-in so Tiptap tokenizer registrations die with the editor instead of leaking on the singleton.
 * Adapter (not `new Marked()`): the option is typed `typeof marked`.
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
    // The real module exposes the statics `Parser.parse` / `Lexer.lex` here (callers pass options explicitly); mirrored with the same generic signatures rather than routed through the private instance.
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
    // `marked.parse` IS the module object (`marked.parse = marked`), so the member is self-referential and cannot be named inside its own initializer; the real module is a type-correct placeholder that the next statement replaces before anything can observe it.
    parse: marked,
  });
  isolated.parse = isolated;
  return isolated;
}
