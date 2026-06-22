/**
 * Platform-agnostic URI callback service for OAuth/auth redirects.
 * Implementations: VS Code UriHandler, CLI local HTTP server, etc.
 */
export interface IUriCallbackService {
  onUriCallback(handler: (uri: string) => void): Disposable;
  getUriScheme(): string;
}

export interface Disposable {
  dispose(): void;
}
