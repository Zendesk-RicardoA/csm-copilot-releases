import crypto from "node:crypto";

import { BetaError, initialJourneyState } from "./core.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const REVIEWED_CUSTOMER_LANGUAGES = new Set(["en", "es"]);
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const TRANSLATION_ISSUE_CATEGORIES = new Set([
  "meaning_changed",
  "product_term",
  "grammar_or_wording",
  "tone_or_formality",
  "locale_formatting",
  "mixed_language",
  "text_fit_or_layout",
  "other",
]);

export const REAL_BETA_REQUIRED_CONTROLS = [
  "company_identity",
  "read_only_zdp",
  "transcript_secondary_processing",
  "private_draft_google_scope",
  "approved_renderer_execution",
  "retention_policy",
  "operational_support",
];

export function validateRealBetaRuntime({ credentialState, manifest }) {
  if (credentialState?.mode !== "limited_beta") {
    throw new BetaError("REAL_BETA_NOT_CONFIGURED", "The private limited-beta runtime is not configured on this computer.");
  }
  if (manifest?.status !== "approved_for_limited_beta") {
    throw new BetaError("REAL_BETA_VERSION_NOT_APPROVED", "This package version is not approved for real limited-beta cases.");
  }
  const approvals = credentialState.organizational_controls || {};
  const missing = REAL_BETA_REQUIRED_CONTROLS.filter((key) => approvals[key] !== true);
  if (missing.length) {
    throw new BetaError("REAL_BETA_CONTROL_MISSING", "A required limited-beta control is not approved.", { missing });
  }
  return true;
}

function requireTrue(value, field) {
  if (value !== true) throw new BetaError("CALL_NOT_ELIGIBLE", `${field} must be explicitly confirmed.`);
}

function requireCustomerLanguageTag(language) {
  if (typeof language !== "string" || !LANGUAGE_TAG.test(language)) {
    throw new BetaError("INVALID_LANGUAGE", "Use a two- or three-letter language code, optionally followed by a region, such as en, es, fr, or pt-PT.");
  }
}

function languageReview(language) {
  const reviewed = REVIEWED_CUSTOMER_LANGUAGES.has(language);
  return {
    language,
    status: reviewed ? "reviewed" : "review_required",
    warning: reviewed ? null : {
      code: "LANGUAGE_REVIEW_REQUIRED",
      message: "This language has not been reviewed in the beta. Check meaning, product terms, dates and numbers, and text fit before using the draft.",
    },
    outcome: "not_reviewed",
    issue_categories: [],
    reviewed_at: null,
  };
}

export function createAuthorizedCase({ input, testerId, manifest, now = new Date(), caseId }) {
  if (!DIGEST.test(input.source_locator_digest || "")) {
    throw new BetaError("INVALID_SOURCE_DIGEST", "source_locator_digest must be a SHA-256 digest, not a raw call URL or identifier.");
  }
  requireCustomerLanguageTag(input.language);
  requireTrue(input.recording_present, "recording_present");
  const selectedCallOnly = input.selected_call_only === true;
  if (!selectedCallOnly) {
    requireTrue(input.transcript_processing_authorized, "transcript_processing_authorized");
    requireTrue(input.no_service_data, "no_service_data");
    requireTrue(input.no_sensitive_personal_data, "no_sensitive_personal_data");
    requireTrue(input.no_suspected_l5, "no_suspected_l5");
  }

  return newAuthorizedCase({ input, testerId, manifest, now, caseId, transcriptEligibility: {
    selected_by_csm: true,
    recording_present: true,
    secondary_processing_authorized: !selectedCallOnly,
    service_data_absent: !selectedCallOnly,
    sensitive_personal_data_absent: !selectedCallOnly,
    suspected_l5_absent: !selectedCallOnly,
  } });
}

/** Converge's capabilities are approved; do not fabricate content-safety or
 * recording checks from metadata, or require the legacy Snowflake questionnaire. */
