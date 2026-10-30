import fs from "node:fs";
import path from "node:path";

import { BetaError } from "./core.mjs";

export const PRESENTATION_PRESETS = {
  balanced: {
    content_density: "medium",
    metric_detail: "selective",
    product_explanation: "standard",
    next_steps_tone: "collaborative",
  },
  executive: {
    content_density: "low",
    metric_detail: "selective",
    product_explanation: "concise",
    next_steps_tone: "direct",
  },
  consultative: {
    content_density: "medium",
    metric_detail: "selective",
    product_explanation: "expanded",
    next_steps_tone: "collaborative",
  },
  operational: {
    content_density: "high",
    metric_detail: "detailed",
    product_explanation: "standard",
    next_steps_tone: "action_oriented",
  },
};

export const LOCKED_PRESENTATION_CONTROLS = [
  "zendesk_brand_and_accessibility",
  "internal_human_review_warning",
  "metric_and_chart_integrity",
  "subscription_entitlement_disclosure",
  "source_provenance",
  "private_draft_status",
  "text_fit_and_alignment",
  "maintained_slide_integrity",
];

const ENUMS = {
  content_density: new Set(["low", "medium", "high"]),
  metric_detail: new Set(["selective", "detailed"]),
  product_explanation: new Set(["concise", "standard", "expanded"]),
  next_steps_tone: new Set(["direct", "collaborative", "action_oriented"]),
};
const ALLOWED_KEYS = new Set(["preset", ...Object.keys(ENUMS)]);

function validateInput(input = {}) {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new BetaError("UNSUPPORTED_PRESENTATION_PREFERENCE", `${key} is not an approved presentation preference.`);
    }
  }
  const preset = input.preset || "balanced";
  if (!PRESENTATION_PRESETS[preset]) {
    throw new BetaError("INVALID_PRESENTATION_PRESET", "Use balanced, executive, consultative, or operational.");
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (input[key] !== undefined && !allowed.has(input[key])) {
      throw new BetaError("INVALID_PRESENTATION_PREFERENCE", `${key} has an unsupported value.`);
    }
  }
  return { preset, ...PRESENTATION_PRESETS[preset], ...input };
}

export function effectivePresentationPreferences(input = {}) {
  const values = validateInput(input);
  return {
    schema_version: "1.0",
    preset: values.preset,
    content_density: values.content_density,
    metric_detail: values.metric_detail,
    product_explanation: values.product_explanation,
    next_steps_tone: values.next_steps_tone,
    locked_controls: [...LOCKED_PRESENTATION_CONTROLS],
  };
}

export function readPresentationPreferences(filePath) {
  if (!fs.existsSync(filePath)) return effectivePresentationPreferences();
  const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const { schema_version: _schemaVersion, updated_at: _updatedAt, ...preferences } = stored;
  return effectivePresentationPreferences(preferences);
}

export function writePresentationPreferences(filePath, input, now = new Date()) {
  const effective = effectivePresentationPreferences(input);
  const stored = { ...effective, locked_controls: undefined, updated_at: now.toISOString() };
  delete stored.locked_controls;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return effective;
}

export function resetPresentationPreferences(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return effectivePresentationPreferences();
}

export function planCasePresentation(caseRecord, { overrides = {}, testerId, now = new Date() }) {
  if (caseRecord.tester_id !== testerId) {
    throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  }
  if (caseRecord.feedback) {
    throw new BetaError("CASE_ALREADY_REVIEWED", "Presentation style cannot change after feedback is prepared.");
  }
  const updated = structuredClone(caseRecord);
  updated.presentation_plan = effectivePresentationPreferences(overrides);
  updated.revision += 1;
  updated.approvals = [];
  updated.status = "in_review";
  updated.updated_at = now.toISOString();
  return updated;
}
