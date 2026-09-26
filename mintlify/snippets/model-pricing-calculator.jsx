import "/snippets/model-pricing-catalog.generated.js";

export const ModelPricingCalculator = () => {
  const catalog =
    typeof globalThis !== "undefined"
      ? globalThis.MODEL_PRICING_CATALOG
      : undefined;

  const [selectedSteps, setSelectedSteps] = React.useState(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("traycer-model-profile-custom");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed && typeof parsed === "object") {
            return parsed;
          }
        }
      } catch (e) {
        // Ignore localStorage/JSON errors and start with empty overrides.
      }
    }
    return {};
  });

  // Track which profile is actively selected (independent of model matching)
  const [activeProfile, setActiveProfile] = React.useState(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("traycer-model-profile-active");
        if (saved) {
          return saved;
        }
      } catch (e) {
        // Ignore localStorage errors and fall back to derived default profile.
      }
    }
    return null;
  });

  if (!catalog) {
    return <p style={{ opacity: 0.8 }}>Model catalog is unavailable.</p>;
  }

  const {
    creators = [],
    modelDescriptors = [],
    systemProfiles = {},
    profileOrder = [],
    defaultProfileId: catalogDefaultProfileId,
    featureRows: catalogFeatureRows = [],
    costReferenceSteps = {},
    reasoningMultipliersByCreator = {},
    tokenMixByCreator = {},
    longContext = { thresholdInputTokens: 200000, multiplier: 2 },
    platformAccessFee = 0.05,
  } = catalog;

  const getReasoningMultiplier = (descriptor) => {
    const creatorMultipliers =
      reasoningMultipliersByCreator[descriptor.creator] ??
      reasoningMultipliersByCreator["default"] ??
      {};
    return creatorMultipliers[descriptor.reasoning] ?? 1.0;
  };

  // What one prompt token and the output it generates cost, under the
  // creator's measured cache-hit share and output ratio. Mirrors
  // getBlendedTokenPrice in code-debug-server's cost-calculator.
  const blendedTokenPrice = (descriptor) => {
    const mix = tokenMixByCreator[descriptor.creator] ?? {
      cacheHitShare: 0,
      outputTokensPerPromptToken: 0,
    };
    const readMultiplier = descriptor.cacheReadMultiplier ?? 1.0;
    const writeMultiplier = descriptor.cacheWriteMultiplier ?? 1.0;
    return (
      mix.cacheHitShare * readMultiplier * descriptor.input +
      (1 - mix.cacheHitShare) * writeMultiplier * descriptor.input +
      mix.outputTokensPerPromptToken * descriptor.output
    );
  };

  const getOwnMarkup = (descriptor) => 1 + (descriptor.ownMarkup ?? 0);
  const featureRows = Array.isArray(catalogFeatureRows)
    ? catalogFeatureRows
    : [];

  if (featureRows.length === 0) {
    return <p style={{ opacity: 0.8 }}>No feature rows are available.</p>;
  }

  const descriptorById = Object.fromEntries(
    modelDescriptors.map((descriptor) => [descriptor.id, descriptor]),
  );

  const groupedDescriptors = {};
  for (const creator of creators) {
    groupedDescriptors[creator] = modelDescriptors.filter(
      (descriptor) => descriptor.creator === creator,
    );
  }

  const orderedProfileIds =
    profileOrder.length > 0 ? profileOrder : Object.keys(systemProfiles);
  const availableProfiles = orderedProfileIds
    .map((profileId) => {
      const profile = systemProfiles[profileId];
      if (!profile || !profile.steps) {
        return null;
      }
      return {
        ...profile,
        id: profile.id ?? profileId,
      };
    })
    .filter(Boolean);

  if (availableProfiles.length === 0) {
    return <p style={{ opacity: 0.8 }}>No model profiles are available.</p>;
  }

  const profileById = Object.fromEntries(
    availableProfiles.map((profile) => [profile.id, profile]),
  );

  const defaultProfileId =
    catalogDefaultProfileId && profileById[catalogDefaultProfileId]
      ? catalogDefaultProfileId
      : availableProfiles[0].id;

  const defaultProfile = profileById[defaultProfileId];

  // Save to localStorage whenever selections change
  const updateSelectedSteps = (newSteps, profileType = "custom") => {
    setSelectedSteps(newSteps);
    setActiveProfile(profileType);

    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("traycer-model-profile-active", profileType);
        if (profileType === "custom") {
          localStorage.setItem(
            "traycer-model-profile-custom",
            JSON.stringify(newSteps),
          );
        }
      } catch (e) {
        // Ignore localStorage errors
      }
    }
  };

  const loadCustomProfile = () => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("traycer-model-profile-custom");
        if (saved) {
          const parsed = JSON.parse(saved);
          updateSelectedSteps(parsed, "custom");
        }
      } catch (e) {
        // Ignore errors
      }
    }
  };

  const hasCustomProfile = () => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("traycer-model-profile-custom");
        return !!saved;
      } catch (e) {
        return false;
      }
    }
    return false;
  };

  const activeProfileId =
    activeProfile === "custom"
      ? "custom"
      : profileById[activeProfile]
        ? activeProfile
        : defaultProfileId;

  const formatReasoning = (reasoning) => {
    if (reasoning === "none") {
      return "No thinking";
    }
    return reasoning.toUpperCase();
  };

  const formatModelOption = (descriptor) => {
    return `${descriptor.name} (${formatReasoning(descriptor.reasoning)})`;
  };

  const formatProfileLabel = (profileName) => {
    return profileName.replace(/\s+profile$/i, "");
  };

  const safeMultiplier = (value) => {
    if (!Number.isFinite(value) || value <= 0) {
      return 1;
    }
    return value;
  };

  const rows = featureRows.map((feature) => {
    // Cost reference descriptor is the pricing baseline for this step.
    const referenceDescriptorId =
      costReferenceSteps[feature.id] ??
      defaultProfile.steps[feature.id] ??
      modelDescriptors[0]?.id;

    const fallbackDescriptorId =
      defaultProfile.steps[feature.id] ?? modelDescriptors[0]?.id;

    if (!fallbackDescriptorId) {
      return {
        ...feature,
        descriptor: {
          id: "",
          name: "Unavailable",
          creator: "",
          reasoning: "none",
          input: 1,
          output: 1,
        },
        estimatedCredits: feature.baseCredits,
      };
    }

    const selectedDescriptorId =
      selectedSteps[feature.id] ?? fallbackDescriptorId;
    const selectedDescriptor =
      descriptorById[selectedDescriptorId] ??
      descriptorById[fallbackDescriptorId];
    const referenceDescriptor =
      descriptorById[referenceDescriptorId] ??
      descriptorById[fallbackDescriptorId] ??
      selectedDescriptor;

    if (!selectedDescriptor || !referenceDescriptor) {
      return {
        ...feature,
        descriptor: {
          id: "",
          name: "Unavailable",
          creator: "",
          reasoning: "none",
          input: 1,
          output: 1,
        },
        estimatedCredits: feature.baseCredits,
      };
    }

    const modelFactor = safeMultiplier(
      blendedTokenPrice(selectedDescriptor) /
        blendedTokenPrice(referenceDescriptor),
    );
    const reasoningFactor = safeMultiplier(
      getReasoningMultiplier(selectedDescriptor) /
        getReasoningMultiplier(referenceDescriptor),
    );
    const multiplier =
      modelFactor * reasoningFactor * getOwnMarkup(selectedDescriptor);

    const modelBaseCost =
      feature.baseCredits > 0 ? feature.baseCredits - platformAccessFee : 0;
    const estimatedCredits =
      feature.baseCredits > 0
        ? modelBaseCost * multiplier + platformAccessFee
        : 0;

    return {
      ...feature,
      descriptor: selectedDescriptor,
      estimatedCredits,
      longContextCredits: estimatedCredits * longContext.multiplier,
    };
  });

  const formatTokenCount = (count) => `${Math.round(count / 1000)}K`;

  const profileButtonStyle = (isActive) => ({
    padding: "6px 14px",
    fontSize: 14,
    fontWeight: isActive ? 600 : 500,
    cursor: "pointer",
    border: "1px solid rgba(128, 128, 128, 0.2)",
    borderRadius: 4,
    background: isActive ? "rgba(128, 128, 128, 0.1)" : "transparent",
    color: "inherit",
    transition: "all 0.15s ease",
  });

  return (
    <div style={{ marginTop: 20, marginBottom: 24 }}>
      <div
        style={{
          marginBottom: 16,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span style={{ opacity: 0.7, fontSize: 14 }}>Profile:</span>
        {availableProfiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            style={profileButtonStyle(activeProfileId === profile.id)}
            onClick={() =>
              updateSelectedSteps({ ...profile.steps }, profile.id)
            }
            onMouseEnter={(e) =>
              activeProfileId !== profile.id &&
              (e.target.style.background = "rgba(128, 128, 128, 0.05)")
            }
            onMouseLeave={(e) =>
              activeProfileId !== profile.id &&
              (e.target.style.background = "transparent")
            }
          >
            {formatProfileLabel(profile.name)}
          </button>
        ))}
        {activeProfileId === "custom" ? (
          <span
            style={{
              padding: "6px 14px",
              fontSize: 14,
              fontWeight: 500,
              border: "1px solid rgba(128, 128, 128, 0.2)",
              borderRadius: 4,
              background: "rgba(128, 128, 128, 0.1)",
              opacity: 0.7,
            }}
          >
            Custom
          </span>
        ) : hasCustomProfile() ? (
          <button
            type="button"
            style={{
              padding: "6px 14px",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
              border: "1px solid rgba(128, 128, 128, 0.2)",
              borderRadius: 4,
              background: "transparent",
              color: "inherit",
              opacity: 0.6,
              transition: "all 0.15s ease",
            }}
            onClick={loadCustomProfile}
            onMouseEnter={(e) => {
              e.target.style.background = "rgba(128, 128, 128, 0.05)";
              e.target.style.opacity = 1;
            }}
            onMouseLeave={(e) => {
              e.target.style.background = "transparent";
              e.target.style.opacity = 0.6;
            }}
          >
            Custom
          </button>
        ) : null}
      </div>

      <div>
        <table>
          <thead>
            <tr>
              <th>Feature</th>
              <th>Model</th>
              <th>Credits</th>
              <th>Credits (long context)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.label}</strong>
                </td>
                <td>
                  <div style={{ position: "relative" }}>
                    <select
                      style={{
                        width: "100%",
                        padding: "6px 28px 6px 10px",
                        fontSize: 14,
                        border: "1px solid rgba(128, 128, 128, 0.2)",
                        borderRadius: 4,
                        background: "transparent",
                        color: "inherit",
                        cursor: "pointer",
                        appearance: "none",
                        WebkitAppearance: "none",
                        MozAppearance: "none",
                      }}
                      name={`model-${row.id}`}
                      aria-label={`${row.label} model`}
                      value={row.descriptor.id}
                      onChange={(event) => {
                        const nextModelId = event.target.value;
                        updateSelectedSteps({
                          ...selectedSteps,
                          [row.id]: nextModelId,
                        });
                      }}
                    >
                      {creators.map((creator) => (
                        <optgroup key={creator} label={creator.toUpperCase()}>
                          {groupedDescriptors[creator].map((descriptor) => (
                            <option key={descriptor.id} value={descriptor.id}>
                              {formatModelOption(descriptor)}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <span
                      style={{
                        position: "absolute",
                        right: 10,
                        top: "50%",
                        transform: "translateY(-50%)",
                        pointerEvents: "none",
                        opacity: 0.5,
                      }}
                    >
                      ▼
                    </span>
                  </div>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <code>{row.estimatedCredits.toFixed(3)}</code>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <code>{row.longContextCredits.toFixed(3)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ opacity: 0.7, fontSize: 14, marginTop: 8 }}>
          A request in which any model call exceeds{" "}
          {formatTokenCount(longContext.thresholdInputTokens)} input tokens is
          charged the long-context amount ({longContext.multiplier}× the
          credits).
        </p>
      </div>
    </div>
  );
};

export default ModelPricingCalculator;
