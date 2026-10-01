/**
 * Build-time gate: runs the full structural and schema-compatibility
 * validation over every static registry this package declares, and exits
 * non-zero naming each one that fails. It is the last step of the package's
 * `build`; CI runs the same check as `__tests__/static-registries.test.ts`.
 * See `static-registries.ts` for why this is not done at import.
 *
 *   bun run protocol/scripts/compat/validate-static-registries.ts
 */
import {
  STATIC_REGISTRIES,
  findStaticRegistryFailures,
} from "./static-registries";

const failures = findStaticRegistryFailures(STATIC_REGISTRIES);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(
      `static registry ${failure.name} (${failure.sourceFile}) failed full validation: ${failure.message}`,
    );
  }
  process.exit(1);
}

console.log(
  `validated ${STATIC_REGISTRIES.length} static registries: ${STATIC_REGISTRIES.map((entry) => entry.name).join(", ")}`,
);
