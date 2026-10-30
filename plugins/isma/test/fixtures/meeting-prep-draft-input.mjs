import { REQUIRED_FIELDS } from "../../mcp/approved-recovery-design.mjs";
import { meetingPrepDraftEvidenceRefs } from "../../mcp/meeting-prep-draft-binding.mjs";
import { expectedReleaseComponents } from "../../mcp/release-compatibility.mjs";

// Invented, self-contained packaged fixture. No external identifiers or reads.
export const OPTIONAL_METRIC_ROLES = ["baseline", "volume_trend", "speed_quality_trend", "peer_comparison", "measurement_plan", "supporting_metric:phase_1", "supporting_metric:phase_3"];
export const INVENTED_NATIVE_FIELDS = Object.fromEntries(Object.entries(REQUIRED_FIELDS).map(([role,fields])=>[role,
  Object.fromEntries(fields.filter(field=>!/_series$/.test(field) && !/^baseline_bar_/.test(field)).map(field=>[field,{widthPt:640,heightPt:84,fontSizePt:11,lineSpacingPct:100}]))]));
Object.assign(INVENTED_NATIVE_FIELDS.cover,{cover_title:{widthPt:381,heightPt:214,fontSizePt:40,lineSpacingPct:100},presentation_period:{widthPt:78,heightPt:20,fontSizePt:8,lineSpacingPct:100}});
Object.assign(INVENTED_NATIVE_FIELDS.investigation_focus,{
  investigation_title:{widthPt:540,heightPt:34,fontSizePt:24,lineSpacingPct:100},
  investigation_subtitle:{widthPt:610,heightPt:20,fontSizePt:11,lineSpacingPct:100},
  investigation_body:{widthPt:165,heightPt:45,fontSizePt:15,lineSpacingPct:100},
  investigation_scope:{widthPt:270,heightPt:110,fontSizePt:16,lineSpacingPct:100},
  investigation_decision_note:{widthPt:580,heightPt:16,fontSizePt:8.5,lineSpacingPct:100},
  investigation_focus:{widthPt:165,heightPt:107,fontSizePt:16,lineSpacingPct:100,textInsetPt:8,
    investigationArea:{contract:'investigation-left-area-v1',leftPt:65,topPt:155,widthPt:165,heightPt:107,
      sourceWidthPt:240,sourceHeightPt:240,maxBottomPt:262,pageWidthPt:720,pageHeightPt:405,textInsetPt:8,
      panel:{leftPt:40,topPt:115,widthPt:220,heightPt:220},body:{leftPt:65,topPt:270,widthPt:165,heightPt:45}}},
});
for(const number of [1,2,3,4]) INVENTED_NATIVE_FIELDS[`phase_detail:phase_${number}`]=structuredClone(INVENTED_NATIVE_FIELDS.phase_detail);
for(const number of [1,3]) INVENTED_NATIVE_FIELDS[`supporting_metric:phase_${number}`]=structuredClone(INVENTED_NATIVE_FIELDS.supporting_metric);
export const INVENTED_SUPPORTING_INVENTORY = Object.fromEntries([12,14,17].map(number=>[number,{
  source_fingerprint: `sha256:${"b".repeat(64)}`, fields: {
    native_text_title: {type:"text",max_characters:80,source_text:"Invented source title. ".padEnd(80," "),fit:{widthPt:640,heightPt:84,fontSizePt:11}},
    native_text_body: {type:"text",max_characters:240,source_text:"Invented source explanation. ".padEnd(240," "),fit:{widthPt:640,heightPt:84,fontSizePt:11}},
  },
}]));
for(const [number,role] of [[8,'investigation_focus'],[11,'supporting_metric'],[16,'supporting_metric']]) INVENTED_SUPPORTING_INVENTORY[number]={source_fingerprint:`sha256:${'b'.repeat(64)}`,fields:Object.fromEntries(Object.entries(INVENTED_NATIVE_FIELDS[role]).map(([field,fit])=>[field,{type:'text',fit}]))};
const components = expectedReleaseComponents();
export const INVENTED_MASTER_INVENTORY = { slide_count: 23, provider_revision: "invented-master-revision", supporting_templates: INVENTED_SUPPORTING_INVENTORY,
  native_fields: INVENTED_NATIVE_FIELDS,
  ...(components ? { renderer_components: { implementation_sha256: components.renderers.meeting_prep.implementation_sha256,
    native_contract: components.native_contract, native_fit_contract: components.native_fit_contract, renewal_layout_contract: components.renewal_layout_contract,
    peer_takeaway_layout_contract: components.peer_takeaway_layout_contract,
    investigation_layout_contract: components.investigation_layout_contract,
    narrative_selection_contract:components.narrative_selection_contract,metric_trend_contract:components.metric_trend_contract,
    renderer_baseline: components.renderer_baseline, master_contract_sha256: components.master_contract_sha256 } } : {}) };
