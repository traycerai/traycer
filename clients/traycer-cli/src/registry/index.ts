export type {
  HostPlatformAsset,
  HostPlatformKey,
  HostVersionEntry,
  HostVersionsManifest,
  RegistryClient,
} from "./types";
export type { CreateRegistryClientOptions, RegistryTransport } from "./client";
export { createDefaultRegistryClient, createRegistryClient } from "./client";
export { currentHostPlatformKey } from "./platform-key";
export { resolveManifestUrl } from "./manifest-url";
export {
  parseHostVersionsManifest,
  parseHostVersionsManifestWithWarnings,
} from "./manifest-schema";
export type {
  HostVersionsManifestParseResult,
  ManifestParseWarning,
} from "./manifest-schema";
export { parseMinisignSignatureFile, verifyMinisignArchive } from "./minisign";
export { loadTrustedKeys, parseMinisignPublicKey } from "./trusted-keys";
export type { ParsedMinisignPublicKey, TrustedKeySet } from "./trusted-keys";
export type {
  ParsedMinisignSignature,
  VerifyMinisignArchiveOptions,
  VerifyMinisignArchiveResult,
} from "./minisign";
