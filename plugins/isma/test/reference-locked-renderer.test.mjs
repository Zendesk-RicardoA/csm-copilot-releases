import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReferenceLockedRendererRequest,
  RECOVERY_RENDERER_BASELINE,
} from "../mcp/reference-locked-renderer.mjs";
import {
  applyApprovedRecoveryDesign,
  createApprovedRecoveryDesign,
  validateApprovedRecoveryDesignContract,
  DIRECT_ROLES,
  IMMUTABLE_ROLES,
  PHASE_VARIANTS,
  REQUIRED_FIELDS,
  SUPPORTING_METRIC_VARIANTS,
} from "../mcp/approved-recovery-design.mjs";

const fingerprint = (character) => `sha256:${character.repeat(64)}`;

function fieldsFor(role) {
  const fields = {};
  for (const field of REQUIRED_FIELDS[role] || []) fields[field] = { renderer: "text" };
  if (role === "volume_trend") fields.volume_trend_series = { renderer: "series" };
  if (role === "speed_quality_trend") {
    fields.frt_series = { renderer: "series" };
    fields.csat_series = { renderer: "series" };
  }
  return fields;
}

function binding() {
  const roles = {};
  const slides = {};
  let sequence = 0;
  const add = (key, fields) => {
    sequence += 1;
    const nativeSlideId = `source-${sequence}`;
    slides[nativeSlideId] = { contentFingerprint: fingerprint("a"), fields };
    return { nativeSlideId };
  };
  DIRECT_ROLES.forEach((role) => {
    roles[role] = add(role, IMMUTABLE_ROLES.has(role) ? {} : fieldsFor(role));
  });
  roles.phase_detail = { variants: {} };
  PHASE_VARIANTS.forEach((variant) => {
    roles.phase_detail.variants[variant] = add(`phase_detail.${variant}`, fieldsFor("phase_detail"));
  });
  roles.supporting_metric = { variants: {} };
  SUPPORTING_METRIC_VARIANTS.forEach((variant) => {
    roles.supporting_metric.variants[variant] = add(`supporting_metric.${variant}`, fieldsFor("supporting_metric"));
  });
  return {
    recoveryFamily: "journey-b-approved-design-v3",
    strictFieldCoverage: true,
    contentFingerprint: fingerprint("f"),
    roles,
    slides,
  };
}

function request(overrides = {}) {
  const templateBinding = binding();
  const approved = createApprovedRecoveryDesign(templateBinding);
  return {
    rendererBaseline: RECOVERY_RENDERER_BASELINE,
    bridgeInput: { templateBinding: applyApprovedRecoveryDesign(templateBinding, approved) },
    ...overrides,
  };
}

test("accepts only a reference-locked recovery-v3 request", () => {
  assert.equal(assertReferenceLockedRendererRequest(request()), true);
});

test("rejects PPTX or PowerPoint output before the renderer receives a request", () => {
  const candidate = request();
  candidate.bridgeInput.output = { format: "pptx" };
  assert.throws(
    () => assertReferenceLockedRendererRequest(candidate),
    (error) => error.code === "PPTX_OUTPUT_PROHIBITED",
  );
});

test("accepts an ID-free sealed active-master capture request", () => {
  const approved = createApprovedRecoveryDesign(binding());
  const sealed = {
    bindingMode: "capture_active_private_master",
    recoveryFamily: "journey-b-approved-design-v3",
    strictFieldCoverage: true,
    approvedDesignContract: approved,
  };
  assert.equal(
    assertReferenceLockedRendererRequest({
      rendererBaseline: RECOVERY_RENDERER_BASELINE,
      bridgeInput: { templateBinding: sealed },
    }),
    true,
  );
});

test("sealed active-master capture contracts cannot omit approved roles", () => {
  const approved = createApprovedRecoveryDesign(binding());
  delete approved.roleFingerprints.cover;
  assert.throws(
    () => validateApprovedRecoveryDesignContract(approved),
    (error) => error.code === "APPROVED_DESIGN_ROLE_MISMATCH",
  );
});

test("rejects the retired v2 renderer before it emits a sidebar request", () => {
  assert.throws(
    () => assertReferenceLockedRendererRequest(request({ rendererBaseline: "recovery-v2" })),
    (error) => error.code === "RENDERER_BASELINE_RETIRED",
  );
});

test("rejects a legacy v2 role map before it emits a sidebar request", () => {
  const candidate = request();
  candidate.bridgeInput.templateBinding.recoveryFamily = "native-four-phase-v1";
  assert.throws(
    () => assertReferenceLockedRendererRequest(candidate),
    (error) => error.code === "RECOVERY_BINDING_REQUIRED",
  );
});

test("the owner cannot approve a sparse or unbound v3 visual binding", () => {
  const candidate = binding();
  delete candidate.roles.speed_quality_trend;
  assert.throws(
    () => createApprovedRecoveryDesign(candidate),
    (error) => error.code === "RECOVERY_ROLE_MAP_MISMATCH",
  );
});

test("the owner cannot approve trend slides without complete series mappings", () => {
  const candidate = binding();
  const trendSource = candidate.roles.speed_quality_trend.nativeSlideId;
  candidate.slides[trendSource].fields.frt_series = { renderer: "text" };
  assert.throws(
    () => createApprovedRecoveryDesign(candidate),
    (error) => error.code === "RECOVERY_SERIES_UNBOUND",
  );
});
