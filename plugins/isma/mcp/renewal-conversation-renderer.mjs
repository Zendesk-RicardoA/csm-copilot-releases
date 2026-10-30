import { assertNoPowerPointOutput } from "./presentation-output-policy.mjs";
import Native from "./approved-native-contract.js";

export const RENEWAL_CONVERSATION_RENDERER_BASELINE = "renewal-conversation-v3";
export const RENEWAL_CONVERSATION_DESIGN_FAMILY = "renewal-deck-layouts-v1";
export const RENEWAL_CUSTOMER_COPY_CONTRACT = Native.renewalCopyContract;
export const RENEWAL_CONVERSATION_DESIGN_CONTRACT = Object.freeze({
  contractVersion: "1.1",
  designFamily: RENEWAL_CONVERSATION_DESIGN_FAMILY,
  nativeRoles: ["progress", "opportunities", "focus"],
  maximumCardsPerSlide: 3,
  privateSpeakerNotes: true,
  output: "private_native_google_slides_draft",
});

/** The renewal renderer runs only while its own private template is active. */
export function activeRenewalTemplateBinding() {
  return {
    bindingMode: "active_private_renewal_template",
    designFamily: RENEWAL_CONVERSATION_DESIGN_FAMILY,
    sourceSlideIndexes: [0, 1, 2],
  };
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function assertRenewalConversationRendererRequest({ rendererBaseline, bridgeInput }) {
  if (rendererBaseline !== RENEWAL_CONVERSATION_RENDERER_BASELINE) {
    fail("RENEWAL_RENDERER_BASELINE_REQUIRED", "The Renewal Conversation Brief requires its separate three-slide renderer.");
  }
  assertNoPowerPointOutput(bridgeInput?.output || {});
  if (bridgeInput?.artifactKind !== "renewal_conversation_brief") {
    fail("RENEWAL_ARTIFACT_KIND_REQUIRED", "The renewal renderer accepts only a Renewal Conversation Brief.");
  }
  if (bridgeInput?.designContract?.designFamily !== RENEWAL_CONVERSATION_DESIGN_FAMILY) {
    fail("RENEWAL_DESIGN_CONTRACT_REQUIRED", "The separate three-role Renewal Conversation Brief design contract is required.");
  }
  const binding = bridgeInput?.templateBinding;
  if (binding?.bindingMode !== "active_private_renewal_template" || binding?.designFamily !== RENEWAL_CONVERSATION_DESIGN_FAMILY
    || !Array.isArray(binding?.sourceSlideIndexes) || binding.sourceSlideIndexes.join(",") !== "0,1,2") {
    fail("RENEWAL_LAYOUT_BINDING_REQUIRED", "Open the private Renewal Conversation Brief template and use its separate renderer to create this draft.");
  }
  const slides = bridgeInput?.reviewPackage?.customer_slides;
  if (bridgeInput?.reviewPackage?.customer_copy_contract !== RENEWAL_CUSTOMER_COPY_CONTRACT) {
    fail("RENEWAL_CUSTOMER_COPY_CONTRACT_REQUIRED", "The renewal renderer requires the reviewed customer-hero copy contract.");
  }
  if (!Array.isArray(slides) || slides.length !== 3 || slides.some((slide, index) => slide?.role !== RENEWAL_CONVERSATION_DESIGN_CONTRACT.nativeRoles[index])) {
    fail("RENEWAL_SLIDE_CONTRACT_INVALID", "The renewal draft must contain exactly progress, opportunities, and focus slides in that order.");
  }
  const [progress, opportunities, focus] = slides;
  if (!Array.isArray(progress.cards) || progress.cards.length < 1 || progress.cards.length > 3 || typeof progress.annual_point_of_view !== "string" || !progress.annual_point_of_view.trim()) {
    fail("RENEWAL_PROGRESS_CONTENT_INVALID", "The progress slide needs an annual point of view and one to three selected metric snapshots.");
  }
  if (!Array.isArray(opportunities.cards) || opportunities.cards.length < 1 || opportunities.cards.length > 3 || !Array.isArray(focus.cards) || focus.cards.length !== opportunities.cards.length) {
    fail("RENEWAL_CARD_SELECTION_REQUIRED", "A renewal draft needs one to three linked opportunities and the same number of focus recommendations.");
  }
  if (progress.cards.some((card) => !card?.headline || !card?.metric_comparison || !card?.why_it_matters)) {
    fail("RENEWAL_PROGRESS_CARD_INVALID", "Each progress card needs an outcome headline, exact metric comparison, and customer reason.");
  }
  if (opportunities.cards.some((card, index) => card?.number !== index + 1 || !card?.headline || !card?.what_the_data_shows || !card?.customer_impact_opportunity || card?.question_to_validate)) {
    fail("RENEWAL_OPPORTUNITY_CARD_INVALID", "Each opportunity needs its matching number, evidence, and customer impact. Validation questions belong only in private speaker notes.");
  }
  if (focus.cards.some((card, index) => card?.number !== index + 1 || Native.renewalFocusIssue(card))) {
    fail("RENEWAL_FOCUS_CARD_INVALID", "Each focus card needs one reviewed customer benefit supported by its selected Zendesk capability. Planning details belong in private CSM notes.");
  }
  const notes = bridgeInput?.reviewPackage?.private_speaker_notes;
  if (!Array.isArray(notes) || notes.length !== 3 || notes.some((note) => note?.audience !== "CSM only" || !Array.isArray(note?.validation_questions))) {
    fail("RENEWAL_SPEAKER_NOTES_REQUIRED", "Each renewal slide needs private CSM speaker notes and validation questions.");
  }
  if (Native.renewalFocusNotesIssue(focus.cards, notes[2])) {
    fail("RENEWAL_SPEAKER_NOTES_REQUIRED", "Keep each recommendation's reviewed evidence, practical step, supporting capability and expected outcome in its linked private notes.");
  }
  const serialized = JSON.stringify(slides);
  if (/\b(?:ARR|health|CTA owner|owner|Gainsight)\b/i.test(serialized)) {
    fail("RENEWAL_INTERNAL_FIELD_EXPOSED", "Customer slides must not include internal CTA, ownership, ARR, or health information.");
  }
  if (/\b(?:hypothesis|data-led|source state|explore this pattern together|CSM only)\b/i.test(serialized)) {
    fail("RENEWAL_CUSTOMER_WORDING_UNSAFE", "Customer slides must use direct customer language, not internal hypothesis or source wording.");
  }
  return true;
}