export function createConvergeMeetingPrepCase({ sourceDigest, language, testerId, manifest, now = new Date(), caseId }) {
  if (!DIGEST.test(sourceDigest || "")) throw new BetaError("INVALID_SOURCE_DIGEST", "Use a source digest, not a raw call reference.");
  requireCustomerLanguageTag(language);
  return newAuthorizedCase({ input: { source_locator_digest: sourceDigest, language }, testerId, manifest, now, caseId,
    transcriptEligibility: { selected_by_csm: true, provider: "Converge", approval_basis: "approved_mcp_capabilities",
      secondary_processing_authorized: true } });
}

function newAuthorizedCase({ input, testerId, manifest, now, caseId, transcriptEligibility }) {
  const record = {
    schema_version: "1.0",
    case_id: caseId || crypto.randomUUID(),
    case_kind: "real_authorized",
    tester_id: testerId,
    package_version: manifest.package_version,
    renderer_baseline: manifest.renderer_baseline,
    source_locator_digest: input.source_locator_digest,
    language: input.language,
    language_review: languageReview(input.language),
    transcript_eligibility: transcriptEligibility,
    revision: 1,
    status: "in_review",
    approvals: [],
    feedback: null,
    presentation_plan: null,
    derived_evidence: null,
    artifact: null,
    journey_state: initialJourneyState(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  if (input.owner_assisted_test) record.owner_assisted_test = input.owner_assisted_test;
  return record;
}

/** A call choice creates the case; it never silently certifies call-content safety. */
export function authorizeSelectedCallProcessing(caseRecord, { revision, testerId, transcriptProcessingAuthorized, noServiceData, noSensitivePersonalData, noSuspectedL5, now = new Date() }) {
  if (caseRecord.tester_id !== testerId) throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  if (caseRecord.case_kind !== "real_authorized") throw new BetaError("INVALID_CASE_KIND", "Select an authorized meeting-prep case first.");
  if (caseRecord.revision !== revision) throw new BetaError("STALE_CASE_REVISION", "The selected case changed before transcript processing.");
  requireTrue(transcriptProcessingAuthorized, "transcript_processing_authorized");
  requireTrue(noServiceData, "no_service_data");
  requireTrue(noSensitivePersonalData, "no_sensitive_personal_data");
  requireTrue(noSuspectedL5, "no_suspected_l5");
  const updated = structuredClone(caseRecord);
  updated.transcript_eligibility = {
    ...updated.transcript_eligibility,
    secondary_processing_authorized: true,
    service_data_absent: true,
    sensitive_personal_data_absent: true,
    suspected_l5_absent: true,
    confirmed_at: now.toISOString(),
  };
  updated.revision += 1;
  updated.approvals = [];
  updated.updated_at = now.toISOString();
  return updated;
}

export function createAuthorizedJourneyACase({ input, testerId, manifest, now = new Date(), caseId }) {
  requireCustomerLanguageTag(input.language);
  const journeyState = initialJourneyState();
  journeyState.active_journey = "journey_a";
  journeyState.contexts.journey_a.status = "active";
  journeyState.contexts.journey_b.status = "not_started";
  const record = {
    schema_version: "1.0",
    case_id: caseId || crypto.randomUUID(),
    case_kind: "real_authorized_journey_a",
    tester_id: testerId,
    package_version: manifest.package_version,
    renderer_baseline: manifest.renderer_baseline,
    language: input.language,
    language_review: languageReview(input.language),
    portfolio_eligibility: {
      selected_by_authenticated_csm: true,
      read_only_authorized: true,
      draft_only: true,
      service_data_absent: true,
      sensitive_personal_data_absent: true,
      suspected_l5_absent: true,
    },
    revision: 1,
    status: "in_review",
    approvals: [],
    feedback: null,
    presentation_plan: null,
    derived_evidence: null,
    artifact: null,
    journey_state: journeyState,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  if (input.owner_assisted_test) record.owner_assisted_test = input.owner_assisted_test;
  return record;
}

export function recordLanguageReview(caseRecord, { outcome, issueCategories = [], testerId, now = new Date() }) {
  if (caseRecord.tester_id !== testerId) {
    throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  }
  if (!caseRecord.language_review) {
    throw new BetaError("LANGUAGE_REVIEW_NOT_AVAILABLE", "This case does not contain customer-facing language to review.");
  }
  if (!new Set(["reviewed_no_issue", "issues_found", "not_reviewed"]).has(outcome)) {
    throw new BetaError("INVALID_INPUT", "Choose reviewed_no_issue, issues_found, or not_reviewed for the language review.");
  }
  if (!Array.isArray(issueCategories) || issueCategories.some((category) => !TRANSLATION_ISSUE_CATEGORIES.has(category))) {
    throw new BetaError("INVALID_INPUT", "Use only the approved language-review issue categories.");
  }
  const categories = [...new Set(issueCategories)];
  if (outcome === "issues_found" && categories.length === 0) {
    throw new BetaError("INVALID_INPUT", "Choose at least one issue category when issues were found.");
  }
  if (outcome !== "issues_found" && categories.length > 0) {
    throw new BetaError("INVALID_INPUT", "Issue categories are allowed only when issues were found.");
  }
  const updated = structuredClone(caseRecord);
  updated.language_review = {
    ...updated.language_review,
    outcome,
    issue_categories: categories,
    reviewed_at: outcome === "not_reviewed" ? null : now.toISOString(),
  };
  updated.updated_at = now.toISOString();
  return updated;
}

export function bindDerivedEvidence(caseRecord, { digest, findingCount, warningCodes = [], testerId, now = new Date() }) {
  if (caseRecord.tester_id !== testerId) throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  if (caseRecord.case_kind !== "real_authorized") throw new BetaError("INVALID_CASE_KIND", "Derived evidence is available only for an authorized real case.");
  if (!DIGEST.test(digest || "")) throw new BetaError("INVALID_EVIDENCE_DIGEST", "Evidence must be bound by SHA-256 digest.");
  if (!Number.isInteger(findingCount) || findingCount < 0 || findingCount > 500) {
    throw new BetaError("INVALID_FINDING_COUNT", "finding_count must be an integer from 0 to 500.");
  }
  if (!Array.isArray(warningCodes) || warningCodes.some((code) => !/^[A-Z][A-Z0-9_]{2,63}$/.test(code))) {
    throw new BetaError("INVALID_WARNING_CODE", "warning_codes must contain only bounded machine-readable codes.");
  }
  const updated = structuredClone(caseRecord);
  updated.derived_evidence = {
    digest,
    finding_count: findingCount,
    warning_codes: [...new Set(warningCodes)],
    raw_transcript_retained: false,
    bound_at: now.toISOString(),
  };
  updated.revision += 1;
  updated.approvals = [];
  updated.status = "in_review";
  updated.updated_at = now.toISOString();
  return updated;
}

export function bindPrivateArtifact(caseRecord, { artifactRefDigest, auditRefDigest, testerId, now = new Date() }) {
  if (caseRecord.tester_id !== testerId) throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  if (caseRecord.account_ref_digest && (caseRecord.private_draft_authorization?.revision !== caseRecord.revision
    || caseRecord.private_draft_authorization.draft_review_digest !== caseRecord.draft_review?.digest)) {
    throw new BetaError("DRAFT_NOT_AUTHORIZED", "Authorize this exact reviewed revision through the private renderer before recording its artifact.");
  }
  if (!DIGEST.test(artifactRefDigest || "") || !DIGEST.test(auditRefDigest || "")) {
    throw new BetaError("INVALID_ARTIFACT_DIGEST", "Artifact and audit references must be SHA-256 digests.");
  }
  const updated = structuredClone(caseRecord);
  updated.artifact = {
    revision: caseRecord.revision,
    artifact_ref_digest: artifactRefDigest,
    audit_ref_digest: auditRefDigest,
    private_draft: true,
    customer_shared: false,
    bound_at: now.toISOString(),
  };
  updated.updated_at = now.toISOString();
  return updated;
}
