import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNativePreflight,nativeBuildRequirements} from '../mcp/meeting-prep-native-preflight.mjs';
import {inventedMeetingPrepDraft,INVENTED_NATIVE_FIELDS,INVENTED_MASTER_INVENTORY} from './fixtures/meeting-prep-draft-input.mjs';
import {checkRendererCompatibility,expectedReleaseComponents} from '../mcp/release-compatibility.mjs';

const copy='Alongside strong ticket output, there’s room to give customers quicker help and a better support experience.';
const area={contract:'peer-takeaway-area-v1',leftPt:500,topPt:150,widthPt:120,heightPt:152,sourceHeightPt:28,maxBottomPt:302,pageWidthPt:720,pageHeightPt:405,
  panel:{leftPt:475,topPt:100,widthPt:200,heightPt:210},rows:[1,2,3,4,5].map(n=>({field:'peer_insight_'+n,leftPt:500,topPt:150+(n-1)*32,widthPt:120,heightPt:28}))};
function scenario(){
  const input=inventedMeetingPrepDraft({account_ref_digest:'a'.repeat(64),account_intelligence_core:{account_ref_digest:'a'.repeat(64),content_digest:'b'.repeat(64)},derived_evidence:{digest:'c'.repeat(64)}});
  input.projection.templateFields.peer_comparison=Object.fromEntries(Object.keys(INVENTED_NATIVE_FIELDS.peer_comparison).map(key=>[key,key.startsWith('peer_insight_')?null:'Invented comparison']));
  input.projection.templateFields.peer_comparison.peer_insight_1=copy;
  const inventory={native_fields:{peer_comparison:structuredClone(INVENTED_NATIVE_FIELDS.peer_comparison)}};
  for(const n of [1,2,3,4,5])inventory.native_fields.peer_comparison['peer_insight_'+n]={widthPt:120,heightPt:28,fontSizePt:8.2,lineSpacingPct:100};
  inventory.native_fields.peer_comparison.peer_insight_1.singleTakeawayArea=structuredClone(area);
  return {input,inventory};
}
test('preapproval and builder use the same captured single-takeaway region without changing wording',()=>{
  const {input,inventory}=scenario(),before=structuredClone({input,inventory});
  assert.equal(nativeBuildRequirements().peer_takeaway_layout_contract,'peer-takeaway-area-v1');
  assert.doesNotThrow(()=>validateNativePreflight(input,['peer_comparison'],inventory));
  assert.deepEqual({input,inventory},before);
});
test('preapproval retains the small row when another takeaway is retained or the proof is absent',()=>{
  for(const mutate of [s=>{s.input.projection.templateFields.peer_comparison.peer_insight_2='Customers get a clearer next step.';},s=>{delete s.inventory.native_fields.peer_comparison.peer_insight_1.singleTakeawayArea;}]){
    const s=scenario();mutate(s);assert.throws(()=>validateNativePreflight(s.input,['peer_comparison'],s.inventory),error=>error.code==='CONTENT_FIT_RISK');
  }
});
test('invalid layout proof, oversized copy and unreviewed geometry cannot bypass approval fit',()=>{
  const forged=scenario();forged.inventory.native_fields.peer_comparison.peer_insight_1.singleTakeawayArea.heightPt=900;
  assert.throws(()=>validateNativePreflight(forged.input,['peer_comparison'],forged.inventory),error=>error.code==='PEER_LAYOUT_REVIEW_REQUIRED');
  const large=scenario();large.input.projection.templateFields.peer_comparison.peer_insight_1='Customers receive a clearer next step. '.repeat(50);
  assert.throws(()=>validateNativePreflight(large.input,['peer_comparison'],large.inventory),error=>error.code==='CONTENT_FIT_RISK');
  const supplied=scenario();supplied.input.projection.peerTakeawayArea={...area,heightPt:900};delete supplied.inventory.native_fields.peer_comparison.peer_insight_1.singleTakeawayArea;
  assert.throws(()=>validateNativePreflight(supplied.input,['peer_comparison'],supplied.inventory),error=>error.code==='CONTENT_FIT_RISK');
});
test('the packaged workflow refuses missing or incompatible peer-layout receipts',()=>{
  const expected=expectedReleaseComponents(),receipt=INVENTED_MASTER_INVENTORY.renderer_components;
  assert.equal(expected.peer_takeaway_layout_contract,'peer-takeaway-area-v1');
  assert.equal(checkRendererCompatibility('meeting_prep',receipt,expected).state,'matched');
  for(const value of [undefined,'obsolete'])assert.equal(checkRendererCompatibility('meeting_prep',{...receipt,peer_takeaway_layout_contract:value},expected).state,'component_mismatch');
});
