// Source-only renewal coordination. No query, approval, renderer or persistence API lives here.
import path from 'node:path';
import { BetaError } from './core.mjs';
import { renewalRunDigest } from './renewal-completion.mjs';

const REVIEW_COLUMNS = Object.freeze({
  annual_point_of_view: ['draft_point_of_view', 'state'],
  progress_metric_candidates: ['id', 'metric', 'customer_headline', 'comparison', 'why_it_matters'],
  linked_opportunities_and_focus: ['number', 'id', 'opportunity', 'what_the_data_shows', 'customer_impact',
    'question_to_validate', 'focus_area', 'why_now', 'practical_next_step', 'how_zendesk_can_help', 'expected_outcome'],
  csm_provided_context: ['statement', 'basis', 'source_status', 'commercial_access'],
});
const SOURCE_NAMES = Object.freeze({
  gainsight_account_context: 'account details', company_profile: 'the company profile', renewal_timing: 'renewal dates and ownership',
  commercial_subscriptions: 'current subscriptions', guide_adoption: 'Guide adoption', copilot_adoption: 'Copilot adoption',
  ai_agents_adoption: 'AI Agents adoption', suite_adoption: 'Suite adoption', basic_tools_adoption: 'basic workflow use',
  team_and_tech_context: 'team and configuration details', related_account_ctas: 'related work items',
  rba_metrics: 'support performance', ticket_channels: 'ticket channels', guide_knowledge_views: 'Help Center views',
  peer_benchmarks: 'peer comparisons', account_gong_metadata: 'recent call details', account_gong_spotlight: 'recent call notes',
  historical_sla_policies: 'historical SLA configuration',
});
const REVIEW_GATES = ['identity', 'evidence', 'renewal_hypotheses', 'renewal_content'];
const GATE_NAMES = { identity: 'account and CTA identity', evidence: 'account evidence', renewal_hypotheses: 'proposed focus areas', renewal_content: 'exact customer wording' };
const FILE_SAFETY_ERRORS = new Set(['ACCOUNT_BRIEF_CHART_STORAGE_UNSAFE', 'ACCOUNT_BRIEF_CHART_CLEANUP_FAILED']);
const readyStates = new Set(['evidence_ready', 'evidence_ready_with_gaps', 'needs_csm_decision', 'native_fit_required', 'review_ready', 'draft_action_pending']);
const displayError = () => new BetaError('RENEWAL_PREPARATION_DISPLAY_INVALID', 'The approved renewal display could not be assembled without losing information. Keep the current evidence; do not replace it with a shorter summary or start another read.');
const cell = value => {
  if (value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) throw displayError();
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
};

function reviewMarkdown(review) {
  if (!Array.isArray(review?.tables) || !review.tables.length) throw displayError();
  return review.tables.map(table => {
    const keys = REVIEW_COLUMNS[table.id];
    if (!keys || !Array.isArray(table.columns) || table.columns.length !== keys.length || !Array.isArray(table.rows) || !table.title) throw displayError();
    for (const row of table.rows) if (Object.keys(row).some(key => !keys.includes(key))) throw displayError();
    return `### ${cell(table.title)}\n\n| ${table.columns.map(cell).join(' | ')} |\n| ${keys.map(() => '---').join(' | ')} |\n`
      + (table.rows.map(row => `| ${keys.map(key => cell(row[key])).join(' | ')} |`).join('\n') || '\nNo candidates were returned for this table.');
  }).join('\n\n');
}