export function inventedMeetingPrepDraft(record) {
  const refs = meetingPrepDraftEvidenceRefs(record);
  const provenance = (evidence, meaning = []) => ({ evidenceIds: [evidence], meaningRefIds: meaning });
  const recommendations = ["Classify and route repeat requests", "Improve knowledge coverage", "Pilot agent assistance", "Review measured progress"]
    .map((title, index) => ({ recommendationRefId: `recommendation:${index + 1}`, title, provenance: provenance(refs.account_brief) }));
  const phases = recommendations.map((recommendation, index) => ({
    order: index + 1, phaseRefId: `phase:${index + 1}`, title: recommendation.title,
    objective: "Make the next support action clearer.", actions: [{ text: "Review the chosen request types together." }],
    benefits: ["Clearer ownership and next steps."], zendeskEnablers: [], measureRefIds: [], resourceRefIds: [],
    provenance: provenance(refs.selected_call, [recommendation.recommendationRefId]),
  }));
  const content = { schemaVersion: "1.2.0", contentId: "content:invented-plan", revision: 1,
    sourceContract: { contractId: "contract:invented-plan", revision: 1 }, audience: "customer", language: "en",
    status: "content_approved", approval: { decision: "approved", sourceRevision: 1 }, title: "Support improvement plan",
    alignmentCheck: { mainGoal: { text: "Reduce avoidable effort", provenance: provenance(refs.selected_call) },
      painPoints: [{ text: "Unclear request routing", provenance: provenance(refs.selected_call) }] },
    recommendations, phases, successMeasures: [], resources: [],
  };
  const projection = { customerDisplayName: "Invented Orchard", presentationPeriod: "October 2026", deliveryStage: "meeting_draft",
    agenda_summary: 'Review the account evidence and the proposed support plan.',
    entitlementSnapshot: { reviewStatus: "approved", reviewedAt: "2026-10-07T10:00:00Z", currentPlans: [
      { status: "confirmed", productName: "Invented Support", planName: "Invented Plan", asOfDate: "2026-10-07", sourceRefIds: [refs.account_brief] },
    ], commercialExceptions: [] }, templateFields: {}, phaseTemplateFields: {} };
  for (const role of ["what_was_heard", "investigation_focus", "plan_overview", "next_steps", "closing_summary"]) {
    projection.templateFields[role] = Object.fromEntries(REQUIRED_FIELDS[role].map((field) => [field,
      /_resource$/.test(field) ? { text: "Invented resource", url: "https://example.invalid/resource" } : `Invented ${field.replaceAll("_", " ")}`]));
  }
  for (const phase of phases) projection.phaseTemplateFields[phase.order] = {
    phase_detail: { phase_number: String(phase.order), phase_title: phase.title, phase_objective: phase.objective,
      phase_focus: phase.actions[0].text, phase_success: phase.benefits[0], phase_next_step: "Agree a review date." },
  };
  Object.assign(projection.templateFields.closing_summary, { closing_summary_title: "Support plan", shared_direction_label: "Shared goal", shared_direction: "Reduce avoidable customer effort." });
  for (const n of [1,2,3,4]) Object.assign(projection.templateFields.closing_summary, {
    [`summary_phase_${n}_number`]: String(n), [`summary_phase_${n}_title`]: `Phase ${n}`,
    [`summary_phase_${n}_outcome`]: "Clearer next steps", [`summary_phase_${n}_timeframe`]: "Weeks 1–2",
    [`summary_phase_${n}_resource`]: {text:"Review guide",url:"https://example.invalid/guide"},
  });
  const bindings = {}, briefs = [], proposals = [];
  phases.forEach((phase) => {
    const ref = `library:invented:${phase.order}`, fingerprint = `sha256:${String(phase.order).repeat(64)}`;
    briefs.push({ briefId: `brief:${phase.order}`, phaseRefId: phase.phaseRefId });
    bindings[ref] = { bindingRef: "binding:invented-library", presentationId: "invented-library", nativeSlideId: `invented-slide-${phase.order}`,
      contentFingerprint: fingerprint, providerRevision: "invented-library-revision" };
    proposals.push({ proposalId: `proposal:${phase.order}`, briefId: `brief:${phase.order}`, slideRef: ref, selectionStatus: "selected",
      sourceSnapshot: { nativeSlideId: bindings[ref].nativeSlideId, contentFingerprint: fingerprint, providerRevision: "invented-library-revision" },
      sourceEligibility: { language: "en", audience: "customer_facing", availability: "active", structuralRole: "customer_content", selectionMode: "copy", useCases: [] },
      warnings: [], review: { decision: "approved" } });
  });
  const coverage = record.account_intelligence_core?.performance_coverage || {};
  return { bridgeVersion: "1.2.0", mode: "dry_run", manifestId: "deck-build.invented-plan", manifestRevision: 1,
    idempotencyKey: "build.invented-plan", outputReadinessRevision: 1,
    customerContent: content, projection,
    selectionPlan:{contract:'narrative-selection-v1',metrics:Object.fromEntries(OPTIONAL_METRIC_ROLES.map(role=>[role,{
      rationale:({baseline:'Show the reviewed starting point.',volume_trend:'Explain demand changes that affect the response improvement.',speed_quality_trend:'Track the response and quality outcomes of the support plan.',peer_comparison:'Put the response and quality gaps in context.',measurement_plan:'Agree how to review progress.'})[role] || 'Review the evidence for this phase before choosing its next step.',
      provenance:provenance(refs.account_brief,['recommendation:1']),
    }]))},
    metricSlidePlan: Object.fromEntries(OPTIONAL_METRIC_ROLES.map((role) => [role, { include: false, reason: coverage[role] ? "not_relevant" : "unavailable" }])),
    metricExclusions: Object.fromEntries(Object.entries(coverage).filter(([,available])=>available).map(([role])=>[role,"This invented scenario tests a call-led plan; the CSM reviewed this metric and chose not to include it."])),
    outputReadiness: { resolvedMode: "customer_plan", readinessStatus: "customer_plan_ready", customerDeliveryEligible: true, customerContentRef: content.contentId },
    slideSelectionReview: { outputMode: "customer_plan", language: "en", assemblyEligible: true,
      customerContentRef: { contentId: content.contentId, revision: content.revision }, retrievalBriefs: briefs, proposals,
      deckInputReview: { decision: "approved", decidedAt: "2026-10-07T10:00:00Z", customerFacts: "approved",
        metricsAndDefinitions: "approved", goalsAndPainPoints: "approved", recommendationFit: "approved", slideApplicability: "approved" } },
    maintainedSlideBindings: bindings,
    supportingTemplateInventory: structuredClone(INVENTED_SUPPORTING_INVENTORY),
    phaseSlidePlan: Object.fromEntries(phases.map(phase => [phase.phaseRefId, {
      maintainedReason: "selected_relevant", rationale: "The reviewed source explains this phase's customer outcome.", generatedModules: [],
    }])),
    phaseSolutionRoles: Object.fromEntries(phases.map((phase, index) => [phase.phaseRefId, index === 0 ? "operational_foundation" : index === 3 ? "future_horizon" : "active_recommendation"])),
    assemblyAuthorization: { authorizationRef: "authorization:invented-plan", approvedAt: "2026-10-07T10:00:00Z" },
    output: { name: "Invented Orchard — Private draft", folderId: null },
    presenterProfile: { schemaVersion: "1.0", profileRef: "presenter_0123456789abcdefabcd", displayName: "Invented CSM", jobTitle: "Customer Success Manager", personalizedMasterConfirmed: true, photoPersonalizedConfirmed: true },
  };
}

