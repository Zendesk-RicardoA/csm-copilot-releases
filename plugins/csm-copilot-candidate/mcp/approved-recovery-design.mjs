const CONTRACT_VERSION = "1.0";
const DESIGN_FAMILY = "journey-b-approved-design-v3";
const RECOVERY_FAMILY = DESIGN_FAMILY;

const DIRECT_ROLES = [
  "cover", "agenda", "what_was_heard", "baseline", "volume_trend", "speed_quality_trend",
  "peer_comparison", "investigation_focus", "plan_overview", "maintained_explore",
  "maintained_sla", "maintained_knowledge", "measurement_plan", "next_steps",
  "closing_summary", "resource_library", "close",
];
const PHASE_VARIANTS = ["phase_1", "phase_2", "phase_3", "phase_4"];
const SUPPORTING_METRIC_VARIANTS = ["phase_1", "phase_3"];
const IMMUTABLE_ROLES = new Set([
  "agenda", "resource_library", "close",
]);
const REQUIRED_FIELDS = {
  cover: ["cover_title", "presentation_period"],
  what_was_heard: ["main_goal", "pain_1_title", "pain_1_body", "pain_2_title", "pain_2_body", "pain_3_title", "pain_3_body"],
  baseline: [
    "baseline_title", "baseline_subtitle", "baseline_metric_1_label", "baseline_metric_1_value",
    "baseline_metric_2_label", "baseline_metric_2_value", "baseline_metric_3_label", "baseline_metric_3_value",
    "baseline_metric_4_label", "baseline_metric_4_value", "baseline_chart_title", "baseline_insight_title",
    "baseline_insight_body", "baseline_metric_1_context", "baseline_metric_2_context", "baseline_metric_4_context",
    "baseline_bar_1", "baseline_period_1", "baseline_bar_2", "baseline_period_2", "baseline_bar_3", "baseline_period_3",
    "baseline_bar_4", "baseline_period_4", "baseline_bar_5", "baseline_period_5", "baseline_bar_6", "baseline_period_6",
    "baseline_plan_summary",
  ],
  volume_trend: ["volume_trend_title", "volume_trend_subtitle", "volume_trend_series"],
  speed_quality_trend: ["speed_quality_trend_title", "speed_quality_trend_subtitle", "frt_series", "csat_series"],
  peer_comparison: [
    "peer_title", "peer_subtitle", "peer_header_metric", "peer_header_current", "peer_header_average",
    "peer_header_top_performer", "peer_metric_1", "peer_current_1", "peer_average_1", "peer_top_performer_1", "peer_delta_1",
    "peer_metric_2", "peer_current_2", "peer_average_2", "peer_top_performer_2", "peer_delta_2", "peer_metric_3",
    "peer_current_3", "peer_average_3", "peer_top_performer_3", "peer_delta_3", "peer_insight_1", "peer_insight_2",
    "peer_insight_3", "peer_insight_4", "peer_insight_5",
  ],
  investigation_focus: ["investigation_title", "investigation_subtitle", "investigation_focus", "investigation_body", "investigation_scope", "investigation_decision_note"],
  plan_overview: ["roadmap_title", "roadmap_summary", "phase_1_action", "phase_1_outcome", "phase_2_action", "phase_2_outcome", "phase_3_action", "phase_3_outcome", "phase_4_action", "phase_4_outcome"],
  phase_detail: ["phase_number", "phase_title", "phase_objective", "phase_focus", "phase_success", "phase_next_step"],
  supporting_metric: ["support_title", "support_subtitle", "support_method_note", "metric_1_label", "metric_1_value", "metric_2_label", "metric_2_value", "support_insight", "support_measure", "support_takeaway"],
  measurement_plan: [
    "measurement_title", "measurement_subtitle", "measurement_method_note", "measurement_header_metric",
    "measurement_header_baseline", "measurement_header_target", "measurement_header_cadence", "measurement_metric_1",
    "measurement_baseline_1", "measurement_target_1", "measurement_cadence_1", "measurement_metric_2",
    "measurement_baseline_2", "measurement_target_2", "measurement_cadence_2", "measurement_metric_3",
    "measurement_baseline_3", "measurement_target_3", "measurement_cadence_3",
  ],
  next_steps: ["next_actions_title", "next_actions_subtitle", "next_action_1_owner", "next_action_1", "next_action_2_owner", "next_action_2", "next_action_3_owner", "next_action_3", "next_action_4_owner", "next_action_4"],
  closing_summary: [
    "closing_summary_title", "summary_phase_1_number", "summary_phase_1_title", "summary_phase_1_outcome", "summary_phase_1_resource", "summary_phase_1_timeframe",
    "summary_phase_2_number", "summary_phase_2_title", "summary_phase_2_outcome", "summary_phase_2_resource", "summary_phase_2_timeframe",
    "summary_phase_3_number", "summary_phase_3_title", "summary_phase_3_outcome", "summary_phase_3_resource", "summary_phase_3_timeframe",
    "summary_phase_4_number", "summary_phase_4_title", "summary_phase_4_outcome", "summary_phase_4_resource", "summary_phase_4_timeframe",
    "shared_direction_label", "shared_direction",
  ],
};

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertFingerprint(value, label) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value || "")) {
    fail("INVALID_APPROVED_DESIGN_FINGERPRINT", `${label} must be an exact SHA-256 fingerprint.`);
  }
}

