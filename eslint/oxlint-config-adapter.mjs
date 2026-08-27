function restrictedSyntaxOverrides(eslintConfig) {
  return eslintConfig.flatMap((entry) => {
    const rule = entry.rules?.["no-restricted-syntax"];
    if (
      !rule ||
      rule === "off" ||
      rule === 0 ||
      (Array.isArray(rule) && (rule[0] === "off" || rule[0] === 0))
    ) {
      return [];
    }
    if (entry.ignores) {
      throw new Error(
        "Oxlint cannot translate override-local ignores; add explicit later overrides for this partition.",
      );
    }

    return [
      {
        files: entry.files,
        rules: {
          "traycer/no-restricted-syntax": rule,
        },
      },
    ];
  });
}

export function adaptOxlintConfig({
  baseConfig,
  eslintConfig,
  jsPlugin,
  jsPlugins = [],
  additionalOverrides = [],
}) {
  return {
    ...baseConfig,
    jsPlugins: [jsPlugin, ...jsPlugins],
    overrides: [
      ...(baseConfig.overrides ?? []),
      ...restrictedSyntaxOverrides(eslintConfig),
      ...additionalOverrides,
    ],
  };
}
