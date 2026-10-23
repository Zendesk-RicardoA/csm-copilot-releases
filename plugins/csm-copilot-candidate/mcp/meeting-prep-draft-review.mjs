import crypto from "node:crypto";
import { BetaError } from "./core.mjs";
import { REQUIRED_FIELDS } from "./approved-recovery-design.mjs";
import { validateMeetingPrepBuildContract, validateAvailableMetricDecisions } from "./meeting-prep-build-contract.mjs";
import { validateNativePreflight } from "./meeting-prep-native-preflight.mjs";
import Native from "./approved-native-contract.js";

const OPTIONAL_ROLES = ["baseline", "volume_trend", "speed_quality_trend", "peer_comparison", "measurement_plan", "supporting_metric:phase_1", "supporting_metric:phase_3"];
const REF = /^recommendation:[1-9][0-9]{0,2}$/;
export function canonicalDraftJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalDraftJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalDraftJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const draftDigest = (value) => crypto.createHash("sha256").update(canonicalDraftJson(value)).digest("hex");
// A source-reference refresh is not a change to a recommendation's wording.
// Provenance is still frozen in the complete review payload, and changed
// account evidence invalidates the evidence gate separately.
const recommendationMeaningDigest = (items) => draftDigest(items.map(({ provenance: _provenance, ...meaning }) => meaning));

export function recommendationRefs(refs) {
  if (!Array.isArray(refs) || !refs.length || refs.length > 50 || new Set(refs).size !== refs.length || refs.some((ref) => !REF.test(ref))) {
    throw new BetaError("RECOMMENDATION_REFERENCES_REQUIRED", "Give every reviewed recommendation a stable numbered reference; retain the full set in the customer plan.");
  }
  return [...refs];
}

/** Approval metadata can change after review. Meaning, array order, source snapshots,
 * optional slide decisions and rendering values cannot. Nothing here is persisted. */
function reviewPayload(input) {
  const copy = structuredClone(input);
  for (const key of ["presenterProfile", "reviewedCaseEvidence", "templateBinding", "mode", "output", "idempotencyKey", "outputReadiness", "assemblyAuthorization", "nativeReviewContract"]) delete copy[key];
  if (copy.customerContent) { delete copy.customerContent.approval; delete copy.customerContent.status; }
  if (copy.slideSelectionReview) {
    delete copy.slideSelectionReview.deckInputReview;
    delete copy.slideSelectionReview.assemblyEligible;
    for (const proposal of copy.slideSelectionReview.proposals || []) delete proposal.review;
  }
  return copy;
}

function approvalScopes(payload, inventory, order) {
  const selection = draftDigest({ master: inventory, proposals: payload.slideSelectionReview, bindings: payload.maintainedSlideBindings,
    alignment: payload.customerContent.alignmentCheck, recommendations: payload.customerContent.recommendations,
    phases: payload.customerContent.phases, metricPlan: payload.metricSlidePlan, selectionPlan:payload.selectionPlan,
    phasePlan: Object.fromEntries(Object.entries(payload.phaseSlidePlan || {}).map(([ref, plan]) => [ref, {
      maintainedReason: plan.maintainedReason, rationale: plan.rationale,
      generatedModules: plan.generatedModules.map(({ fields: _copy, ...context }) => context),
    }])),
  });
  const customer = draftDigest({ content: payload.customerContent, projection: payload.projection,
    metricPlan: payload.metricSlidePlan, metricExclusions: payload.metricExclusions, phasePlan: payload.phaseSlidePlan, selectionPlan:payload.selectionPlan,
    phaseSolutionRoles: payload.phaseSolutionRoles, order, selection });
  return { selection, customer };
}

export function optionalMetricSlidePlan(input) {
  const plan = input.metricSlidePlan;
  if (!plan || typeof plan !== "object" || Object.keys(plan).some((key) => !OPTIONAL_ROLES.includes(key))) {
    throw new BetaError("METRIC_SLIDE_PLAN_REQUIRED", "Review which metric slides have available, relevant evidence before approving customer content.");
  }
  for (const role of OPTIONAL_ROLES) {
    const decision = plan[role];
    if (!decision || Object.keys(decision).some((key) => !["include", "reason"].includes(key))
      || typeof decision.include !== "boolean" || !["available_relevant", "unavailable", "not_relevant"].includes(decision.reason)
      || decision.include !== (decision.reason === "available_relevant")) {
      throw new BetaError("METRIC_SLIDE_PLAN_INVALID", "Include metrics only when available and relevant; give an explicit reason for each omitted metric slide.");
    }
  }
  return structuredClone(plan);
}