function sameKeys(left, right) {
  const a = Object.keys(left || {}).sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function approvedRolePaths() {
  return [
    ...DIRECT_ROLES,
    ...PHASE_VARIANTS.map((variant) => `phase_detail.variants.${variant}`),
    ...SUPPORTING_METRIC_VARIANTS.map((variant) => `supporting_metric.variants.${variant}`),
  ];
}

export function roleSources(roles, prefix = "", result = {}) {
  Object.entries(roles || {}).forEach(([role, source]) => {
    const path = prefix ? `${prefix}.${role}` : role;
    if (!source) return;
    if (source.variants) {
      roleSources(source.variants, `${path}.variants`, result);
      return;
    }
    if (source.nativeSlideId) result[path] = source.nativeSlideId;
  });
  return result;
}

function fieldsFor(binding, source, label) {
  const fields = binding.slides?.[source?.nativeSlideId]?.fields;
  if (!source?.nativeSlideId || !fields) {
    fail("RECOVERY_ROLE_UNBOUND", `${label} does not resolve to a bound native source.`);
  }
  return fields;
}

function requireFields(binding, source, label, required) {
  const fields = fieldsFor(binding, source, label);
  const missing = required.filter((field) => !Object.hasOwn(fields, field));
  if (missing.length) fail("RECOVERY_FIELD_UNBOUND", `${label} is missing required semantic fields: ${missing.join(", ")}.`);
  return fields;
}

function validateSeries(fields, label, names) {
  const unbound = names.filter((name) => fields[name]?.renderer !== "series");
  if (unbound.length) {
    fail("RECOVERY_SERIES_UNBOUND", `${label} needs complete data-bound series mappings: ${unbound.join(", ")}.`);
  }
}

function validateBinding(binding) {
  if (binding?.recoveryFamily !== RECOVERY_FAMILY || !binding.roles || !binding.slides) {
    fail("RECOVERY_BINDING_REQUIRED", "A complete approved Customer Planning and Meeting Prep v3 template binding is required.");
  }
  if (binding.strictFieldCoverage !== true) {
    fail("RECOVERY_STRICT_FIELD_COVERAGE_REQUIRED", "The approved Customer Planning and Meeting Prep v3 binding requires strict semantic-field coverage.");
  }
  assertFingerprint(binding.contentFingerprint, "Approved v3 design presentation fingerprint");
  if (!sameKeys(binding.roles, [...DIRECT_ROLES, "phase_detail", "supporting_metric"])) {
    fail("RECOVERY_ROLE_MAP_MISMATCH", "The binding must contain exactly the approved Customer Planning and Meeting Prep v3 native roles.");
  }

  const sourceIds = [];
  DIRECT_ROLES.forEach((role) => {
    const source = binding.roles[role];
    if (!source || source.variants || !source.nativeSlideId) {
      fail("RECOVERY_ROLE_UNBOUND", `${role} needs exactly one bound native source.`);
    }
    sourceIds.push(source.nativeSlideId);
    const fields = fieldsFor(binding, source, role);
    if (["maintained_explore", "maintained_sla", "maintained_knowledge"].includes(role)) {
      // Fields are captured from the real native template, not a borrowed role.
      if (Object.values(fields).some(field => field.renderer !== "text" || !field.selector || !Number.isInteger(field.maxCharacters) || field.maxCharacters < 1)) {
        fail("RECOVERY_FIELD_UNBOUND", `${role} needs captured native text fields and capacity.`);
      }
      return;
    }
    if (IMMUTABLE_ROLES.has(role)) {
      if (Object.keys(fields).length) fail("IMMUTABLE_SLIDE_FIELD_EXPOSED", `${role} is an immutable maintained source and cannot expose semantic fields.`);
      return;
    }
    requireFields(binding, source, role, REQUIRED_FIELDS[role] || []);
    if (role === "volume_trend") validateSeries(fields, role, ["volume_trend_series"]);
    if (role === "speed_quality_trend") validateSeries(fields, role, ["frt_series", "csat_series"]);
  });

  const variantRequirements = [
    ["phase_detail", PHASE_VARIANTS, REQUIRED_FIELDS.phase_detail],
    ["supporting_metric", SUPPORTING_METRIC_VARIANTS, REQUIRED_FIELDS.supporting_metric],
  ];
  variantRequirements.forEach(([role, expectedVariants, required]) => {
    const container = binding.roles[role];
    if (!container?.variants || !sameKeys(container.variants, expectedVariants)) {
      fail("RECOVERY_VARIANT_MAP_MISMATCH", `${role} must contain exactly the approved Customer Planning and Meeting Prep v3 variants.`);
    }
    expectedVariants.forEach((variant) => {
      const source = container.variants[variant];
      if (!source || source.variants || !source.nativeSlideId) {
        fail("RECOVERY_ROLE_UNBOUND", `${role}.${variant} needs exactly one bound native source.`);
      }
      sourceIds.push(source.nativeSlideId);
      requireFields(binding, source, `${role}.${variant}`, required);
    });
  });

  const uniqueIds = new Set(sourceIds);
  if (sourceIds.length !== 23 || uniqueIds.size !== 23 || !sameKeys(binding.slides, uniqueIds)) {
    fail("RECOVERY_SLIDE_INVENTORY_MISMATCH", "The approved Customer Planning and Meeting Prep v3 binding requires exactly 23 distinct bound native slides.");
  }
}

/**
 * This is the only owner approval write for a visual family. It records no
 * Drive IDs, customer facts, source text, or presenter data—only approved
 * visual fingerprints and semantic role paths.
 */
export function createApprovedRecoveryDesign(binding) {
  validateBinding(binding);
  const sources = roleSources(binding.roles);
  const roleFingerprints = {};
  const witnessedSlides = {};
  Object.entries(sources).forEach(([rolePath, slideId]) => {
    const fingerprint = binding.slides?.[slideId]?.contentFingerprint;
    assertFingerprint(fingerprint, `Approved source ${rolePath}`);
    if (witnessedSlides[slideId] && witnessedSlides[slideId] !== fingerprint) {
      fail("APPROVED_DESIGN_ROLE_COLLISION", `${slideId} has incompatible source fingerprints.`);
    }
    witnessedSlides[slideId] = fingerprint;
    roleFingerprints[rolePath] = fingerprint;
  });
  if (!sameKeys(binding.slides, Object.keys(witnessedSlides))) {
    fail("UNWITNESSED_APPROVED_SLIDE", "Every bound native source slide needs an approved role witness.");
  }
  return {
    contractVersion: CONTRACT_VERSION,
    designFamily: DESIGN_FAMILY,
    presentationFingerprint: binding.contentFingerprint,
    roleFingerprints,
  };
}

/**
 * Validates the ID-free contract retained by the beta control plane. Source
 * slide IDs and semantic-field bindings are intentionally absent: they are
 * captured only inside the approved private Apps Script runtime at execution.
 */
export function validateApprovedRecoveryDesignContract(approvedDesign) {
  if (approvedDesign?.contractVersion !== CONTRACT_VERSION || approvedDesign?.designFamily !== DESIGN_FAMILY) {
    fail("APPROVED_DESIGN_CONTRACT_REQUIRED", "A versioned approved Customer Planning and Meeting Prep v3 design contract is required.");
  }
  assertFingerprint(approvedDesign.presentationFingerprint, "Approved v3 design presentation fingerprint");
  if (!sameKeys(approvedDesign.roleFingerprints || {}, approvedRolePaths())) {
    fail("APPROVED_DESIGN_ROLE_MISMATCH", "The approved design contract must cover every Customer Planning and Meeting Prep v3 role exactly once.");
  }
  Object.entries(approvedDesign.roleFingerprints).forEach(([rolePath, fingerprint]) => {
    assertFingerprint(fingerprint, `Approved source ${rolePath}`);
  });
  return {
    contractVersion: CONTRACT_VERSION,
    designFamily: DESIGN_FAMILY,
    presentationFingerprint: approvedDesign.presentationFingerprint,
    roleFingerprints: structuredClone(approvedDesign.roleFingerprints),
  };
}

export function applyApprovedRecoveryDesign(binding, approvedDesign) {
  validateBinding(binding);
  approvedDesign = validateApprovedRecoveryDesignContract(approvedDesign);
  if (binding.contentFingerprint !== approvedDesign.presentationFingerprint) {
    fail("APPROVED_DESIGN_PRESENTATION_MISMATCH", "The selected private source does not match the approved Customer Planning and Meeting Prep v3 design.");
  }
  const sources = roleSources(binding.roles);
  if (!sameKeys(sources, Object.keys(approvedDesign.roleFingerprints || {}))) {
    fail("APPROVED_DESIGN_ROLE_MISMATCH", "The selected private source does not expose the complete approved Customer Planning and Meeting Prep v3 role map.");
  }
  const slideFingerprints = {};
  Object.entries(sources).forEach(([rolePath, slideId]) => {
    const expected = approvedDesign.roleFingerprints[rolePath];
    const observed = binding.slides?.[slideId]?.contentFingerprint;
    assertFingerprint(expected, `Approved source ${rolePath}`);
    assertFingerprint(observed, `Selected source ${rolePath}`);
    if (observed !== expected) {
      fail("APPROVED_DESIGN_SLIDE_MISMATCH", `The selected source role ${rolePath} differs from the approved design.`);
    }
    if (slideFingerprints[slideId] && slideFingerprints[slideId] !== expected) {
      fail("APPROVED_DESIGN_ROLE_COLLISION", `${slideId} cannot satisfy multiple approved role fingerprints.`);
    }
    slideFingerprints[slideId] = expected;
  });
  if (!sameKeys(binding.slides, Object.keys(slideFingerprints))) {
    fail("UNWITNESSED_PRIVATE_SLIDE", "Every bound private source slide must be covered by the approved design contract.");
  }
  return {
    ...structuredClone(binding),
    approvedDesignContract: {
      contractVersion: CONTRACT_VERSION,
      designFamily: DESIGN_FAMILY,
      presentationFingerprint: approvedDesign.presentationFingerprint,
      slideFingerprints,
      roleFingerprints: structuredClone(approvedDesign.roleFingerprints),
    },
  };
}

export {
  CONTRACT_VERSION, DESIGN_FAMILY, RECOVERY_FAMILY, DIRECT_ROLES, PHASE_VARIANTS,
  SUPPORTING_METRIC_VARIANTS, IMMUTABLE_ROLES, REQUIRED_FIELDS, approvedRolePaths,
};
