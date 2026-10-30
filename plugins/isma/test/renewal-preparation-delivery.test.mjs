import assert from 'node:assert/strict';
import test from 'node:test';
import { BetaError } from '../mcp/core.mjs';
import { renewalRunDigest } from '../mcp/renewal-completion.mjs';
import { continueRenewalPreparation } from '../mcp/renewal-preparation-delivery.mjs';

const RUN = '00000000-0000-4000-8000-000000000001';
const ACCOUNT = 'a'.repeat(64);
const VERSION = '0.0.0-invented';

function fixture() {
  let clock = Date.parse('2026-01-01T12:00:00Z');
  const sections = [
    { id: 'account_header', markdown: '### Account — Invented Cedar\n\n| Item | Value |\n| --- | --- |\n| ARR | $12,345.67 |' },
    { id: 'support_operations', markdown: '### Support performance\n\n| Metric | Latest | Year ago | Change |\n| --- | --- | --- | --- |\n| Tickets created | 120 | 100 | 20.0% |' },
    { id: 'recent_conversations', markdown: '### Recent conversations\n\n| Date | Call | Summary | Next steps |\n| --- | --- | --- | --- |\n| 2025-12-01 | Invented call | Manual routing delays replies. | Invented owner to review routing. |' },
    { id: 'source_gaps', markdown: '### Data limits\n\nCSAT was not returned. Missing values are not zero.' },
  ];
  const display = { markdown: sections.map(s => s.markdown).join('\n\n'), sections,
    delivery_contract: { required_section_order: sections.map(s => s.id), editable_columns: { recent_conversations: ['Summary', 'Next steps'] } },
    charts: [{ id: 'volume', title: 'Ticket volume', unit: 'tickets' }, { id: 'reply', title: 'First reply', unit: 'hours' }] };
  const review = { tables: [
    { id: 'annual_point_of_view', title: 'Annual point of view for review', columns: ['Draft point of view', 'State'],
      rows: [{ state: 'supported metric candidates', draft_point_of_view: 'More requests resolved in one touch.' }] },
    { id: 'progress_metric_candidates', title: 'Progress metric candidates', columns: ['ID', 'Metric', 'Customer headline', 'Comparison', 'Why it matters'],
      rows: [{ why_it_matters: 'Less customer effort.', comparison: '22% vs 18% (+4 percentage points)', customer_headline: 'Resolve more in one touch', metric: 'One-touch ratio', id: 'metric:one' },
        { why_it_matters: 'Keep repeat answers available.', comparison: '1,343 vs 1,277 (+5.2%)', customer_headline: 'Reach more readers', metric: 'Knowledge views', id: 'metric:guide' }] },
    { id: 'linked_opportunities_and_focus', title: 'Linked opportunities and focus areas',
      columns: ['#', 'ID', 'Opportunity', 'What the data shows', 'Customer impact', 'Question to validate', 'Focus area', 'Why now', 'Practical next step', 'How Zendesk can help', 'Expected outcome'],
      rows: [{ expected_outcome: 'Help customers receive answers sooner.', how_zendesk_can_help: 'Use Admin Copilot to review routing.', practical_next_step: 'Review routing.', why_now: 'Longer reply times.', focus_area: 'Improve routing', question_to_validate: 'Which queues wait?', customer_impact: 'Reduce waiting.', what_the_data_shows: '2 hours vs 1.5 hours', opportunity: 'Reply sooner', id: 'pair:routing', number: 1 }] },
  ] };
  const record = { case_id: 'invented-case', tester_id: 'invented-owner', package_version: VERSION, revision: 2,
    renewal_conversation: { account_ref_digest: ACCOUNT, run_ref_digest: renewalRunDigest(RUN), evidence_state: 'evidence_ready_with_gaps', approvals: [] } };
  const run = { caseId: record.case_id, testerId: record.tester_id, revision: 2, state: 'evidence_ready_with_gaps',
    startedAt: clock - 1000, expiresAt: clock + 900_000,
    evidence: { account_intelligence_receipt: { account_ref_digest: ACCOUNT } },
    sourceProgress: { source: 'company_profile', stage: 'account_evidence', attempt: 1, completed_sources: 1, total_sources: 18 } };
  let creates = 0, projects = 0;
  const files = new Map();
  const options = { caseId: record.case_id, runId: RUN, ownerRef: record.tester_id, packageVersion: VERSION,
    waitSeconds: 0, getRun: () => run, getCase: () => record, nowMs: () => clock,
    projectEvidence: () => { projects++; return { account_brief_display: display, customer_content_review: review,
      content_readiness: { state: 'ready_for_csm_selection' }, source_gap_codes: ['CSAT_NOT_RETURNED'] }; },
    createChart: async ({ chartId, expiresAt, authorized, accountRefDigest, evidenceRef }) => {
      assert.equal(authorized, true); assert.equal(accountRefDigest, ACCOUNT); assert.equal(evidenceRef, RUN);
      if (!files.has(chartId)) {
        creates++;
        files.set(chartId, { method: 'markdown_local_image', file_path: `/private/tmp/csm-invented-${chartId}.png`,
          markdown: `![Invented ${chartId}](/private/tmp/csm-invented-${chartId}.png)`, expires_at: new Date(expiresAt).toISOString() });
      }
      return files.get(chartId);
    } };
  return { options, record, run, display, review, files, get creates() { return creates; }, get projects() { return projects; },
    advance: ms => { clock += ms; } };
}