function checkScope({ run, record, caseId, runId, ownerRef, packageVersion, now }) {
  if (!run || run.caseId !== caseId || run.testerId !== ownerRef || !Number.isFinite(run.expiresAt) || run.expiresAt <= now) {
    throw new BetaError('RENEWAL_EVIDENCE_RUN_EXPIRED', 'The renewal evidence is no longer available. Use a fresh governed selection; expired evidence is not restored.');
  }
  if (record?.tester_id !== ownerRef) throw new BetaError('CASE_OWNER_MISMATCH', 'The case belongs to another tester.');
  if (record.case_id !== caseId) throw new BetaError('RENEWAL_EVIDENCE_RUN_EXPIRED', 'Use the case that owns this renewal run.');
  if (record.package_version !== packageVersion) throw new BetaError('CASE_VERSION_MISMATCH', 'The case was created with a different approved package.');
  if (record.revision !== run.revision) throw new BetaError('STALE_CASE_REVISION', 'The case changed while preparation was running. Do not carry an older brief into the current review.');
  if (record.renewal_conversation?.run_ref_digest !== renewalRunDigest(runId)) throw new BetaError('RENEWAL_COMPLETION_RUN_MISMATCH', 'Use the renewal run issued for this case.');
  const evidenceAccount = run.evidence?.account_intelligence_receipt?.account_ref_digest;
  if (!/^[a-f0-9]{64}$/.test(record.renewal_conversation.account_ref_digest || '')
      || evidenceAccount && evidenceAccount !== record.renewal_conversation.account_ref_digest) {
    throw new BetaError('ACCOUNT_INTELLIGENCE_ACCOUNT_MISMATCH', 'The account evidence does not match this renewal account.');
  }
}

function actionFor(run, record, projected) {
  if (run.state === 'native_fit_required') return { kind: 'existing_review_step', step: 'native_fit',
    instruction: 'Complete the existing read-only native layout check before asking for wording approval. No draft is authorized.' };
  if (run.state === 'review_ready') {
    const completed = new Set((record.renewal_conversation.approvals || []).filter(a => a.revision === record.revision).map(a => a.gate));
    const gate = REVIEW_GATES.find(g => !completed.has(g));
    return { kind: 'existing_review_step', step: gate || 'draft_authorization',
      instruction: gate ? `Continue the existing review of ${GATE_NAMES[gate]}. Do not ask for card selection again or infer approval.`
        : 'All recorded reviews are complete. A separate explicit request is still required to create a private draft.' };
  }
  if (run.state === 'draft_action_pending') return { kind: 'existing_review_step', step: 'private_builder_handoff',
    instruction: 'Continue the already authorized private-builder handoff. A prepared request is not proof that a deck was created or reviewed.' };
  if (['evidence_ready', 'evidence_ready_with_gaps'].includes(run.state) && projected.content_readiness?.state === 'ready_for_csm_selection') {
    return { kind: 'select_cards', instruction: 'Choose one to three progress-card IDs and one to three linked opportunity/focus IDs from the tables. This selects content; it does not approve wording or authorize a draft.' };
  }
  return { kind: 'needs_csm_decision', instruction: 'Review the available evidence, candidates and gaps. Add relevant context, retry later or skip this account using the existing controls; do not invent missing cards.' };
}

function result(body, metadata) {
  return { isError: false, content: [{ type: 'text', text: body }, { type: 'text', text: JSON.stringify(metadata) }], structuredContent: metadata };
}

