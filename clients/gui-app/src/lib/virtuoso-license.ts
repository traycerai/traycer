/**
 * Virtuoso MessageList license key, baked into the bundle at build time by Vite
 * (`VITE_VIRTUOSO_MESSAGE_LIST_LICENSE_KEY`). The GUI client is open source, so
 * the key ships in the build rather than being fetched from the cloud at
 * runtime through a host RPC.
 *
 * When the env var is unset - OSS checkouts and local builds without the secret -
 * this resolves to the empty string, which puts `<VirtuosoMessageListLicense>`
 * into its unlicensed trial mode (the list still renders, with Virtuoso's small
 * unlicensed watermark). There is no runtime availability gate.
 */
export const VIRTUOSO_MESSAGE_LIST_LICENSE_KEY =
  import.meta.env.VITE_VIRTUOSO_MESSAGE_LIST_LICENSE_KEY ?? "";
