import test from 'node:test';
import assert from 'node:assert/strict';
import { bindOutreachDraftReview,claimOutreachDraft,completeOutreachDraft } from '../mcp/outreach-draft-delivery.mjs';
const now=new Date('2026-10-09T12:00:00Z'), owner='invented-csm', digest='a'.repeat(64);
function record(){return {tester_id:owner,revision:3,journey_state:{active_journey:'journey_a',contexts:{journey_a:{context:{digest:'b'.repeat(64)},approvals:['work_selection','account_evidence','contact_selection','template_preview'].map(gate=>({gate,revision:3}))}}}};}
function reviewed(){const r=bindOutreachDraftReview(record(),{testerId:owner,revision:3,contentDigest:digest,now});r.journey_state.contexts.journey_a.approvals.push({gate:'outreach_draft',revision:3});return r;}
const options={testerId:owner,revision:3,contentDigest:digest,privateDraftAuthorized:true,now};
test('unsent draft delivery is owner, exact-content, revision and approval bound',()=>{
  const r=reviewed();
  for(const change of [{testerId:'other'},{revision:2},{contentDigest:'c'.repeat(64)},{privateDraftAuthorized:false},{now:new Date('2026-10-09T12:16:00Z')}]) assert.throws(()=>claimOutreachDraft(r,{...options,...change}));
  const noGate=structuredClone(r);noGate.journey_state.contexts.journey_a.approvals.pop();
  assert.throws(()=>claimOutreachDraft(noGate,options),{code:'REVIEW_INCOMPLETE'});
  const changed=structuredClone(r);changed.journey_state.contexts.journey_a.context.digest='c'.repeat(64);
  assert.throws(()=>claimOutreachDraft(changed,options),{code:'DRAFT_REVIEW_MISMATCH'});
});
test('a restart or ambiguous failure cannot replay a create; a confirmed receipt survives without restoring email content',()=>{
  const claimed=claimOutreachDraft(reviewed(),options);
  assert.equal(claimed.delivery.native_action,'gmail_create_draft');assert.equal(claimed.delivery.invoke_gmail,true);
  const restarted=JSON.parse(JSON.stringify(claimed.record));
  assert.throws(()=>claimOutreachDraft(restarted,options),{code:'DRAFT_RECONCILIATION_REQUIRED'});
  const gap=completeOutreachDraft(restarted,{...options,requestRef:claimed.delivery.draft_request_ref,providerDraftCreated:false});
  assert.equal(gap.outreach_delivery.state,'needs_reconciliation');assert.throws(()=>claimOutreachDraft(gap,options));
  const done=completeOutreachDraft(gap,{...options,requestRef:claimed.delivery.draft_request_ref,providerDraftCreated:true});
  assert.equal(done.outreach_delivery.state,'draft_created');assert.equal(claimOutreachDraft(done,options).delivery.invoke_gmail,false);
  assert.equal(JSON.stringify(done).includes('recipient'),false);assert.equal(JSON.stringify(done).includes('gmail_draft_id'),false);
});
test('changed wording clears only its final approval; a pending external create cannot be replaced',()=>{
  const changed=bindOutreachDraftReview(reviewed(),{...options,contentDigest:'c'.repeat(64)});
  assert.equal(changed.revision,4);assert.deepEqual(changed.journey_state.contexts.journey_a.approvals.map(a=>a.gate),['work_selection','account_evidence','contact_selection','template_preview']);
  assert.ok(changed.journey_state.contexts.journey_a.approvals.every(a=>a.revision===4));
  const claimed=claimOutreachDraft(reviewed(),options);
  assert.throws(()=>bindOutreachDraftReview(claimed.record,{...options,contentDigest:'c'.repeat(64)}),{code:'DRAFT_RECONCILIATION_REQUIRED'});
});
