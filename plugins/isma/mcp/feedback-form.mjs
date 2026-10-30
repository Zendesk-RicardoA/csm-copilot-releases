import { BetaError } from "./core.mjs";

const REQUIRED_FIELDS = [
  "case_id",
  "package_version",
  "renderer_baseline",
  "revision",
  "would_use",
  "saved_time",
  "biggest_improvement",
];
const OPTIONAL_TRANSLATION_FIELDS = [
  "language_review_status",
  "language_review_outcome",
  "translation_issue_categories",
];

function feedbackPreview(caseRecord) {
  if (!caseRecord.feedback) {
    throw new BetaError("FEEDBACK_NOT_PREPARED", "Prepare the three feedback answers first.");
  }
  return {
    case_id: caseRecord.case_id,
    package_version: caseRecord.package_version,
    renderer_baseline: caseRecord.renderer_baseline,
    revision: caseRecord.revision,
    would_use: caseRecord.feedback.would_use,
    saved_time: caseRecord.feedback.saved_time,
    biggest_improvement: caseRecord.feedback.biggest_improvement,
    language_review_status: caseRecord.language_review?.status || "not_applicable",
    language_review_outcome: caseRecord.language_review?.outcome || "not_applicable",
    translation_issue_categories: caseRecord.language_review?.issue_categories?.join(",") || "none",
  };
}

function validateConfiguredForm(config) {
  if (config?.enabled !== true) return false;
  if (config.mode !== "google_forms_prefill") {
    throw new BetaError("FEEDBACK_FORM_CONFIG_INVALID", "The feedback form mode is not supported.");
  }

  let url;
  try {
    url = new URL(config.responder_url);
  } catch {
    throw new BetaError("FEEDBACK_FORM_CONFIG_INVALID", "The feedback responder URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "docs.google.com" ||
    !/^\/forms\/d\/e\/[^/]+\/viewform$/.test(url.pathname)
  ) {
    throw new BetaError(
      "FEEDBACK_FORM_CONFIG_INVALID",
      "Use an HTTPS Google Forms responder URL, not an editor or response-sheet URL.",
    );
  }

  for (const field of REQUIRED_FIELDS) {
    if (!/^entry\.\d+$/.test(config.entries?.[field] || "")) {
      throw new BetaError(
        "FEEDBACK_FORM_CONFIG_INVALID",
        `The Google Forms entry mapping for ${field} is missing or invalid.`,
      );
    }
  }
  for (const field of OPTIONAL_TRANSLATION_FIELDS) {
    const entry = config.entries?.[field];
    if (entry !== undefined && entry !== "" && !/^entry\.\d+$/.test(entry)) {
      throw new BetaError(
        "FEEDBACK_FORM_CONFIG_INVALID",
        `The Google Forms entry mapping for ${field} is invalid.`,
      );
    }
  }
  return true;
}

export function prepareFeedbackForm(caseRecord, config) {
  const preview = feedbackPreview(caseRecord);
  if (!validateConfiguredForm(config)) {
    return {
      status: "configuration_required",
      feedback_preview: preview,
      prefilled_form_url: null,
      requires_user_submission: true,
      next_action: "Ask the beta owner to connect the approved private Google Form.",
    };
  }

  const url = new URL(config.responder_url);
  url.searchParams.set("usp", "pp_url");
  for (const field of REQUIRED_FIELDS) {
    url.searchParams.set(config.entries[field], String(preview[field]));
  }
  const translationFieldsConfigured = OPTIONAL_TRANSLATION_FIELDS.every((field) => /^entry\.\d+$/.test(config.entries?.[field] || ""));
  if (translationFieldsConfigured) {
    for (const field of OPTIONAL_TRANSLATION_FIELDS) {
      url.searchParams.set(config.entries[field], String(preview[field]));
    }
  }

  return {
    status: "ready_for_review",
    feedback_preview: preview,
    prefilled_form_url: url.toString(),
    requires_user_submission: true,
    next_action: "Review the pre-filled answers, then click Submit in Google Forms.",
    translation_review_delivery: translationFieldsConfigured
      ? "included_in_form"
      : "saved_in_private_case_only; add the three optional translation fields to the approved Form to collect it centrally",
  };
}

export function confirmFeedbackSubmitted(
  caseRecord,
  { revision, testerId, now = new Date() },
) {
  if (caseRecord.tester_id !== testerId) {
    throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  }
  if (revision !== caseRecord.revision) {
    throw new BetaError("STALE_CASE_REVISION", "The confirmation does not match the current case revision.");
  }
  if (!caseRecord.feedback || caseRecord.feedback.delivery_status !== "prepared") {
    throw new BetaError("FEEDBACK_NOT_PREPARED", "Prepare the feedback form before confirming submission.");
  }

  const updated = structuredClone(caseRecord);
  updated.feedback.delivery_status = "user_confirmed_submitted";
  updated.feedback.submitted_at = now.toISOString();
  updated.status = "complete";
  updated.updated_at = now.toISOString();
  return updated;
}
