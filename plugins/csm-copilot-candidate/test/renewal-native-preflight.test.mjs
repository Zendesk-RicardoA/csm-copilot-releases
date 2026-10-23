import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
const api = await import('../mcp/renewal-native-preflight.mjs').catch(() => ({}));
const canonical = value => JSON.stringify(value, (_key,item) => item && !Array.isArray(item) && typeof item==='object' ? Object.fromEntries(Object.entries(item).filter(([,v])=>v!==null).sort(([a],[b])=>a.localeCompare(b))) : item);
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const record = () => ({case_id:'invented-renewal-case',package_version:'0.0.0-test',revision:4,journey_state:{account_ref_digest:'a'.repeat(64)}});
const deck = () => ({customer_copy_contract:'RenewalCustomerHeroCopyV2',customer_slides:[
  {role:'progress',title:'Your progress over the past year',annual_point_of_view:'The strengths your results highlight',cards:[{headline:'More complete answers',metric_comparison:'30% now vs 20% a year earlier (+10pp)',why_it_matters:'Less back-and-forth for customers.'}]},
  {role:'opportunities',title:'Opportunities to build on',cards:[{number:1,headline:'Reply sooner',what_the_data_shows:'3h now vs 1h a year earlier',customer_impact_opportunity:'Give customers an earlier update.'}]},
  {role:'focus',title:'Where to focus next',cards:[{number:1,focus_area:'A faster first reply',customer_benefit:'Give customers a quicker first reply through smarter routing with Intelligent Triage.'}]},
],private_speaker_notes:[{audience:'CSM only'},{audience:'CSM only'},{audience:'CSM only'}]});
function begin(copy=deck(), now=1000) {
  assert.equal(typeof api.beginRenewalNativePreflight,'function','Native fit must be an owner-bound step before approval.');
  return api.beginRenewalNativePreflight({caseRecord:record(),ownerRef:'invented-owner',deckContent:copy,now,expiresAt:now+900000});
}
function captured(pending, change=()=>{}) {
  const fit={widthPt:640,heightPt:19,fontSizePt:21,lineSpacingPct:100,spaceAbovePt:0,spaceBelowPt:0};
  const cardFit={widthPt:176,heightPt:100,fontSizePt:11,lineSpacingPct:100};
  const fields=[['headline','metric_comparison','why_it_matters'],['headline','what_the_data_shows','customer_impact_opportunity'],['focus_area','customer_benefit']];
  const result={schema_version:'1.0',contract:'renewal-native-preflight-v1',native_fit_request_ref:pending.requestRef,source_fingerprint:'b'.repeat(64),creates_artifact:false,
    slides:['progress','opportunities','focus'].map((role,i)=>({role,...(i<2?{subtitle_fit:{...fit}}:{}),cards:Array.from({length:3},()=>Object.fromEntries(fields[i].map(field=>[field,{...cardFit}])))}))};
  change(result);result.layout_fingerprint=hash({contract:result.contract,slides:result.slides});return result;
}
function bind(pending, result=captured(pending), options={}) {
  return api.bindRenewalNativePreflight({pending,nativeResult:result,caseRecord:record(),ownerRef:'invented-owner',deckContent:deck(),now:1001,...options});
}
test('read-only capture request contains no customer copy or draft authorization',()=>{
  const pending=begin(), request=api.renewalNativeLayoutRequest(pending,null);
  assert.equal(request.privateDraftAuthorized,false);assert.equal(request.bridgeInput.mode,'capture_layout');
  assert.equal(request.nativeFitRequestRef,pending.requestRef);
  assert.doesNotMatch(JSON.stringify(request),/customer_slides|metric_comparison|More complete answers|private_speaker_notes/);
});
test('every visible field is fitted before the receipt permits wording approval',()=>{
  const pending=begin(), actual=bind(pending);
  assert.equal(actual.receipt.contract,'renewal-native-preflight-v1');
  assert.equal(actual.receipt.reviewed_revision,4);assert.equal(actual.receipt.source_fingerprint,'b'.repeat(64));
  assert.equal(api.assertRenewalNativePreflight({receipt:actual.receipt,inventory:actual.inventory,caseRecord:record(),ownerRef:'invented-owner',deckContent:deck(),now:1002}),true);
  assert.doesNotMatch(JSON.stringify(actual.receipt),/More complete answers|30%|customer_slides|private_speaker_notes|invented-owner|invented-renewal-case/);
  for(const [slide,field] of [[0,'headline'],[1,'customer_impact_opportunity'],[2,'customer_benefit']]) {
    const result=captured(pending,r=>r.slides[slide].cards[0][field].heightPt=1);
    assert.throws(()=>bind(pending,result),{code:'CONTENT_FIT_RISK'});
  }
});
test('long subtitle and missing or invented geometry cannot produce a fit receipt',()=>{
  const copy=deck();copy.customer_slides[0].annual_point_of_view='An oversized review paragraph. '.repeat(20);const pending=begin(copy);
  assert.throws(()=>bind(pending,captured(pending),{deckContent:copy}),{code:'CONTENT_FIT_RISK'});
  for(const change of [r=>delete r.slides[0].subtitle_fit,r=>delete r.slides[2].cards[0].customer_benefit,r=>r.slides[0].cards[0].headline.fontSizePt=null,r=>r.creates_artifact=true]) {
    const current=begin();assert.throws(()=>bind(current,captured(current,change)),{code:'RENEWAL_NATIVE_LAYOUT_REQUIRED'});
  }
});
test('wrong owner, case, account, revision, package, content, expiry and restart do not inherit native approval',()=>{
  const pending=begin(), result=captured(pending);
  for(const options of [{ownerRef:'other-owner'},{caseRecord:{...record(),case_id:'other-case'}},{caseRecord:{...record(),revision:5}},{caseRecord:{...record(),package_version:'0.0.1-test'}},{caseRecord:{...record(),journey_state:{account_ref_digest:'c'.repeat(64)}}}]) assert.throws(()=>bind(pending,result,options),{code:'RENEWAL_NATIVE_PREFLIGHT_SCOPE_MISMATCH'});
  const changed=deck();changed.customer_slides[0].cards[0].why_it_matters='Changed customer message.';
  assert.throws(()=>bind(pending,result,{deckContent:changed}),{code:'RENEWAL_NATIVE_PREFLIGHT_SCOPE_MISMATCH'});
  assert.throws(()=>bind(pending,result,{now:901000}),{code:'RENEWAL_NATIVE_PREFLIGHT_EXPIRED'});
  assert.throws(()=>bind(null,result),{code:'RENEWAL_NATIVE_PREFLIGHT_EXPIRED'});
});