/** Every callback is a fixed existing capability supplied by the server, never a caller-selected tool or query. */
export async function continueRenewalPreparation({ caseId, runId, ownerRef, packageVersion, waitSeconds = 25,
  localFileDeliveryAuthorized = false, getRun, getCase, projectEvidence, createChart, nowMs = Date.now }) {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 25 || typeof localFileDeliveryAuthorized !== 'boolean') {
    throw new BetaError('INVALID_INPUT', 'Use a wait of zero to 25 seconds and explicit temporary-image authorization.');
  }
  const current = () => {
    const run = getRun(), record = getCase();
    checkScope({ run, record, caseId, runId, ownerRef, packageVersion, now: nowMs() });
    return { run, record };
  };
  let { run, record } = current();
  // Consent is transient and scoped to this run. It never survives a restart or extends evidence/image retention.
  if (localFileDeliveryAuthorized) run.preparationChartAuthorization = true;
  if (run.state === 'collecting' && waitSeconds > 0) {
    let timer;
    try { await Promise.race([run.evidencePromise, new Promise(resolve => { timer = setTimeout(resolve, waitSeconds * 1000); })]); }
    finally { clearTimeout(timer); }
  }
  ({ run, record } = current());
  if (run.state === 'collecting') {
    const progress = run.sourceProgress || {};
    const elapsed = Math.max(0, Math.floor((nowMs() - (run.startedAt ?? nowMs())) / 1000));
    const continuation = { case_id: caseId, renewal_conversation_run_id: runId, wait_seconds: 25 };
    const body = `Still preparing this renewal brief. Checking ${SOURCE_NAMES[progress.source] || 'account evidence'}${progress.attempt ? ` (attempt ${progress.attempt})` : ''}.`
      + (progress.stage === 'account_evidence_recovery' ? ' The bounded recovery pass is running.' : '')
      + ` ${elapsed} seconds have elapsed. No action is needed from you.`;
    return result(body, { contract: 'renewal-preparation-delivery-v1', status: 'collecting', case_id: caseId,
      renewal_conversation_run_id: runId, revision: record.revision, source_progress: { ...progress,
        elapsed_seconds: elapsed, stage_elapsed_seconds: Math.max(0, Math.floor((nowMs() - (run.stageStartedAt ?? run.startedAt ?? nowMs())) / 1000)) },
      next_action: { kind: 'continue_preparation', tool: 'beta_continue_renewal_preparation', arguments: continuation },
      chart_delivery: [], chart_visibility: 'unverified', source_read_restarted: false });
  }
  if (!readyStates.has(run.state) || !run.evidence) throw new BetaError('RENEWAL_EVIDENCE_DECISION_REQUIRED', 'The current renewal evidence is not available for preparation delivery.');

  // Serialize delivery for this run: simultaneous polls must not race the existing file service's first image creation.
  const previous = run.preparationDeliveryTask || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    ({ run, record } = current());
    const projected = projectEvidence(run), display = projected.account_brief_display;
    if (!display?.markdown || !Array.isArray(display.sections) || display.sections.map(s => s.markdown).join('\n\n') !== display.markdown
        || JSON.stringify(display.sections.map(s => s.id)) !== JSON.stringify(display.delivery_contract?.required_section_order)) throw displayError();
    const candidates = reviewMarkdown(projected.customer_content_review);
    const charts = display.charts || [];
    if (charts.length && !display.sections.some(s => s.id === 'support_operations')) throw displayError();
    const deliveries = [];
    let stopFiles = null;
    if (run.preparationChartAuthorization && charts.length) {
      run.preparationChartExpiresAt ??= Math.min(run.expiresAt, nowMs() + 900_000);
    }
    for (const chart of charts) {
      ({ run, record } = current());
      if (!run.preparationChartAuthorization) { deliveries.push({ chart_id: chart.id, title: chart.title, state: 'not_authorized' }); continue; }
      if (stopFiles) { deliveries.push({ chart_id: chart.id, title: chart.title, state: 'unavailable', code: stopFiles }); continue; }
      try {
        const until = Math.min(run.expiresAt, run.preparationChartExpiresAt);
        if (until <= nowMs()) throw new BetaError('ACCOUNT_BRIEF_CHART_EXPIRED', 'The original chart delivery has expired.');
        const delivery = await createChart({ display, chartId: chart.id, authorized: true, ownerRef,
          accountRefDigest: record.renewal_conversation.account_ref_digest, evidenceRef: runId, expiresAt: until });
        ({ run, record } = current());
        if (delivery?.method !== 'markdown_local_image' || !path.isAbsolute(delivery.file_path || '') || !delivery.markdown?.startsWith('![')
            || !Number.isFinite(Date.parse(delivery.expires_at)) || Date.parse(delivery.expires_at) > until || Date.parse(delivery.expires_at) <= nowMs()) {
          throw new BetaError('ACCOUNT_BRIEF_CHART_DELIVERY_INVALID', 'The chart service did not return a current bounded native image.');
        }
        deliveries.push({ chart_id: chart.id, title: chart.title, state: 'prepared', file_path: delivery.file_path,
          markdown: delivery.markdown, expires_at: delivery.expires_at });
      } catch (error) {
        // Revalidate after a slow file operation before returning any account content.
        ({ run, record } = current());
        const code = error instanceof BetaError && /^ACCOUNT_BRIEF_CHART_[A-Z_]+$/.test(error.code) ? error.code : 'ACCOUNT_BRIEF_CHART_FILE_CREATE_FAILED';
        if (FILE_SAFETY_ERRORS.has(code)) stopFiles = code;
        deliveries.push({ chart_id: chart.id, title: chart.title, state: 'unavailable', code });
      }
    }
    const prepared = deliveries.filter(c => c.state === 'prepared');
    const failed = deliveries.filter(c => c.state === 'unavailable');
    let chartText = prepared.map(c => c.markdown).join('\n\n');
    if (prepared.length) {
      const expiry = new Date(Math.min(...prepared.map(c => Date.parse(c.expires_at)))).toISOString();
      chartText += `\n\nTemporary chart images expire at ${expiry} and may no longer load afterward. Chart visibility has not been confirmed.`;
    }
    if (failed.length) chartText += `${chartText ? '\n\n' : ''}Charts could not be prepared for: ${failed.map(c => cell(c.title)).join('; ')}. The verified tables remain available.`;
    const offerCharts = deliveries.some(c => c.state === 'not_authorized') && !run.preparationChartOfferPrepared;
    if (offerCharts) chartText += `${chartText ? '\n\n' : ''}Charts are available from this evidence. You can authorize private temporary images, deleted within 15 minutes or when the brief expires, without another account read.`;
    const body = display.sections.map(section => section.markdown + (section.id === 'support_operations' && chartText ? `\n\n${chartText}` : '')).join('\n\n');
    const action = actionFor(run, record, projected);
    if (offerCharts) run.preparationChartOfferPrepared = true;
    return result(`${body}\n\n## Renewal content to choose\n\n${candidates}\n\n${action.instruction}`, {
      contract: 'renewal-preparation-delivery-v1', status: run.state, case_id: caseId, renewal_conversation_run_id: runId,
      revision: record.revision, next_action: action, delivery_contract: display.delivery_contract,
      candidate_table_ids: projected.customer_content_review.tables.map(table => table.id),
      account_brief_read_state: display.read_state,
      conversation_briefing: { ...display.conversation_briefing,
        rows: run.evidence.review_package?.shared_account_intelligence?.sections?.recent_conversations?.facts?.recent_calls || [] },
      review_window: { expires_at: new Date(run.expiresAt).toISOString(),
        remaining_seconds: Math.max(0, Math.ceil((run.expiresAt - nowMs()) / 1000)), extends_on_activity: false },
      chart_delivery: deliveries, chart_visibility: 'unverified', chart_authorization_offer_included: offerCharts,
      execution_receipt: projected.execution_receipt,
      source_gap_codes: projected.source_gap_codes || [], source_read_restarted: false,
      instruction: 'Copy the complete first text block verbatim into the final answer, including its opening note, headings, capitalization, punctuation and next-action wording. Do not polish, shorten, restyle or append another chart offer or selection request. Preserve all sections, tables, candidate rows and image Markdown; do not print this metadata. Only the existing recent-call Summary and Next steps cells may be paraphrased from the same cached notes. An available or prepared chart is not proof of CSM-visible delivery.',
    });
  });
  run.preparationDeliveryTask = task;
  try { return await task; }
  finally { if (run.preparationDeliveryTask === task) delete run.preparationDeliveryTask; }
}