test('pending preparation returns one same-run continuation and no premature brief or chart work', async () => {
  const f = fixture(); f.run.state = 'collecting'; f.record.renewal_conversation.evidence_state = 'collecting';
  delete f.run.evidence; f.run.evidencePromise = new Promise(() => {});
  const result = await continueRenewalPreparation(f.options);
  assert.equal(result.structuredContent.status, 'collecting');
  assert.equal(result.structuredContent.next_action.kind, 'continue_preparation');
  assert.equal(result.structuredContent.next_action.arguments.renewal_conversation_run_id, RUN);
  assert.equal(f.projects, 0); assert.equal(f.creates, 0);
  assert.match(result.content[0].text, /preparing/i);
  assert.doesNotMatch(result.content[0].text, /send another|retry the request|no data/i);
});

test('one completed response preserves the approved brief, all candidate cells and authorized chart placement', async () => {
  const f = fixture(), before = JSON.stringify(f.record);
  const result = await continueRenewalPreparation({ ...f.options, localFileDeliveryAuthorized: true });
  const body = result.content[0].text;
  for (const section of f.display.sections) assert.ok(body.includes(section.markdown), section.id);
  assert.ok(body.indexOf('![Invented volume]') > body.indexOf('### Support performance'));
  assert.ok(body.indexOf('![Invented reply]') < body.indexOf('### Recent conversations'));
  assert.match(body, /\| metric:one \| One-touch ratio \| Resolve more in one touch \| 22% vs 18% \(\+4 percentage points\) \| Less customer effort\. \|/);
  assert.match(body, /\| metric:guide \| Knowledge views/);
  assert.match(body, /\| 1 \| pair:routing \| Reply sooner \| 2 hours vs 1\.5 hours/);
  assert.match(body, /2026-01-01T12:15:00.000Z/);
  assert.equal(result.structuredContent.next_action.kind, 'select_cards');
  assert.equal(result.structuredContent.chart_visibility, 'unverified');
  assert.equal(result.structuredContent.chart_delivery.length, 2);
  assert.ok(result.content.every(part => part.type === 'text'), 'No hidden PNG or raw evidence dump accompanies the answer');
  assert.equal(f.creates, 2); assert.equal(JSON.stringify(f.record), before);
});

test('no chart authorization blocks neither the complete brief nor its candidate selection', async () => {
  const f = fixture();
  const result = await continueRenewalPreparation(f.options);
  assert.equal(f.creates, 0); assert.ok(!result.content[0].text.includes('!['));
  for (const s of f.display.sections) assert.ok(result.content[0].text.includes(s.markdown));
  assert.equal(result.structuredContent.next_action.kind, 'select_cards');
  assert.ok(result.structuredContent.chart_delivery.every(chart => chart.state === 'not_authorized'));
  assert.match(result.content[0].text, /charts are available/i);
  assert.equal((result.content[0].text.match(/charts are available/gi) || []).length, 1);
});

