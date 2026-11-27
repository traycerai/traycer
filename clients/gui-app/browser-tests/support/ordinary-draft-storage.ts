export interface OrdinaryDraftStorageFixture {
  beginTombstone(): Promise<void>;
  finishTombstone(): Promise<unknown>;
  stage(bytes: number, tag: number): Promise<readonly string[]>;
  recover(hashes: readonly string[]): Promise<readonly boolean[]>;
  quota(bytes: number): Promise<readonly boolean[]>;
}

declare global {
  interface Window {
    ordinaryDraftBrowser: OrdinaryDraftStorageFixture;
  }
}
