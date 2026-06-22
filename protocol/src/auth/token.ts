/**
 * Auth wire response envelope types.
 *
 * Both `RefreshTokenResponse` and `ExchangeTokenResponse` are
 * registered records owned by `authRecordRegistry`. Their TypeScript
 * shapes are derived from the registered Zod schemas via
 * `RecordValue<>` and re-exported from `protocol/auth/registry.ts`.
 *
 * Consumers should `import type { RefreshTokenResponse, ExchangeTokenResponse }
 * from "@traycer/protocol/auth/registry"`. This module re-exports them
 * for backward compatibility but adds no new declarations.
 */
export type {
  ExchangeTokenResponse,
  RefreshTokenResponse,
} from "./registry";