test('repeated unauthorized delivery offers cached charts only once without hiding the brief', async () => {
  const f = fixture();
  const first = await continueRenewalPreparation(f.options);
  const second = await continueRenewalPreparation(f.options);
  assert.match(first.content[0].text, /charts are available/i);
  assert.doesNotMatch(second.content[0].text, /charts are available|authorize private temporary images/i);
  for (const section of f.display.sections) assert.ok(second.content[0].text.includes(section.markdown));
  assert.ok(second.structuredContent.chart_delivery.every(chart => chart.state === 'not_authorized'));
  assert.equal(second.structuredContent.next_action.kind, 'select_cards');
  assert.equal(f.creates, 0);
});

test('a later explicit authorization reuses the evidence; repeated delivery reuses files and cannot extend expiry', async () => {
  const f = fixture();
  await continueRenewalPreparation(f.options);
  const first = await continueRenewalPreparation({ ...f.options, localFileDeliveryAuthorized: true });
  f.advance(20_000);
  const second = await continueRenewalPreparation(f.options);
  assert.equal(f.creates, 2);
  assert.deepEqual(second.structuredContent.chart_delivery, first.structuredContent.chart_delivery);
  assert.deepEqual(second.structuredContent.next_action, first.structuredContent.next_action);
  assert.equal(f.run.expiresAt, Date.parse('2026-01-01T12:15:00Z'));
  assert.equal(f.record.revision, 2); assert.deepEqual(f.record.renewal_conversation.approvals, []);
});

test('one failed chart leaves the brief, remaining image and all candidates available', async () => {
  const f = fixture(), create = f.options.createChart;
  f.options.createChart = async args => { if (args.chartId === 'volume') throw new BetaError('ACCOUNT_BRIEF_CHART_UNAVAILABLE', 'invented failure'); return create(args); };
  const result = await continueRenewalPreparation({ ...f.options, localFileDeliveryAuthorized: true });
  assert.ok(result.content[0].text.includes(f.display.markdown.split('\n\n')[0]));
  assert.match(result.content[0].text, /\| metric:guide \| Knowledge views/);
  assert.ok(result.content[0].text.includes('![Invented reply]'));
  assert.equal(result.structuredContent.chart_delivery[0].state, 'unavailable');
  assert.equal(result.structuredContent.chart_delivery[1].state, 'prepared');
  assert.doesNotMatch(result.content[0].text, /invented failure|all charts (?:visible|delivered)/i);
  assert.equal(result.structuredContent.chart_visibility, 'unverified');
});

test('unsafe storage or failed cleanup stops further file creation, not evidence delivery', async () => {
  const f = fixture(); let attempts = 0;
  f.options.createChart = async () => { attempts++; throw new BetaError('ACCOUNT_BRIEF_CHART_CLEANUP_FAILED', 'invented cleanup failure'); };
  const result = await continueRenewalPreparation({ ...f.options, localFileDeliveryAuthorized: true });
  assert.equal(attempts, 1);
  assert.ok(result.structuredContent.chart_delivery.every(c => c.state === 'unavailable'));
  assert.equal(result.structuredContent.next_action.kind, 'select_cards');
  assert.match(result.content[0].text, /CSAT was not returned/);
});

test('scope, package, expiry and conflicting revisions are checked before chart writes', async () => {
  const variants = [
    [f => { f.record.tester_id = 'other-invented-owner'; }, 'CASE_OWNER_MISMATCH'],
    [f => { f.run.caseId = 'other-invented-case'; }, 'RENEWAL_EVIDENCE_RUN_EXPIRED'],
    [f => { f.record.package_version = '0.0.1-invented'; }, 'CASE_VERSION_MISMATCH'],
    [f => { f.record.revision++; }, 'STALE_CASE_REVISION'],
    [f => { f.run.expiresAt = 0; }, 'RENEWAL_EVIDENCE_RUN_EXPIRED'],
    [f => { f.record.renewal_conversation.account_ref_digest = 'b'.repeat(64); }, 'ACCOUNT_INTELLIGENCE_ACCOUNT_MISMATCH'],
    [f => { f.record.renewal_conversation.run_ref_digest = 'c'.repeat(64); }, 'RENEWAL_COMPLETION_RUN_MISMATCH'],
  ];
  for (const [change, code] of variants) {
    const f = fixture(); change(f);
    await assert.rejects(continueRenewalPreparation({ ...f.options, localFileDeliveryAuthorized: true }), { code });
    assert.equal(f.creates, 0); assert.deepEqual(f.record.renewal_conversation.approvals, []);
  }
});

