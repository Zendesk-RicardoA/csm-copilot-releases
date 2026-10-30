import test from 'node:test';
import assert from 'node:assert/strict';
import Native from '../mcp/approved-native-contract.js';

// Fixed, anonymous native geometry. Expected results do not use the estimator
// to decide what should fit. Native browser/human review remains separate.
test('a native phase digit fits its 11 by 12 point field at 13 points', () => {
  assert.equal(Native.textFitIssue('1', {widthPt:11,heightPt:12,fontSizePt:13}), null);
  assert.equal(Native.textFitIssue('123456', {widthPt:11,heightPt:12,fontSizePt:13}), 'CONTENT_FIT_RISK');
});

test('native single-line labels do not lose fictional padding or an extra baseline', () => {
  const field={widthPt:130,heightPt:12,fontSizePt:12};
  for (const value of ['Phase 1','Clearer next steps','Review guide','Shared goal']) assert.equal(Native.textFitIssue(value,field), null);
  assert.equal(Native.textFitIssue('First line\nSecond line',field), 'CONTENT_FIT_RISK');
});

test('real wrapping and captured paragraph spacing still reject overflow', () => {
  assert.equal(Native.textFitIssue('Review the requests that wait longest.', {widthPt:210,heightPt:14,fontSizePt:11}), null);
  assert.equal(Native.textFitIssue('one two three four five', {widthPt:30,heightPt:18,fontSizePt:18}), 'CONTENT_FIT_RISK');
  assert.equal(Native.textFitIssue('First\nSecond', {widthPt:100,heightPt:24,fontSizePt:10,lineSpacingPct:100}), null);
  assert.equal(Native.textFitIssue('First\nSecond', {widthPt:100,heightPt:24,fontSizePt:10,lineSpacingPct:200,spaceAbovePt:2,spaceBelowPt:2}), 'CONTENT_FIT_RISK');
});
