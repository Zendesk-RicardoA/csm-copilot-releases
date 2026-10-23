import { BetaError } from "./core.mjs";
import Native from "./approved-native-contract.js";

export const PERFORMANCE_ROLES = ["baseline", "volume_trend", "speed_quality_trend", "peer_comparison", "year_over_year"];
export function performanceCoverage(brief) {
  const facts = brief?.sections?.support_operations?.facts || {}, metrics = facts.metric_table || [];
  const verified = (metric) => ["measured", "checked"].includes(metric.evidence_state) && typeof metric.current_value === "number" && Number.isFinite(metric.current_value);
  const series = (metric) => !["conflicting", "missing", "timeout", "failed"].includes(metric.evidence_state)
    && new Set((metric.completed_month_trend || metric.trend || []).filter((p) => typeof p.value === "number" && Number.isFinite(p.value) && p.state !== "conflicting").map((p) => p.period)).size >= 2;
  return {
    baseline: metrics.some(verified) || (facts.peer_benchmarks?.operating_snapshot || []).some((p) => p.state === "checked"),
    // Legacy role name for the native primary operating-trend slot. Its
    // availability is no longer limited to a ticket-count series.
    volume_trend: metrics.some((m) => /^(?:tickets|views|articles|count|hours|percent|%)$/.test(m.unit || '') && series(m)),
    speed_quality_trend: metrics.some((m) => ["hours", "percent", "%"].includes(m.unit) && series(m)),
    peer_comparison: (facts.peer_benchmarks?.comparisons || []).some((p) => p.state === "checked"),
    year_over_year: metrics.some((m) => verified(m) && m.comparison_state === "comparable" && typeof m.year_ago_value === "number"),
  };
}
export function validatePerformanceCoverage(value) {
  if (!value) return null; // legacy receipts carry no availability claim
  if (Object.keys(value).length !== PERFORMANCE_ROLES.length || PERFORMANCE_ROLES.some((role) => typeof value[role] !== "boolean")) {
    throw new BetaError("INVALID_PERFORMANCE_COVERAGE", "The account brief has an invalid performance-coverage receipt.");
  }
  return Object.fromEntries(PERFORMANCE_ROLES.map((role) => [role, value[role]]));
}
export function validateAvailableMetricDecisions(record, input) {
  const coverage = record.account_intelligence_core?.performance_coverage;
  for (const role of PERFORMANCE_ROLES.filter((role) => role !== "year_over_year")) {
    if (!coverage?.[role] || input.metricSlidePlan?.[role]?.include) continue;
    if (input.metricSlidePlan?.[role]?.reason !== "not_relevant" || typeof input.metricExclusions?.[role] !== "string" || !input.metricExclusions[role].trim()) {
      throw new BetaError("AVAILABLE_PERFORMANCE_OMITTED", "The account brief contains available performance evidence. Include its slide or explain its relevance decision in the content review.", { role });
    }
  }
}

/** Validate the exact build inputs before wording approval. Approval metadata
 * is issued later from case gates; a host cannot invent it or a missing fact. */