export function meetingPrepSlideOrder(input) {
  const plan = optionalMetricSlidePlan(input);
  const phasePlan = reviewedPhaseSlidePlan(input);
  const order = ["cover", "agenda", "what_was_heard"];
  for (const role of ["baseline", "volume_trend", "speed_quality_trend", "peer_comparison"]) if (plan[role].include) order.push(role);
  order.push("investigation_focus", "plan_overview");
  for (const phase of input.customerContent.phases) {
    order.push(`phase_detail:phase_${phase.order}`);
    if ([1, 3].includes(phase.order) && plan[`supporting_metric:phase_${phase.order}`].include) order.push(`supporting_metric:phase_${phase.order}`);
    phasePlan[phase.phaseRefId].generatedModules.forEach((_, index) => order.push(`zendesk_enabler:phase_${phase.order}:${index + 1}`));
    const selected = selectedSlidesForPhase(input, phase.phaseRefId);
    selected.forEach((_, index) => order.push(`maintained_product:phase_${phase.order}${index ? `:${index + 1}` : ""}`));
  }
  if (plan.measurement_plan.include) order.push("measurement_plan");
  order.push("next_steps", "closing_summary", "resource_library", "close");
  return order;
}

function selectedSlidesForPhase(input, phaseRefId) {
  const briefIds = new Set((input.slideSelectionReview?.retrievalBriefs || []).filter(b => b.phaseRefId === phaseRefId).map(b => b.briefId));
  return (input.slideSelectionReview?.proposals || []).filter(p => p.selectionStatus === "selected" && briefIds.has(p.briefId));
}

/** Exact, reviewed explanatory modules reuse suitable approved native exemplars.
 * Layout/source authority stays sealed; relevance is decided before assembly.
 * The receipt retains hashes only, never this customer copy. */
