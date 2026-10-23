import assert from "node:assert/strict";
import test from "node:test";
import { prepareMeetingPrepDraftReview, requireFrozenMeetingPrepDraft } from "../mcp/meeting-prep-draft-review.mjs";
import { inventedMeetingPrepDraft, INVENTED_MASTER_INVENTORY, omitInventedLibrary, addInventedNarrative, addInventedSupportingModule } from "./fixtures/meeting-prep-draft-input.mjs";

const record = { tester_id: "invented-owner", case_id: "invented-case", revision: 3,
  account_ref_digest: "a".repeat(64), account_intelligence_core: { content_digest: "b".repeat(64), account_ref_digest: "a".repeat(64) },
  derived_evidence: { digest: "c".repeat(64) },
  recommendation_review_package: { revision: 3, recommendation_refs: [1,2,3,4].map(n => `recommendation:${n}`) },
  approvals: ["identity", "evidence", "recommendations"].map(gate => ({ gate, revision: 3 })), status: "in_review" };
const prepare = (input, source = record) => prepareMeetingPrepDraftReview(source, input, INVENTED_MASTER_INVENTORY, "invented-owner");

test("only the six explicitly approved master positions are supporting templates",()=>{
  for (let number=1;number<=23;number++) {
    const input=inventedMeetingPrepDraft(record); addInventedSupportingModule(input,2,number);
    if ([8,11,12,14,16,17].includes(number)) assert.ok(prepare(input).draft_review);
    else assert.throws(()=>prepare(input),{code:"PHASE_SLIDE_PLAN_INVALID"});
  }
  const legacy=inventedMeetingPrepDraft(record), module=addInventedNarrative(legacy,2);
  delete module.templateNumber; module.templateRole="phase_detail";
  assert.throws(()=>prepare(legacy),{code:"PHASE_SLIDE_PLAN_INVALID"});
});

test("templates 12, 14 and 17 require their real captured field inventory before approval",()=>{
  for (const number of [12,14,17]) {
    const input=inventedMeetingPrepDraft(record); addInventedSupportingModule(input,2,number);
    const unchanged=structuredClone(input);
    input.supportingTemplateInventory[number].source_fingerprint=`sha256:${"d".repeat(64)}`;
    assert.throws(()=>prepare(input),{code:"SUPPORTING_TEMPLATE_INVENTORY_REQUIRED"});
    const missing=structuredClone(unchanged); delete missing.supportingTemplateInventory[number];
    assert.throws(()=>prepare(missing),{code:"PHASE_SLIDE_PLAN_INVALID"});
    const overflow=structuredClone(unchanged); overflow.phaseSlidePlan["phase:2"].generatedModules[0].fields.native_text_body="x".repeat(241);
    assert.throws(()=>prepare(overflow),{code:"CONTENT_FIT_RISK"});
    const reviewed=prepare(unchanged); unchanged.supportingTemplateInventory[number].fields.native_text_body.max_characters++;
    assert.throws(()=>requireFrozenMeetingPrepDraft(reviewed,unchanged),{code:"APPROVED_DRAFT_CHANGED"});
  }
});

function inventedFlexiblePlan(source = record) {
  const input = inventedMeetingPrepDraft(source);
  input.phaseSlidePlan = Object.fromEntries(input.customerContent.phases.map(phase => [phase.phaseRefId, {
    maintainedReason: "selected_relevant", rationale: "This reviewed library slide explains the proposed workflow.", generatedModules: [],
  }]));
  return input;
}
test("stabilization: irrelevant library slide can be replaced by exact reviewed customer narrative", () => {
  const input = inventedFlexiblePlan(); omitInventedLibrary(input, 2); addInventedNarrative(input, 2);
  const reviewed = prepare(input);
  assert.equal(reviewed.draft_review.slide_order.includes("maintained_product:phase_2"), false);
  assert.ok(reviewed.draft_review.slide_order.includes("zendesk_enabler:phase_2:1"));
  assert.equal(reviewed.draft_review.slide_order.length, 17);
  requireFrozenMeetingPrepDraft(reviewed, input);
  assert.doesNotMatch(JSON.stringify(reviewed), /Customers receive|escalation trigger|generic installation/);
});

test("stabilization: no maintained slides is a valid reviewed plan, not a missing-source failure", () => {
  const input = inventedFlexiblePlan(); for (const n of [1,2,3,4]) omitInventedLibrary(input, n);
  const reviewed = prepare(input);
  assert.equal(reviewed.draft_review.slide_order.length, 13);
  assert.ok(reviewed.draft_review.slide_order.every(role => !role.startsWith("maintained_product")));
});

test("stabilization: distinct generated modules retain every narrative step and invalidate old approvals on edits", () => {
  const input = inventedFlexiblePlan(); addInventedNarrative(input, 2); addInventedNarrative(input, 2, "resolution");
  const reviewed = prepare(input);
  assert.ok(reviewed.draft_review.slide_order.includes("zendesk_enabler:phase_2:2"));
  const approved = { ...reviewed, artifact: { digest: "d".repeat(64) }, private_draft_authorization: { revision: 3 },
    approvals: [...reviewed.approvals, ...["customer_content", "maintained_slides"].map(gate => ({ gate, revision: 3 }))] };
  input.phaseSlidePlan["phase:2"].generatedModules[0].fields.investigation_focus = "Proposed: agree an escalation owner and a daily customer update.";
  assert.throws(() => requireFrozenMeetingPrepDraft(approved, input), { code: "APPROVED_DRAFT_CHANGED" });
  const revised = prepare(input, approved);
  assert.equal(revised.revision, 4);
  assert.deepEqual(revised.approvals.map(a => a.gate), ["identity", "evidence", "recommendations", "maintained_slides"]);
  assert.equal(revised.artifact, undefined); assert.equal(revised.private_draft_authorization, undefined);
});

test("stabilization: unknown phase, duplicate narrative, empty copy and other-account citations fail before approval", () => {
  for (const change of [
    input => { input.phaseSlidePlan["phase:other"] = input.phaseSlidePlan["phase:1"]; },
    input => { const item = addInventedNarrative(input, 2); input.phaseSlidePlan["phase:2"].generatedModules.push(structuredClone(item)); },
    input => { addInventedNarrative(input, 2).fields.investigation_focus = ""; },
    input => { addInventedNarrative(input, 2).provenance.evidenceIds = ["evidence:account:other"]; },
    input => { addInventedNarrative(input, 2).enablerRefIds = ["enabler:unreviewed"]; },
  ]) { const input = inventedFlexiblePlan(); change(input); assert.throws(() => prepare(input), { code: "PHASE_SLIDE_PLAN_INVALID" }); }
});