export function omitInventedLibrary(input, order) {
  const phase = input.customerContent.phases[order - 1];
  input.slideSelectionReview.proposals.filter(p => p.briefId === `brief:${order}`).forEach(p => {
    p.selectionStatus = "rejected"; p.review = { decision: "rejected" }; delete input.maintainedSlideBindings[p.slideRef];
  });
  input.phaseSlidePlan[phase.phaseRefId].maintainedReason = "not_relevant";
  input.phaseSlidePlan[phase.phaseRefId].rationale = "The existing workflow makes generic installation guidance redundant.";
}
export function addInventedNarrative(input, order, suffix = "workflow") {
  const phase = input.customerContent.phases[order - 1];
  const module = { moduleRefId: `narrative:${order}-${suffix}`, purpose: "Explain the customer-specific handoff so the deck stands alone.",
    templateNumber: 8, narrativeKind:'investigation',
    enablerRefIds: [], provenance: { evidenceIds: phase.provenance.evidenceIds, meaningRefIds: phase.provenance.meaningRefIds },
    fields: { investigation_title: `Keep ownership clear at ${suffix} handoff`,
      investigation_subtitle: "Keep the customer informed while another team investigates.",
      investigation_focus: "The chosen repeat requests",
      investigation_body: "Agree the owner and next update time.",
      investigation_scope: "Customers receive a clear next step without repeating their request.", investigation_decision_note: "Proposed: review one repeat request and agree its owner." } };
  input.phaseSlidePlan[phase.phaseRefId].generatedModules.push(module);
  return module;
}

