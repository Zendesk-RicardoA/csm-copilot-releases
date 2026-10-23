import test from "node:test";
import assert from "node:assert/strict";
import { routeWorkflowIntent } from "../mcp/journey-orchestrator.mjs";
import { readOwnedCtaQueueWithSession } from "../mcp/journey-a-cta-queue.mjs";
import { presentDailyFocusWorkSignals } from "../mcp/daily-focus-work-signals.mjs";
import { presentPortfolioRelationships } from "../mcp/journey-a-portfolio-relationships.mjs";
import { readBookOfBusinessSummaryWithSession } from "../mcp/book-of-business-analytics.mjs";
import { readBookOfBusinessPortfolioQueryWithSession } from "../mcp/book-of-business-portfolio-query.mjs";
import { recommendContacts } from "../mcp/journey-a-contact-evidence.mjs";
import { buildOutreachPack } from "../mcp/outreach-pack.mjs";
import { buildRenewalConversationBrief, renewalPreparationChoice } from "../mcp/renewal-conversation-brief.mjs";
import { readSelectedCallEvidenceWithSession } from "../mcp/meeting-prep-selected-call-evidence.mjs";
import { createAuthorizedCase, bindDerivedEvidence } from "../mcp/real-beta.mjs";
import { ACCOUNT_INTELLIGENCE_CORE_CONTRACT, ACCOUNT_INTELLIGENCE_CORE_SECTIONS, ACCOUNT_INTELLIGENCE_CORE_VERSION, RECOMMENDATION_REVIEW_SECTIONS, approveGate, bindAccountIntelligenceCore, bindRecommendationReviewPackage } from "../mcp/core.mjs";
import { bindMeetingPrepDraftInput, meetingPrepDraftEvidenceRefs } from "../mcp/meeting-prep-draft-binding.mjs";
import { prepareMeetingPrepDraftReview } from "../mcp/meeting-prep-draft-review.mjs";
import { inventedMeetingPrepDraft, INVENTED_MASTER_INVENTORY } from "./fixtures/meeting-prep-draft-input.mjs";

