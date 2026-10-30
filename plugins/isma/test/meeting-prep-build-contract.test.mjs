import test from "node:test";
import assert from "node:assert/strict";
import { assembleApprovedMeetingPrepInput,performanceCoverage,validateMeetingPrepBuildContract } from "../mcp/meeting-prep-build-contract.mjs";
import { prepareMeetingPrepDraftReview } from "../mcp/meeting-prep-draft-review.mjs";
import { ACCOUNT_INTELLIGENCE_CORE_SECTIONS,bindAccountIntelligenceCore } from "../mcp/core.mjs";
import { buildPeerBenchmarkEvidence } from "../mcp/account-peer-benchmarks.mjs";
import { inventedMeetingPrepDraft,INVENTED_MASTER_INVENTORY } from "./fixtures/meeting-prep-draft-input.mjs";
const record=()=>({case_id:"invented-case",tester_id:"invented-owner",revision:1,account_ref_digest:"a".repeat(64),
  account_intelligence_core:{content_digest:"b".repeat(64),account_ref_digest:"a".repeat(64)},derived_evidence:{digest:"c".repeat(64)},
  recommendation_review_package:{revision:1,recommendation_refs:[1,2,3,4].map((n)=>`recommendation:${n}`)},
  approvals:["identity","evidence","recommendations","customer_content","maintained_slides"].map((gate)=>({gate,revision:1,approved_at:"2026-10-07T10:00:00Z"}))});
test("missing build instructions and unconfirmed entitlement stop before customer wording approval",()=>{
  for(const change of [i=>delete i.customerContent.sourceContract,i=>delete i.customerContent.successMeasures,i=>delete i.customerContent.phases[0].measureRefIds,i=>delete i.phaseSolutionRoles,i=>delete i.projection.entitlementSnapshot,
    i=>{i.customerContent.phases[0].zendeskEnablers=[{productName:"Invented capability",accountStatus:"commercial_validation_required"}];}]){
    const r=record(),i=inventedMeetingPrepDraft(r);change(i);
    assert.throws(()=>prepareMeetingPrepDraftReview(r,i,INVENTED_MASTER_INVENTORY,r.tester_id),{code:"DRAFT_BUILD_CONTRACT_INCOMPLETE"});
  }
});
test("assembly metadata is issued only from current-revision gates and never manufactures a metric",()=>{
  const r=record(),i=inventedMeetingPrepDraft(r);delete i.outputReadiness;delete i.customerContent.approval;i.customerContent.status="draft";
  const assembled=assembleApprovedMeetingPrepInput(r,i);
  assert.equal(assembled.outputReadiness.readinessStatus,"customer_plan_ready");assert.equal(assembled.customerContent.approval.decidedAt,"2026-10-07T10:00:00Z");
  assert.deepEqual(assembled.projection,i.projection);
  r.approvals[3].revision=0;assert.throws(()=>assembleApprovedMeetingPrepInput(r,i),{code:"REVIEW_INCOMPLETE"});
  assert.equal(i.customerContent.status,"draft");
});
test("available snapshot and performance evidence cannot silently be called unavailable",()=>{
  const r=record();r.account_intelligence_core.performance_coverage={baseline:true,volume_trend:true,speed_quality_trend:true,peer_comparison:true,year_over_year:true};
  const i=inventedMeetingPrepDraft(r);i.metricSlidePlan.peer_comparison.reason="unavailable";
  assert.throws(()=>prepareMeetingPrepDraftReview(r,i,INVENTED_MASTER_INVENTORY,r.tester_id),{code:"AVAILABLE_PERFORMANCE_OMITTED"});
  i.metricSlidePlan.peer_comparison.reason="not_relevant";delete i.metricExclusions.peer_comparison;
  assert.throws(()=>prepareMeetingPrepDraftReview(r,i,INVENTED_MASTER_INVENTORY,r.tester_id),{code:"AVAILABLE_PERFORMANCE_OMITTED"});
});
test("performance coverage reports usable monthly, peer and annual values, not absent CSAT",()=>{
  const coverage=performanceCoverage({sections:{support_operations:{facts:{metric_table:[{metric:"Tickets solved",unit:"tickets",evidence_state:"measured",current_value:0,year_ago_value:10,comparison_state:"comparable",trend:[{period:"2026-07",value:1},{period:"2026-09",value:0}]}],peer_benchmarks:{comparisons:[{state:"checked"}]}}}}});
  assert.deepEqual(coverage,{baseline:true,volume_trend:true,speed_quality_trend:false,peer_comparison:true,year_over_year:true});
});
test("confirmed peer rate evidence enables optional snapshot and peer proposals without manufacturing history", () => {
  const source = { AGGREGATION_MONTH: "2026-09-01", CHOSEN_CLUSTER: "Invented cohort", CHOSEN_CLUSTER_UNIQUE_ACCOUNTS: 50,
    CSAT_SCORE: 0.25, THE_50TH_CSAT_SCORE: 0.5 };
  const coverage = row => performanceCoverage({ sections: { support_operations: { facts: { peer_benchmarks: buildPeerBenchmarkEvidence([row]) } } } });
  assert.deepEqual(coverage(source), { baseline: true, volume_trend: false, speed_quality_trend: false, peer_comparison: true, year_over_year: false });
  assert.deepEqual(coverage({ ...source, CSAT_SCORE: 25 }), { baseline: false, volume_trend: false, speed_quality_trend: false, peer_comparison: false, year_over_year: false });
});
test("a changed source receipt keeps identity but clears evidence and downstream approvals",()=>{
  const r=record();r.draft_review={digest:"d".repeat(64)};r.private_draft_authorization={revision:1};
  const args={contract:"AccountIntelligenceCoreV1",schemaVersion:"1.0.0",contentDigest:"e".repeat(64),briefState:"partial",sectionStates:Object.fromEntries(ACCOUNT_INTELLIGENCE_CORE_SECTIONS.map(s=>[s,"checked"])),accountRefDigest:r.account_ref_digest,revision:1,testerId:r.tester_id};
  const updated=bindAccountIntelligenceCore(r,args);assert.equal(updated.revision,2);assert.deepEqual(updated.approvals.map(a=>a.gate),["identity"]);assert.equal(updated.draft_review,undefined);
  assert.throws(()=>bindAccountIntelligenceCore(r,{...args,performanceCoverage:{customerContent:"must not persist"}}),{code:"INVALID_PERFORMANCE_COVERAGE"});
});
test("provenance-only revisions do not falsely claim recommendation wording changed",()=>{
  const r=record(),i=inventedMeetingPrepDraft(r),frozen=prepareMeetingPrepDraftReview(r,i,INVENTED_MASTER_INVENTORY,r.tester_id);
  i.customerContent.recommendations[0].provenance.meaningRefIds.push("meaning:invented-source-context");
  const revised=prepareMeetingPrepDraftReview(frozen,i,INVENTED_MASTER_INVENTORY,r.tester_id);
  assert.equal(revised.revision,2);assert.deepEqual(revised.approvals.map(a=>a.gate),["identity","evidence","recommendations"]);
});