export function addInventedSupportingModule(input, order, number) {
  const module = addInventedNarrative(input,order,`template-${number}`);
  module.templateNumber = number;
  module.narrativeKind=({8:'investigation',11:'metric_evidence',12:'reporting_baseline',14:'workflow_plan',16:'metric_evidence',17:'knowledge_plan'})[number];
  module.fields = number === 8 ? {
    investigation_title: "A clearer escalation path", investigation_subtitle: "Proposed workflow",
    investigation_focus: "Repeat requests with unclear ownership",
    investigation_body: "Agree where this request goes next.",
    investigation_scope: "Review one repeat request so customers receive a clear next step.", investigation_decision_note: "Agree an escalation owner together.",
  } : [11,16].includes(number) ? {
    support_title: `A clearer handoff — ${number}`, support_subtitle: "Proposed workflow",
    support_method_note: "A workflow proposal, not measured results.", metric_1_label:"Trigger", metric_1_value:"Escalation",
    metric_2_label:"Owner", metric_2_value:"Next team", support_insight:"Keep customer updates clear.",
    support_measure:"Review a sample request together.", support_takeaway:"Agree the next update time.",
  } : {
    native_text_title: `Clearer customer updates — ${number}`, native_text_body: "Agree the escalation owner and the next customer update time.",
  };
  if ([12,14,17].includes(number)) module.titleField = "native_text_title";
  return module;
}