export function validateMeetingPrepBuildContract(input) {
  const content = input?.customerContent, missing = [];
  const selectionIssue=Native.narrativeSelectionIssue(input);
  if(selectionIssue) throw new BetaError(selectionIssue,'Explain how each included chart supports a reviewed recommendation, and choose supporting templates for their stated purpose before wording approval.');
  const need = (condition, path) => { if (!condition) missing.push(path); };
  need(input?.bridgeVersion === "1.2.0", "bridgeVersion");
  for (const key of ["manifestId", "idempotencyKey"]) need(typeof input?.[key] === "string" && input[key].length > 0, key);
  for (const key of ["manifestRevision", "outputReadinessRevision"]) need(Number.isInteger(input?.[key]) && input[key] > 0, key);
  need(content?.schemaVersion === "1.2.0", "customerContent.schemaVersion");
  need(typeof content?.contentId === "string" && content.contentId.length > 0, "customerContent.contentId");
  need(Number.isInteger(content?.revision) && content.revision > 0, "customerContent.revision");
  need(typeof content?.sourceContract?.contractId === "string" && Number.isInteger(content.sourceContract.revision) && content.sourceContract.revision > 0, "customerContent.sourceContract");
  need(content?.audience === "customer", "customerContent.audience");
  need(["en", "es"].includes(content?.language), "customerContent.language");
  need(Array.isArray(content?.successMeasures), "customerContent.successMeasures");
  need(Array.isArray(content?.resources), "customerContent.resources");
  const list = (v) => Array.isArray(v) ? v : [];
  const measures = new Set(list(content?.successMeasures).map((m) => m?.measureId)), resources = new Set(list(content?.resources).map((r) => r?.resourceId));
  for (const phase of content?.phases || []) {
    need(Array.isArray(phase.measureRefIds) && phase.measureRefIds.every((ref) => measures.has(ref)), `phases.${phase.order}.measureRefIds`);
    need(Array.isArray(phase.resourceRefIds) && phase.resourceRefIds.every((ref) => resources.has(ref)), `phases.${phase.order}.resourceRefIds`);
    need(Array.isArray(phase.actions) && Array.isArray(phase.benefits) && Array.isArray(phase.zendeskEnablers), `phases.${phase.order}.actions/benefits/zendeskEnablers`);
    need(["operational_foundation", "active_recommendation", "future_horizon"].includes(input.phaseSolutionRoles?.[phase.phaseRefId]), `phaseSolutionRoles.${phase.phaseRefId}`);
  }
  const snapshot = input?.projection?.entitlementSnapshot;
  need(snapshot?.reviewStatus === "approved" && typeof snapshot.reviewedAt === "string", "projection.entitlementSnapshot.review");
  need(Array.isArray(snapshot?.currentPlans) && snapshot.currentPlans.length > 0, "projection.entitlementSnapshot.currentPlans");
  for (const plan of list(snapshot?.currentPlans)) need(plan?.status === "confirmed" && plan.productName && plan.planName && plan.asOfDate && Array.isArray(plan.sourceRefIds) && plan.sourceRefIds.length > 0, "projection.entitlementSnapshot.currentPlans.confirmation");
  need(snapshot?.commercialExceptions == null || Array.isArray(snapshot.commercialExceptions), "projection.entitlementSnapshot.commercialExceptions");
  const exceptions = list(snapshot?.commercialExceptions), exceptionKeys = new Set();
  for (const item of exceptions) {
    need(item.evidenceType === "explicit_customer_interest" && item.phaseRefId && item.productName && item.disclosureText
      && Array.isArray(item.sourceRefIds) && item.sourceRefIds.length > 0, "projection.entitlementSnapshot.commercialExceptions.evidence/disclosure");
    const key = `${item.phaseRefId}|${item.productName}`;
    need(!exceptionKeys.has(key), "projection.entitlementSnapshot.commercialExceptions.unique"); exceptionKeys.add(key);
  }
  for (const phase of content?.phases || []) for (const enabler of phase.zendeskEnablers || []) {
    need(["confirmed_in_use", "confirmed_available", "commercial_validation_required"].includes(enabler.accountStatus), `phases.${phase.order}.zendeskEnablers.accountStatus`);
    if (enabler.accountStatus === "commercial_validation_required") need(exceptionKeys.has(`${phase.phaseRefId}|${enabler.productName}`), `phases.${phase.order}.zendeskEnablers.commercialEvidence`);
  }
  if (input.metricSlidePlan?.baseline?.include) {
    const trend = input.projection?.baselineTrend, periods = trend?.periods;
    need(trend?.title && trend?.footnote && Array.isArray(periods) && periods.length === 6, "projection.baselineTrend.sixPeriods/title/footnote");
    for (const [index, period] of (Array.isArray(periods) ? periods : []).entries()) {
      need(/^\d{4}-(0[1-9]|1[0-2])$/.test(period.periodKey || "") && period.label && (period.missing ? period.missingLabel : typeof period.value === "number" && Number.isFinite(period.value) && period.value >= 0 && period.display), `projection.baselineTrend.periods.${index+1}`);
      if (index) {
        const ordinal = (p) => Number(p.slice(0,4))*12 + Number(p.slice(5));
        need(ordinal(period.periodKey || "") === ordinal(periods[index-1].periodKey || "")+1, "projection.baselineTrend.consecutiveMonths");
      }
    }
  }
  const data = input.projection?.runtimeTrendData;
  for (const [role, keys] of [["volume_trend", data?.primary ? ["primary"] : ["volume"]], ["speed_quality_trend", ["frt","csat"]]]) {
    if (!input.metricSlidePlan?.[role]?.include || !data) continue;
    const provided = keys.map((key) => data[key]).filter(Boolean);
    for (const key of keys) if (data[key]) {
      const issue = Native.trendIssue(data[key], key);
      if (issue) throw new BetaError(issue, 'Review the metric name, units, months and actual comparison data before approving this chart.', {metric:key});
      if(key==='primary' && input.projection.volumeMetricLabel!==data[key].metricDefinition.label) throw new BetaError('INVALID_METRIC_LABEL','Use the exact selected metric name for the chart; do not retain ticket-volume labels for a different metric.');
      if(key==='primary') {
        const text=input.projection.templateFields?.volume_trend || {},claim=/\b(\d+)[ -]month/i.exec(`${text.volume_trend_title || ''} ${text.volume_trend_subtitle || ''}`);
        if(claim && Number(claim[1])!==data[key].periods.length) throw new BetaError('INVALID_TREND_PERIODS','The chart title must describe the actual reviewed window, not a fixed twelve-month label.');
      }
    }
    need(provided.length > 0, `projection.runtimeTrendData.${role}`);
    for (const series of provided) need(Array.isArray(series.values) && series.values.length >= 2 && series.values.length <= 12
      && series.values.filter((v) => typeof v === "number" && Number.isFinite(v)).length >= 2
      && series.values.every((v) => v === null || typeof v === "number" && Number.isFinite(v))
      && Array.isArray(series.periods) && series.periods.length === series.values.length, `projection.runtimeTrendData.${role}.values/periods`);
  }
  const selection = input?.slideSelectionReview;
  need(selection?.outputMode === "customer_plan" && selection.language === content?.language, "slideSelectionReview.mode/language");
  need(selection?.customerContentRef?.contentId === content?.contentId && selection.customerContentRef.revision === content?.revision, "slideSelectionReview.customerContentRef");
  if (missing.length) throw new BetaError("DRAFT_BUILD_CONTRACT_INCOMPLETE", "Complete these build inputs before approving customer wording. Missing metrics are optional; missing build instructions are not.", { missing_fields: missing });
  const storyIssue = Native.storyIssue(input);
  if (storyIssue) throw new BetaError(storyIssue, storyIssue === 'CUSTOMER_IMPLICATION_REVIEW_REQUIRED'
    ? 'Explain why this evidence matters to the customer. Keep numeric comparisons in the chart and CSM checklists in private notes. Review the exact wording before approval.'
    : 'Align the reviewed agenda, phase benefits and success measures before customer-wording approval. Missing metrics remain optional.');
  return true;
}
export function assembleApprovedMeetingPrepInput(record, input) {
  validateMeetingPrepBuildContract(input);
  const approved = new Set((record.approvals || []).filter((a) => a.revision === record.revision).map((a) => a.gate));
  if (["identity", "evidence", "recommendations", "customer_content", "maintained_slides"].some((gate) => !approved.has(gate))) throw new BetaError("REVIEW_INCOMPLETE", "Complete every separate approval gate before assembling the private draft.");
  const copy = structuredClone(input), timestamp = (record.approvals || []).find((a) => a.gate === "customer_content" && a.revision === record.revision)?.approved_at || new Date().toISOString();
  copy.nativeReviewContract = Native.version;
  const content = copy.customerContent;
  content.status = "content_approved";
  content.approval = { decision: "approved", sourceRevision: content.revision, decidedAt: timestamp };
  copy.outputReadiness = { resolvedMode: "customer_plan", readinessStatus: "customer_plan_ready", customerDeliveryEligible: true, customerContentRef: content.contentId };
  copy.slideSelectionReview.assemblyEligible = true;
  copy.slideSelectionReview.deckInputReview = { decision: "approved", decidedAt: timestamp,
    ...Object.fromEntries(["customerFacts", "metricsAndDefinitions", "goalsAndPainPoints", "recommendationFit", "slideApplicability"].map((key) => [key,"approved"])) };
  for (const proposal of copy.slideSelectionReview.proposals || []) if (proposal.selectionStatus === "selected") proposal.review = { decision: "approved", decidedAt: timestamp };
  copy.assemblyAuthorization = { authorizationRef: `authorization:${record.case_id}:${record.revision}`, approvedAt: record.private_draft_authorization?.authorized_at || new Date().toISOString() };
  copy.idempotencyKey = `build.meeting-prep:${record.case_id}:${record.revision}:${record.draft_review?.digest?.slice(0,16) || "reviewed"}`;
  return copy;
}