export function reviewedPhaseSlidePlan(input, record = null) {
  const phases = input.customerContent.phases, plan = input.phaseSlidePlan;
  const invalid = () => { throw new BetaError("PHASE_SLIDE_PLAN_INVALID", "Review each phase's library relevance and exact generated narrative, with this case's evidence and recommendation references."); };
  if (plan && (typeof plan !== "object" || Array.isArray(plan) || Object.keys(plan).length !== phases.length
    || Object.keys(plan).some(ref => !phases.some(p => p.phaseRefId === ref)))) invalid();
  const result = {}, moduleIds = new Set(), titles = new Set(phases.map(p => normalizeTitle(p.title)));
  const caseRefs = record ? new Set([
    `evidence:account:${record.account_intelligence_core?.content_digest?.slice(0,32)}`,
    `evidence:call:${record.derived_evidence?.digest?.slice(0,32)}`,
  ]) : null;
  for (const phase of phases) {
    const selected = selectedSlidesForPhase(input, phase.phaseRefId);
    const decision = plan?.[phase.phaseRefId];
    if (!decision) {
      if (!selected.length) throw new BetaError("PHASE_SLIDE_PLAN_REQUIRED", "A phase may have no library slide. Record that relevance decision before content approval; do not add a slide merely to satisfy a count.");
      result[phase.phaseRefId] = { maintainedReason: "selected_relevant", rationale: "Legacy reviewed library selection", generatedModules: [] };
      continue;
    }
    if (Object.keys(decision).some(k => !["maintainedReason", "rationale", "generatedModules"].includes(k))
      || !["selected_relevant", "not_relevant", "no_matching_source"].includes(decision.maintainedReason)
      || typeof decision.rationale !== "string" || !decision.rationale.trim() || !Array.isArray(decision.generatedModules)) invalid();
    if (decision.maintainedReason === "selected_relevant" && !selected.length) throw new BetaError("MAINTAINED_SELECTION_REQUIRED", "The reviewed plan says a library slide was selected, but that exact selection is missing.");
    if (decision.maintainedReason !== "selected_relevant" && selected.length) invalid();
    const enablers = new Set((phase.zendeskEnablers || []).map(e => e.enablerId));
    for (const module of decision.generatedModules) {
      const template = Native.supportingTemplate(module?.templateNumber), role = template?.role;
      const schema = input.supportingTemplateInventory?.[module?.templateNumber];
      const fields = template?.nativeText ? Object.keys(schema?.fields || {}) : REQUIRED_FIELDS[role];
      if (!module || !template || !fields?.length || Object.keys(module).some(k => !["moduleRefId", "purpose", "enablerRefIds", "provenance", "fields", "templateNumber", "titleField", "narrativeKind"].includes(k))
        || !/^narrative:[a-zA-Z0-9_-]{1,64}$/.test(module.moduleRefId || "") || moduleIds.has(module.moduleRefId)
        || typeof module.purpose !== "string" || !module.purpose.trim()
        || !Array.isArray(module.enablerRefIds) || module.enablerRefIds.some(ref => !enablers.has(ref))
        || !Array.isArray(module.provenance?.evidenceIds) || !module.provenance.evidenceIds.length
        || caseRefs && module.provenance.evidenceIds.some(ref => !caseRefs.has(ref))
        || !Array.isArray(module.provenance?.meaningRefIds) || !module.provenance.meaningRefIds.length
        || module.provenance.meaningRefIds.some(ref => !(phase.provenance?.meaningRefIds || []).includes(ref))
        || !module.fields || Object.keys(module.fields).length !== fields.length
        || fields.some(field => typeof module.fields[field] !== "string" || !module.fields[field].trim())
        || template.nativeText && (!/^sha256:[a-f0-9]{64}$/.test(schema?.source_fingerprint || "") || !fields.includes(module.titleField))) invalid();
      const title = normalizeTitle(module.fields[template.nativeText ? module.titleField : Native.titleField(role)]);
      if (!title || titles.has(title)) invalid();
      moduleIds.add(module.moduleRefId); titles.add(title);
    }
    result[phase.phaseRefId] = structuredClone(decision);
  }
  return result;
}
function normalizeTitle(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function validateMaintainedSelection(input) {
  const selection = input.slideSelectionReview;
  const proposals = (selection?.proposals || []).filter((proposal) => proposal.selectionStatus === "selected");
  const briefs = selection?.retrievalBriefs || [];
  const bindings = input.maintainedSlideBindings || {};
  const phaseRefs = new Set(input.customerContent.phases.map(p => p.phaseRefId));
  for (const proposal of proposals) {
    const matches = briefs.filter(brief => brief.briefId === proposal.briefId && phaseRefs.has(brief.phaseRefId));
    if (matches.length !== 1) throw new BetaError("MAINTAINED_SELECTION_OVERFLOW", "Every selected library slide must belong to one reviewed phase.");
    const source = proposal.sourceSnapshot, binding = bindings[proposal.slideRef];
    if (!source?.nativeSlideId || !/^sha256:[a-f0-9]{64}$/.test(source.contentFingerprint || "") || !source.providerRevision
      || !binding?.presentationId || !binding.bindingRef
      || binding.nativeSlideId !== source.nativeSlideId || binding.contentFingerprint !== source.contentFingerprint
      || binding.providerRevision !== source.providerRevision || proposal.sourceEligibility?.audience !== "customer_facing"
      || proposal.sourceEligibility?.availability !== "active" || proposal.sourceEligibility?.structuralRole !== "customer_content"
      || proposal.sourceEligibility?.selectionMode === "context_only"
      || (proposal.sourceEligibility?.useCases || []).some((value) => ["internal_reference", "close"].includes(value))
      || (proposal.warnings || []).some((warning) => warning.severity === "blocking")
      || binding.bindingRef === input.templateBinding?.bindingRef) {
      throw new BetaError("MAINTAINED_SOURCE_MISMATCH", "The selected library slides need exact current source revisions, fingerprints and customer-facing eligibility.");
    }
    const eligibility = proposal.sourceEligibility, translation = eligibility.translation;
    if (eligibility.language !== input.customerContent.language && !(translation?.status === "approved"
      && translation.sourceLanguage === eligibility.language && translation.targetLanguage === input.customerContent.language
      && translation.textCoverage === "complete")) {
      throw new BetaError("MAINTAINED_LANGUAGE_MISMATCH", "Select slides in the customer language or review their complete translation before content approval.");
    }
  }
}

function validateIncludedFields(input, order) {
  if (!input.projection?.customerDisplayName || !input.projection?.presentationPeriod) {
    throw new BetaError("DRAFT_PROJECTION_INCOMPLETE", "Prepare the customer title and period before reviewing the exact slide copy.");
  }
  for (const item of order) {
    const [role, phase] = item.split(":"), fields = REQUIRED_FIELDS[role];
    if (!fields || role === "cover") continue;
    const projected = phase ? input.projection.phaseTemplateFields?.[phase.slice(6)]?.[role] : input.projection.templateFields?.[role];
    const missing = fields.filter((field) => {
      if(projected?.[field]===null && Native.optionalMetricField(field,role))return false;
      if (role === "speed_quality_trend" && ["frt_series", "csat_series"].includes(field)) {
        const data = input.projection.runtimeTrendData;
        const verified = [data?.frt?.values, data?.csat?.values].some((values) => Array.isArray(values) && values.filter((v) => typeof v === "number" && Number.isFinite(v)).length >= 2);
        return !verified && ![projected?.frt_series, projected?.csat_series].some((v) => v && typeof v === "object");
      }
      if (role === "volume_trend" && field === "volume_trend_series" && input.projection.runtimeTrendData?.volume) return false;
      const bar = /^baseline_bar_([1-6])$/.exec(field);
      if (role === "baseline" && bar && input.projection.baselineTrend?.periods?.[Number(bar[1])-1]?.missing === true) return false;
      return projected?.[field] == null || projected[field] === "";
    });
    if (missing.length) throw new BetaError("DRAFT_PROJECTION_INCOMPLETE", "Complete the included slide's exact copy and data, or omit an unavailable metric slide in its reviewed plan.", { role: item, missing_fields: missing });
    if(Native.optionalMetricOmissionIssue(role,projected,fields))throw new BetaError('PARTIAL_METRIC_REMOVAL','Omit an unavailable metric as one complete card or row, including its label and value.',{role:item});
  }
}

export function prepareMeetingPrepDraftReview(record, input, masterInventory, testerId) {
  if (record.tester_id !== testerId) throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  if (!record.approvals?.some((item) => item.gate === "recommendations" && item.revision === record.revision)) throw new BetaError("RECOMMENDATION_REVIEW_REQUIRED", "Approve the full recommendations before preparing customer-content review.");
  const content = input.customerContent;
  const expected = recommendationRefs(record.recommendation_review_package?.recommendation_refs);
  const actual = recommendationRefs((content?.recommendations || []).map((item) => item.recommendationRefId));
  if (canonicalDraftJson(actual) !== canonicalDraftJson(expected)) throw new BetaError("RECOMMENDATION_SET_CHANGED", "Carry every approved recommendation into customer content in its reviewed order.");
  if (!Array.isArray(content?.phases) || content.phases.length !== 4 || content.phases.some((phase, index) => phase.order !== index + 1)) {
    throw new BetaError("PHASE_PLAN_INVALID", "The approved design needs four ordered phases, not a generic slide outline.");
  }
  const covered = new Set(content.phases.flatMap((phase) => phase.provenance?.meaningRefIds || []));
  if (expected.some((ref) => !covered.has(ref))) throw new BetaError("RECOMMENDATION_NOT_IN_PLAN", "Map every approved recommendation to at least one phase; do not silently drop one.");
  if (masterInventory?.slide_count !== 23 || typeof masterInventory.provider_revision !== "string" || !masterInventory.provider_revision.trim()) {
    throw new BetaError("MASTER_INVENTORY_INCOMPATIBLE", "Read the current private master: the approved source requires 23 slides and a source revision. A personalization confirmation does not verify its structure.");
  }
  reviewedPhaseSlidePlan(input, record);
  validateMaintainedSelection(input);
  validateMeetingPrepBuildContract(input);
  validateAvailableMetricDecisions(record, input);
  const slideOrder = meetingPrepSlideOrder(input);
  validateIncludedFields(input, slideOrder);
  validateNativePreflight(input, slideOrder, masterInventory);
  // Case state retains hashes, not a provider's opaque runtime revision.
  const inventory = { slide_count: 23, revision_digest: draftDigest(masterInventory.provider_revision),
    supporting_templates_digest: draftDigest(masterInventory.supporting_templates || {}),
    native_fields_digest:draftDigest(masterInventory.native_fields),native_preflight_contract:Native.version };
  const payload = reviewPayload(input), digest = draftDigest({ input: payload, masterInventory: inventory });
  const scopes = approvalScopes(payload, inventory, slideOrder);
  const updated = structuredClone(record);
  if (record.draft_review?.digest && record.draft_review.digest !== digest) {
    if (record.draft_review.recommendations_digest !== recommendationMeaningDigest(content.recommendations)) {
      throw new BetaError("RECOMMENDATION_SET_CHANGED", "Recommendation wording changed after its review. Review a new recommendation package before approving the revised plan.");
    }
    updated.revision += 1;
    const retained = ["identity", "evidence", "recommendations"];
    if (record.draft_review.customer_review_digest === scopes.customer) retained.push("customer_content");
    if (record.draft_review.selection_digest === scopes.selection) retained.push("maintained_slides");
    updated.approvals = (updated.approvals || []).filter((item) => item.revision === record.revision && retained.includes(item.gate))
      .map((item) => ({ ...item, revision: updated.revision, carried_from_revision: record.revision }));
    updated.recommendation_review_package.revision = updated.revision;
    updated.status = "in_review";
    delete updated.artifact;
    delete updated.private_draft_authorization;
  }
  updated.draft_review = { digest, revision: updated.revision, master_inventory: inventory,
    recommendations_digest: recommendationMeaningDigest(content.recommendations),
    content_digest: draftDigest(payload.customerContent), customer_review_digest: scopes.customer, selection_digest: scopes.selection,
    native_preflight_contract: Native.version, source_fingerprint_contract: "native-source-sha256-v1",
    slide_order: slideOrder, metric_slide_plan: optionalMetricSlidePlan(input),
    phase_slide_plan_digest: draftDigest(reviewedPhaseSlidePlan(input, record)), raw_customer_content_retained: false };
  return updated;
}

export function requireFrozenMeetingPrepDraft(record, input) {
  const review = record.draft_review;
  if (!review || review.revision !== record.revision) throw new BetaError("DRAFT_REVIEW_REQUIRED", "Prepare and approve the exact customer content, slide sequence and library selections before creating a draft.");
  if (review.digest !== draftDigest({ input: reviewPayload(input), masterInventory: review.master_inventory })) {
    throw new BetaError("APPROVED_DRAFT_CHANGED", "The rendering input differs from the reviewed content or slide selections. Prepare a new revision and review the changes.");
  }
}

/** Present outstanding decisions once; this helper never records approval. */
export function meetingPrepDraftReviewPrompt(record) {
  const labels = { customer_content: "customer wording", maintained_slides: "slide choices" };
  const approved = new Set((record.approvals || []).filter(item => item.revision === record.revision).map(item => item.gate));
  const pending = Object.keys(labels).filter(gate => !approved.has(gate));
  const decision = pending.map(gate => labels[gate]).join(" and ");
  return { revision: record.revision, decisions: pending.map(gate => ({ gate, label: labels[gate] })),
    already_approved: Object.keys(labels).filter(gate => approved.has(gate)),
    suggested_reply: pending.length ? `Approve the ${decision}.` : null,
    prompt: pending.length ? `Review the ${decision} shown below. Approve ${pending.length === 1 ? "it" : "both"}, or tell me what to change.`
      : "The customer wording and slide choices are already approved. Do not ask for those reviews again.",
    next_action: pending.length ? "Record only explicitly approved, displayed decisions as separate ordered gates. One reply naming both decisions is enough; do not ask again between those records."
      : "Private-draft authorization is a separate decision for this reviewed revision; these approvals do not create a draft.",
    separate_draft_authorization_required: true, rendered_human_review_required: true };
}

export function reopenMeetingPrepRecommendationReview(record, { testerId, revision, requested, now = new Date() }) {
  if (record.tester_id !== testerId) throw new BetaError("CASE_OWNER_MISMATCH", "The case belongs to another tester.");
  if (record.revision !== revision) throw new BetaError("STALE_CASE_REVISION", "Use the current case revision.");
  if (requested !== true) throw new BetaError("REVIEW_REVISION_NOT_REQUESTED", "Reopen recommendations only when the CSM asks to revise them.");
  if (!record.account_ref_digest || !record.account_intelligence_core || !record.derived_evidence) {
    throw new BetaError("MEETING_PREP_EVIDENCE_INCOMPLETE", "The same-account brief and selected-call findings must remain bound.");
  }
  const updated = structuredClone(record);
  updated.revision += 1;
  updated.approvals = (updated.approvals || []).filter((item) => ["identity", "evidence"].includes(item.gate))
    .map((item) => ({ ...item, revision: updated.revision, carried_from_revision: record.revision }));
  for (const key of ["recommendation_review_package", "draft_review", "artifact", "private_draft_authorization"]) delete updated[key];
  updated.status = "in_review";
  updated.updated_at = now.toISOString();
  return updated;
}