const at = new Date("2026-09-24T10:00:00Z");
const ctaRows = [
  { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
  { ROW_TYPE: "cta", CTA_ID: "invented-cta-1", ACCOUNT_ID: "invented-account-1", ACCOUNT_NAME: "Invented Orchard", CTA_NAME: "P1: Non-Monthly Renewal", CTA_STATUS: "New", CTA_CREATED_AT: "2026-09-20T10:00:00Z", CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue" },
];

test("invented Daily Focus routes, reads a governed case-free work digest, and labels a relationship gap", async () => {
  assert.equal(routeWorkflowIntent("broad_focus").route, "daily_operating_layer");
  const session = { query: async (sql, options) => {
    assert.match(sql, /authenticated_csm/);
    assert.ok(options.timeoutMs <= 25_000);
    return ctaRows;
  } };
  const queue = await readOwnedCtaQueueWithSession({ session, now: at });
  const digest = presentDailyFocusWorkSignals(queue);
  const relationships = presentPortfolioRelationships([
    { ROW_TYPE: "scope", SCOPE_COUNT: 1 },
    { ROW_TYPE: "account", CTA_ID: "invented-cta-1", ACCOUNT_ID: "invented-account-1", ACCOUNT_NAME: "Invented Orchard", CTA_NAME: "P1: Non-Monthly Renewal", SALESFORCE_ACTIVITY_COUNT: 0 },
  ], 60, at);
  assert.equal(queue.queue.length, 1);
  assert.equal(digest.work_signals.length, 1);
  assert.equal(digest.work_signals[0].ctaDisposition, "queue");
  assert.equal(relationships.accounts[0].recent_relationship_in_past_days.state, "needs_gmail_metadata_check");
});

test("invented book analysis answers both aggregate and account-list questions", async () => {
  const aggregate = await readBookOfBusinessSummaryWithSession({
    session: { query: async (_sql, options) => {
      assert.equal(options.timeoutMs, 120_000);
      return [{ ROW_TYPE: "scope", SCOPE_COUNT: 1 }, { ROW_TYPE: "summary", ACCOUNT_COUNT: 1, NET_ARR_USD: 12000, ACCOUNTS_MISSING_NET_ARR: 0 }, { ROW_TYPE: "group", DIMENSION_1: "EMEA", ACCOUNT_COUNT: 1, NET_ARR_USD: 12000, ACCOUNTS_MISSING_NET_ARR: 0 }];
    } },
    dimensions: ["crm_region"], now: at,
  });
  const list = await readBookOfBusinessPortfolioQueryWithSession({
    session: { query: async () => [{ ROW_TYPE: "scope", SCOPE_COUNT: 1 }, { ROW_TYPE: "account", MATCHED_ACCOUNT_COUNT: 1, ACCOUNT_NAME: "Invented Orchard", CRM_REGION: "EMEA" }] },
    filters: [{ field: "crm_region", operator: "equals", value: "EMEA" }],
    columns: ["account_name", "crm_region"], now: at,
  });
  assert.equal(aggregate.summary.account_count, 1);
  assert.equal(list.accounts[0].account_name, "Invented Orchard");
});

test("invented outreach uses the selected CTA and ranked contact without sending", async () => {
  assert.equal(routeWorkflowIntent("outreach").route, "journey_a");
  const queue = await readOwnedCtaQueueWithSession({ session: { query: async () => ctaRows }, now: at });
  const selected = queue.queue[0];
  const ranked = recommendContacts([{
    contact_ref: "contact:invented-one", display_name: "Invented Contact", role: "Support Director", identity_status: "eligible", latest_recorded_sales_touch_at: "2026-09-18T10:00:00Z",
  }], { contact_snapshot: "checked" }, 3, at);
  const pack = buildOutreachPack({ brief: { account_name: "Invented Orchard" }, contacts: ranked.contacts, sourceStates: { contact_snapshot: "checked" }, sourceGaps: [], status: "contacts_ready_metrics_pending" });
  assert.ok(selected.work_item_ref);
  assert.equal(ranked.state, "ranked");
  assert.doesNotMatch(JSON.stringify(pack), /sent_at|gmail_message_id/);
});

test("invented renewal prep preserves a source gap and does not authorize a deck", () => {
  assert.equal(routeWorkflowIntent("renewal_conversation_brief").route, "journey_a");
  const selectedCta = { priority: "P1", cta_title: "P1: Non-Monthly Renewal" };
  assert.equal(renewalPreparationChoice(selectedCta, { explicitlyRequested: true }).preparation_mode, "renewal_conversation_brief");
  const brief = buildRenewalConversationBrief({ accountContextRow: null, selectedCta, sourceStates: { account_context: "unavailable" }, now: at });
  assert.equal(brief.content_readiness.state, "needs_csm_decision");
  assert.equal(brief.customer_slides.length, 3);
  assert.ok(brief.source_gaps.includes("ACCOUNT_CONTEXT_UNAVAILABLE"));
});

test("invented meeting prep screens a selected call, binds same-account brief, and gates private draft", async () => {
  assert.equal(routeWorkflowIntent("meeting_preparation").route, "journey_b");
  const evidence = await readSelectedCallEvidenceWithSession({
    session: { query: async (sql) => {
      if (sql.includes("transcript_count")) return [{ TRANSCRIPT_COUNT: 1, SOURCE_UPDATED_AT: "2026-08-12T00:00:00Z" }];
      if (sql.includes("safety_state")) return [{ CHUNK_INDEX: 0, CHUNK_COUNT: 1, SAFETY_STATE: "clear" }];
      return [{ CHUNK_INDEX: 0, CHUNK_COUNT: 1, FINDING_INDEX: 0, CATEGORY: "goal", PARAPHRASE: "The team wants fewer manual routing steps.", TOPIC_REFERENCE: "00:03:00", CONFIDENCE: "high" }];
    } },
    call: { conversationKey: "invented_key_123", accountId: "001000000000000", callAt: "2026-08-11T09:30:00Z" },
    model: "llama3.1-8b", sourceDigest: "a".repeat(64),
  });
  let record = createAuthorizedCase({ input: { source_locator_digest: "a".repeat(64), language: "en", recording_present: true, selected_call_only: true }, testerId: "invented-owner", manifest: { package_version: "invented", renderer_baseline: "recovery-v3" } });
  record.account_ref_digest = "b".repeat(64);
  assert.throws(() => approveGate(record, { gate: "evidence", revision: record.revision, testerId: "invented-owner" }));
  record = bindAccountIntelligenceCore(record, { contract: ACCOUNT_INTELLIGENCE_CORE_CONTRACT, schemaVersion: ACCOUNT_INTELLIGENCE_CORE_VERSION, contentDigest: "c".repeat(64), briefState: "complete", sectionStates: Object.fromEntries(ACCOUNT_INTELLIGENCE_CORE_SECTIONS.map((section) => [section, "checked"])), accountRefDigest: record.account_ref_digest, revision: record.revision, testerId: "invented-owner" });
  record = bindDerivedEvidence(record, { digest: evidence.receipt.evidence_digest, findingCount: evidence.receipt.finding_count, testerId: "invented-owner" });
  record = approveGate(record, { gate: "identity", revision: record.revision, testerId: "invented-owner" });
  record = approveGate(record, { gate: "evidence", revision: record.revision, testerId: "invented-owner" });
  record = bindRecommendationReviewPackage(record, { reviewPackageDigest: "d".repeat(64), sections: RECOMMENDATION_REVIEW_SECTIONS,
    recommendationRefs: [1, 2, 3, 4].map((n) => `recommendation:${n}`), revision: record.revision, testerId: "invented-owner" });
  record = approveGate(record, { gate: "recommendations", revision: record.revision, testerId: "invented-owner" });
  const input = inventedMeetingPrepDraft(record);
  record = prepareMeetingPrepDraftReview(record, input, INVENTED_MASTER_INVENTORY, "invented-owner");
  record = approveGate(record, { gate: "customer_content", revision: record.revision, testerId: "invented-owner" });
  const bridge = bindMeetingPrepDraftInput(record, input);
  assert.equal(bridge.reviewedCaseEvidence.selected_call_evidence_digest, evidence.receipt.evidence_digest);
  assert.equal(bridge.reviewedCaseEvidence.account_ref_digest, record.account_ref_digest);
});
