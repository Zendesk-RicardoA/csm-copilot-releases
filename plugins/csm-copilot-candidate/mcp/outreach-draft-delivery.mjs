// Guard the existing host Gmail draft action. No connector, email content,
// recipient or provider identifier is stored or sent by this module.
import crypto from 'node:crypto';
import { BetaError } from './core.mjs';
import { JOURNEY_A_GATES } from './journey-orchestrator.mjs';

const DIGEST=/^[a-f0-9]{64}$/;
const REVIEW_TTL_MS=15*60*1000;
function context(record,{testerId,revision}) {
  if(record.tester_id!==testerId) throw new BetaError('CASE_OWNER_MISMATCH','This draft belongs to another CSM.');
  if(record.revision!==revision) throw new BetaError('STALE_CASE_REVISION','Review the current email before creating a draft.');
  const journey=record.journey_state;
  if(journey?.active_journey!=='journey_a' || !journey.contexts?.journey_a?.context) throw new BetaError('JOURNEY_CONTEXT_REQUIRED','The reviewed outreach account context is required.');
  return journey.contexts.journey_a;
}
export function bindOutreachDraftReview(record,{testerId,revision,contentDigest,now=new Date()}) {
  const current=context(record,{testerId,revision});
  if(!DIGEST.test(contentDigest || '')) throw new BetaError('INVALID_DRAFT_DIGEST','Hash the complete displayed email, including its verified recipient and signature.');
  const approvals=current.approvals || [];
  if(JOURNEY_A_GATES.slice(0,4).some(gate=>!approvals.some(a=>a.gate===gate && a.revision===revision))) throw new BetaError('REVIEW_INCOMPLETE','Review work, account evidence, contact and the template before freezing the exact email.');
  const old=record.outreach_delivery;
  if(old && old.state!=='review_ready') throw new BetaError('DRAFT_RECONCILIATION_REQUIRED','A draft request already started. Check its result before changing or requesting another draft.');
  const updated=structuredClone(record);
  if(old && old.content_digest!==contentDigest) {
    updated.revision++;
    updated.journey_state.contexts.journey_a.approvals=approvals.filter(a=>a.gate!=='outreach_draft').map(a=>({...a,revision:updated.revision}));
  }
  updated.outreach_delivery={state:'review_ready',revision:updated.revision,content_digest:contentDigest,context_digest:current.context.digest,
    expires_at:new Date(now.getTime()+REVIEW_TTL_MS).toISOString()};
  return updated;
}
export function claimOutreachDraft(record,{testerId,revision,contentDigest,privateDraftAuthorized,now=new Date()}) {
  const current=context(record,{testerId,revision}), receipt=record.outreach_delivery;
  if(privateDraftAuthorized!==true) throw new BetaError('DRAFT_NOT_AUTHORIZED','Approve creation of this exact unsent Gmail draft.');
  if(!receipt || receipt.content_digest!==contentDigest || receipt.revision!==revision || receipt.context_digest!==current.context.digest) throw new BetaError('DRAFT_REVIEW_MISMATCH','The displayed email or its account evidence changed. Review it again before creating a draft.');
  if(receipt.state==='draft_created') return {record,delivery:{status:'already_created',draft_request_ref:receipt.request_ref,invoke_gmail:false}};
  if(receipt.state!=='review_ready') throw new BetaError('DRAFT_RECONCILIATION_REQUIRED','The previous create request may have succeeded. Check Gmail; do not automatically create another draft.');
  if(Date.parse(receipt.expires_at)<=now.getTime()) throw new BetaError('DRAFT_REVIEW_EXPIRED','Show and review a fresh email; expired content cannot be restored from its digest.');
  if(JOURNEY_A_GATES.some(gate=>!current.approvals?.some(a=>a.gate===gate && a.revision===revision))) throw new BetaError('REVIEW_INCOMPLETE','Complete the ordered outreach approvals before creating a draft.');
  const updated=structuredClone(record), ref=crypto.randomUUID();
  updated.outreach_delivery={...receipt,state:'create_requested',request_ref:ref,requested_at:now.toISOString()};
  return {record:updated,delivery:{status:'authorized_host_action',draft_request_ref:ref,invoke_gmail:true,native_action:'gmail_create_draft',unsent_only:true}};
}
export function completeOutreachDraft(record,{testerId,revision,requestRef,providerDraftCreated,now=new Date()}) {
  context(record,{testerId,revision});
  const receipt=record.outreach_delivery;
  if(!receipt || receipt.request_ref!==requestRef) throw new BetaError('DRAFT_RECEIPT_MISMATCH','Use this case\'s original draft request receipt.');
  if(receipt.state==='draft_created') return record;
  if(!['create_requested','needs_reconciliation'].includes(receipt.state)) throw new BetaError('DRAFT_NOT_REQUESTED','No authorized Gmail draft request is pending.');
  const updated=structuredClone(record);
  updated.outreach_delivery={...receipt,state:providerDraftCreated===true?'draft_created':'needs_reconciliation',completed_at:now.toISOString()};
  // Provider failures can be ambiguous. Never claim no draft exists or retry
  // an external write automatically. A later verified receipt can complete it.
  return updated;
}
