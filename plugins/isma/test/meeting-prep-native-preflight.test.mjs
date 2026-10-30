import test from "node:test";
import assert from "node:assert/strict";
import { prepareMeetingPrepDraftReview } from "../mcp/meeting-prep-draft-review.mjs";
import { inventedMeetingPrepDraft, INVENTED_MASTER_INVENTORY } from "./fixtures/meeting-prep-draft-input.mjs";
import { REQUIRED_FIELDS } from "../mcp/approved-recovery-design.mjs";
import { validateMeetingPrepMasterPreflight } from "../mcp/meeting-prep-native-preflight.mjs";
import { validateNativePreflight } from "../mcp/meeting-prep-native-preflight.mjs";

const record = { tester_id: "invented-owner", case_id: "invented-case", revision: 3,
  account_ref_digest: "a".repeat(64), account_intelligence_core: { content_digest: "b".repeat(64), account_ref_digest: "a".repeat(64) },
  derived_evidence: { digest: "c".repeat(64) }, recommendation_review_package: { revision: 3, recommendation_refs: [1,2,3,4].map(n=>`recommendation:${n}`) },
  approvals: ["identity", "evidence", "recommendations"].map(gate=>({gate, revision: 3})), status: "in_review" };
const prepare = input => prepareMeetingPrepDraftReview(record, input, INVENTED_MASTER_INVENTORY, record.tester_id);

function validInput() {
  const input = inventedMeetingPrepDraft(record), fields = input.projection.templateFields.closing_summary;
  fields.closing_summary_title = "Support plan"; fields.shared_direction_label = "Shared goal"; fields.shared_direction = "Reduce avoidable customer effort.";
  for (const n of [1,2,3,4]) Object.assign(fields, {
    [`summary_phase_${n}_number`]: String(n), [`summary_phase_${n}_title`]: `Phase ${n}`,
    [`summary_phase_${n}_outcome`]: "Clearer next steps", [`summary_phase_${n}_timeframe`]: "Weeks 1–2",
    [`summary_phase_${n}_resource`]: {text:"Review guide",url:"https://example.invalid/guide"},
  });
  return input;
}

test("native preflight accepts a valid call-led plan without metrics", () => assert.doesNotThrow(()=>prepare(validInput())));

test("wording review rejects an oversized investigation frame without its visible card proof",()=>{
  const input=validInput(), inventory=structuredClone(INVENTED_MASTER_INVENTORY);
  delete inventory.native_fields.investigation_focus.investigation_focus.investigationArea;
  assert.throws(()=>validateNativePreflight(input,['investigation_focus'],inventory),{code:'INVESTIGATION_LAYOUT_REVIEW_REQUIRED'});
  const captured=structuredClone(INVENTED_MASTER_INVENTORY);
  captured.native_fields.investigation_focus.investigation_focus.investigationArea.body.topPt=200;
  assert.throws(()=>validateNativePreflight(input,['investigation_focus'],captured),{code:'INVESTIGATION_LAYOUT_REVIEW_REQUIRED'});
});

test("the private v3 master preflight binds only a complete compatible identifier-free inventory", () => {
  const receipt = validateMeetingPrepMasterPreflight(INVENTED_MASTER_INVENTORY);
  assert.match(receipt.inventory_digest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.state, "renderer_verified");
  assert.equal(JSON.stringify(receipt).includes("presentationId"), false);
  assert.throws(() => validateMeetingPrepMasterPreflight({ ...INVENTED_MASTER_INVENTORY, renderer_components: null }),
    { code: "MEETING_PREP_MASTER_RECEIPT_REQUIRED" });
  assert.throws(() => validateMeetingPrepMasterPreflight({ ...INVENTED_MASTER_INVENTORY,
    renderer_components: { ...INVENTED_MASTER_INVENTORY.renderer_components, implementation_sha256: "0".repeat(64) } }),
  { code: "RELEASE_COMPONENT_MISMATCH" });
  assert.throws(() => validateMeetingPrepMasterPreflight({ ...INVENTED_MASTER_INVENTORY, source_presentation_id: "invented-private-id" }),
    { code: "MEETING_PREP_MASTER_INVENTORY_INVALID" });
});
for (const [label, change, code] of [
  ["output name", input=>delete input.output.name, "MISSING_OUTPUT"],
  ["resource shape", input=>input.projection.templateFields.closing_summary.summary_phase_1_resource="Review guide", "MISSING_SEMANTIC_VALUE"],
  ["resource URL", input=>input.projection.templateFields.closing_summary.summary_phase_1_resource.url="javascript:invalid", "INVALID_LINK"],
  ["phase number", input=>input.projection.templateFields.closing_summary.summary_phase_1_number="01", "CONTENT_FIT_RISK"],
  ["timeframe", input=>input.projection.templateFields.closing_summary.summary_phase_1_timeframe="Proposed across the next several months", "CONTENT_FIT_RISK"],
]) test(`native preflight catches ${label} before approval`, ()=>{
  const input=validInput(); change(input); assert.throws(()=>prepare(input),{code});
});

test("native preflight rejects unnormalized bars before approval", ()=>{
  const input=validInput(); input.metricSlidePlan.baseline={include:true,reason:"available_relevant"};
  input.projection.templateFields.baseline=Object.fromEntries(REQUIRED_FIELDS.baseline.map(field=>[field,/^baseline_bar_/.test(field)?0.5:"Reviewed baseline"]));
  input.projection.templateFields.baseline.baseline_bar_1=123;
  input.projection.baselineTrend={title:"Six months",footnote:"Measured tickets",periods:[1,2,3,4,5,6].map(n=>({periodKey:`2026-0${n}`,label:`M${n}`,value:n,display:String(n)}))};
  assert.throws(()=>prepare(input),{code:"INVALID_TREND_VALUE"});
});
