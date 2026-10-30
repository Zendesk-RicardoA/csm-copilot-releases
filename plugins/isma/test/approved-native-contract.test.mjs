import test from 'node:test';
import assert from 'node:assert/strict';
import Native from '../mcp/approved-native-contract.js';
import { REQUIRED_FIELDS } from '../mcp/approved-recovery-design.mjs';

test('shared native source canonicalization ignores transport metadata, not meaning or array order',()=>{
  const a={objectId:'invented-id-a',shape:{text:{textElements:[{textRun:{content:'Peer median (P50)'}}]}},empty:null};
  const b={shape:a.shape,thumbnailUrl:'https://example.invalid/image',objectId:'invented-id-b'};
  assert.equal(Native.canonicalSourceJson(a),Native.canonicalSourceJson(b));
  assert.notEqual(Native.canonicalSourceJson(a),Native.canonicalSourceJson({...b,shape:{text:'A different percentile'}}));
  assert.notEqual(Native.canonicalSourceJson([1,2]),Native.canonicalSourceJson([2,1]));
});
test('all native field kinds and exact closing limits are available in the installed package',()=>{
  for(const field of REQUIRED_FIELDS.baseline.filter(f=>f.startsWith('baseline_bar'))) assert.equal(Native.renderer(field),'bar');
  assert.equal(Native.maxCharacters('closing_summary','summary_phase_1_timeframe'),28);
  assert.equal(Native.maxCharacters('closing_summary','summary_phase_1_number'),1);
  assert.equal(Native.valueIssue('closing_summary','summary_phase_1_resource',{text:'Guide',url:'https://example.invalid/guide'}),null);
  assert.equal(Native.valueIssue('baseline','baseline_bar_1',0),null);
  assert.equal(Native.valueIssue('baseline','baseline_bar_1',null),null);
  assert.equal(Native.valueIssue('baseline','baseline_bar_1',NaN),'INVALID_TREND_VALUE');
});
