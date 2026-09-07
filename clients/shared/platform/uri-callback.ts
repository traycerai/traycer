export interface IUriCallbackService {
  onUriCallback(handler: (uri: string) => void): Disposable;
  getUriScheme(): string;
}

export interface Disposable {
  dispose(): void;
}