test('the run is revalidated after waiting and lost process memory is not reconstructed', async () => {
  const f = fixture(); f.run.state = 'collecting';
  f.run.evidencePromise = new Promise(resolve => setTimeout(() => { f.record.revision++; f.run.state = 'evidence_ready_with_gaps'; resolve(); }, 5));
  await assert.rejects(continueRenewalPreparation({ ...f.options, waitSeconds: 1, localFileDeliveryAuthorized: true }), { code: 'STALE_CASE_REVISION' });
  f.options.getRun = () => { throw new BetaError('RENEWAL_EVIDENCE_RUN_EXPIRED', 'invented restart'); };
  await assert.rejects(continueRenewalPreparation(f.options), { code: 'RENEWAL_EVIDENCE_RUN_EXPIRED' });
  assert.equal(f.creates, 0);
});

test('a pending call can complete in the same bounded wait with the original run and no approval change', async () => {
  const f = fixture(); f.run.state = 'collecting';
  f.run.evidencePromise = new Promise(resolve => setTimeout(() => { f.run.state = 'evidence_ready_with_gaps'; resolve(); }, 5));
  const result = await continueRenewalPreparation({ ...f.options, waitSeconds: 1 });
  assert.equal(result.structuredContent.status, 'evidence_ready_with_gaps');
  assert.equal(result.structuredContent.next_action.kind, 'select_cards');
  assert.equal(f.record.revision, 2); assert.deepEqual(f.record.renewal_conversation.approvals, []);
});

test('later review stages never ask for card selection again or infer an approval', async () => {
  for (const state of ['native_fit_required', 'review_ready', 'draft_action_pending']) {
    const f = fixture(); f.run.state = state; f.record.renewal_conversation.evidence_state = state;
    const before = JSON.stringify(f.record), result = await continueRenewalPreparation(f.options);
    assert.equal(result.structuredContent.next_action.kind, 'existing_review_step');
    assert.equal(JSON.stringify(f.record), before);
  }
});

test('insufficient evidence returns its candidates and gaps without choosing cards or filling missing values', async () => {
  const f = fixture(), project = f.options.projectEvidence;
  f.run.state = 'needs_csm_decision'; f.record.renewal_conversation.evidence_state = 'needs_csm_decision';
  f.options.projectEvidence = () => ({ ...project(), content_readiness: { state: 'needs_csm_decision' } });
  const result = await continueRenewalPreparation(f.options);
  assert.equal(result.structuredContent.next_action.kind, 'needs_csm_decision');
  assert.match(result.content[0].text, /CSAT was not returned/);
  assert.match(result.content[0].text, /\| pair:routing \|/);
  assert.doesNotMatch(result.content[0].text, /CSAT.*\|\s*0/);
});

test('unavailable chart history does not invent an image or ask for unnecessary file authorization', async () => {
  const f = fixture(); f.display.charts = [];
  const result = await continueRenewalPreparation(f.options);
  assert.equal(result.structuredContent.chart_delivery.length, 0);
  assert.equal(f.creates, 0); assert.doesNotMatch(result.content[0].text, /charts are available|!\[/i);
});

test('unrecognised review columns and inconsistent display order fail visibly rather than dropping data', async () => {
  const f = fixture(); f.review.tables[0].columns.push('Unexpected field');
  await assert.rejects(continueRenewalPreparation(f.options), { code: 'RENEWAL_PREPARATION_DISPLAY_INVALID' });
  const g = fixture(); g.display.sections.reverse();
  await assert.rejects(continueRenewalPreparation(g.options), { code: 'RENEWAL_PREPARATION_DISPLAY_INVALID' });
});

test('the coordinator accepts zero-wait status checks but never an unbounded wait', async () => {
  for (const waitSeconds of [-1, 26, 1.5, '25']) {
    const f = fixture();
    await assert.rejects(continueRenewalPreparation({ ...f.options, waitSeconds }), { code: 'INVALID_INPUT' });
  }
});
