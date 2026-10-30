import test from 'node:test';
import assert from 'node:assert/strict';
import Native from '../mcp/approved-native-contract.js';
import {validateNativePreflight,nativeBuildRequirements} from '../mcp/meeting-prep-native-preflight.mjs';
import {prepareMeetingPrepDraftReview} from '../mcp/meeting-prep-draft-review.mjs';
import {inventedMeetingPrepDraft,addInventedNarrative,INVENTED_MASTER_INVENTORY} from './fixtures/meeting-prep-draft-input.mjs';

const cover={cover_title:{widthPt:381,heightPt:214,fontSizePt:40,lineSpacingPct:100},presentation_period:{widthPt:78,heightPt:20,fontSizePt:8}};
const field8={...INVENTED_MASTER_INVENTORY.supporting_templates[8].fields,investigation_body:{fit:{widthPt:165,heightPt:45,fontSizePt:15,lineSpacingPct:100}},investigation_scope:{fit:{widthPt:270,heightPt:110,fontSizePt:16,lineSpacingPct:100}}};
const inventory={native_fields:{cover},supporting_templates:{8:{source_fingerprint:'sha256:'+'a'.repeat(64),fields:field8}}};
const draft=()=>inventedMeetingPrepDraft({account_ref_digest:'a'.repeat(64),account_intelligence_core:{account_ref_digest:'a'.repeat(64),content_digest:'b'.repeat(64)},derived_evidence:{digest:'c'.repeat(64)}});

test('the exact cover reviewed before approval includes + Zendesk',()=>{
  const input=draft();assert.equal(Native.coverTitle(input.projection.customerDisplayName),'Invented Orchard + Zendesk');
  assert.doesNotThrow(()=>validateNativePreflight(input,['cover'],inventory));
  input.projection.customerDisplayName='Invented organisation with a very long name '.repeat(8);
  assert.throws(()=>validateNativePreflight(input,['cover'],inventory),error=>error.code==='CONTENT_FIT_RISK'&&error.details.role==='cover'&&error.details.field==='cover_title');
});
test('cover and supporting geometry are part of preapproval, not a late builder-only failure',()=>{
  assert.equal(nativeBuildRequirements().supporting_templates[8].native_field_inventory_required,true);
  assert.throws(()=>validateNativePreflight(draft(),['cover'],{native_fields:{cover:{cover_title:{widthPt:381,heightPt:49,fontSizePt:40}}}}),{code:'CONTENT_FIT_RISK'});
  const input=draft(),module=addInventedNarrative(input,1);
  module.fields.investigation_body='Customers receive a clear next step without repeating their request.';
  module.fields.investigation_scope='The chosen repeat requests';
  assert.throws(()=>validateNativePreflight(input,['cover'],inventory),error=>error.code==='CONTENT_FIT_RISK'&&error.details.template_number===8&&error.details.field==='investigation_body');
});
test('template 8 uses the left box for the practical action and the right box for the full benefit',()=>{
  const input=draft(),module=addInventedNarrative(input,1);
  assert.equal(module.fields.investigation_body,'Agree the owner and next update time.');
  assert.equal(module.fields.investigation_scope,'Customers receive a clear next step without repeating their request.');
  assert.equal(nativeBuildRequirements().supporting_templates[8].field_purposes.investigation_scope,'right_explanation_and_customer_benefit');
  assert.doesNotThrow(()=>validateNativePreflight(input,['cover'],inventory));
  const before=structuredClone(module.fields);validateNativePreflight(input,['cover'],inventory);assert.deepEqual(module.fields,before);
});

test('missing cover or selected supporting-field geometry stops before wording approval',()=>{
  assert.throws(()=>validateNativePreflight(draft(),['cover'],{}),{code:'NATIVE_FIELD_INVENTORY_REQUIRED'});
  const input=draft();addInventedNarrative(input,1);
  const missing=structuredClone(inventory);delete missing.supporting_templates[8].fields.investigation_body.fit;
  assert.throws(()=>validateNativePreflight(input,['cover'],missing),error=>error.code==='NATIVE_FIELD_INVENTORY_REQUIRED'&&error.details.field==='investigation_body');
  const supplied=structuredClone(input);supplied.supportingTemplateInventory[8].fields.investigation_body.fit.heightPt=999;
  supplied.phaseSlidePlan['phase:1'].generatedModules[0].fields.investigation_body='Customers receive a clear next step without repeating their request.';
  assert.throws(()=>validateNativePreflight(supplied,['cover'],inventory),{code:'CONTENT_FIT_RISK'});
});

test('changed native layout invalidates old content, selection and draft authorization without losing evidence',()=>{
  const record={tester_id:'invented-owner',case_id:'invented-case',revision:3,account_ref_digest:'a'.repeat(64),account_intelligence_core:{account_ref_digest:'a'.repeat(64),content_digest:'b'.repeat(64)},derived_evidence:{digest:'c'.repeat(64)},recommendation_review_package:{revision:3,recommendation_refs:[1,2,3,4].map(n=>`recommendation:${n}`)},approvals:['identity','evidence','recommendations'].map(gate=>({gate,revision:3})),status:'in_review'};
  const input=inventedMeetingPrepDraft(record),reviewed=prepareMeetingPrepDraftReview(record,input,INVENTED_MASTER_INVENTORY,record.tester_id);
  const approved={...reviewed,approvals:[...reviewed.approvals,...['customer_content','maintained_slides'].map(gate=>({gate,revision:3}))],private_draft_authorization:{revision:3}};
  const changed=structuredClone(INVENTED_MASTER_INVENTORY);changed.native_fields.cover.cover_title.widthPt=380;
  const updated=prepareMeetingPrepDraftReview(approved,input,changed,record.tester_id);
  assert.equal(updated.revision,4);
  assert.deepEqual(updated.approvals.map(a=>a.gate),['identity','evidence','recommendations']);
  assert.equal(updated.private_draft_authorization,undefined);
  assert.deepEqual(updated.account_intelligence_core,record.account_intelligence_core);
});
