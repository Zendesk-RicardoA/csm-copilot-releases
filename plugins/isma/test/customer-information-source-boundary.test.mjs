import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const skillPath = fileURLToPath(new URL("../skills/csm-copilot-beta/SKILL.md", import.meta.url));
const serverPath = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function assertPackagedIntegrity(relativePaths) {
  const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../config/approved-version-manifest.json", import.meta.url)), "utf8"));
  for (const relative of relativePaths) {
    const expected = manifest.integrity?.files?.[relative];
    assert.match(expected || "", /^[a-f0-9]{64}$/, `${relative} must be included in the packaged integrity manifest`);
    const actual = crypto.createHash("sha256").update(fs.readFileSync(`${packageRoot}/${relative}`)).digest("hex");
    assert.equal(actual, expected, `${relative} must match its packaged hash`);
  }
}

test("the beta skill forbids TAM toolkit customer-information fallbacks", () => {
  const skill = fs.readFileSync(skillPath, "utf8");
  assert.match(skill, /## Customer-information source boundary/);
  assert.match(skill, /Never call, delegate to, cite as evidence, or use the output of any `tam_\*`/);
  assert.match(skill, /A source gap is correct; a differently scoped answer is\s+not\./);
});

test("copy-ready bulk recipient addresses are opt-in and are never persisted to a case", () => {
  const skill = fs.readFileSync(skillPath, "utf8");
  const server = fs.readFileSync(serverPath, "utf8");
  const start = server.indexOf('if (name === "beta_run_bulk_contact_research")');
  const end = server.indexOf('if (name === "beta_get_renewal_preparation_options")', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = server.slice(start, end);
  assert.match(handler, /includeContactEmails: args\.include_copy_ready_emails === true/);
  assert.doesNotMatch(handler, /writeCase\(|recordRegisterEvent\(/);
  assert.match(skill, /include_copy_ready_emails: true/);
  assert.match(skill, /Never create an enrollment, send a message, save the addresses to the case/);
});

test("normal contact responses do not expose raw Gmail query instructions", () => {
  const server = fs.readFileSync(serverPath, "utf8");
  assert.doesNotMatch(server, /gmail_metadata_request/);
  assert.doesNotMatch(server, /optional_relationship_context/);
});

test("renewal evidence has one managed path and contact evidence has no parallel scheduler", () => {
  const skill = fs.readFileSync(skillPath, "utf8");
  const server = fs.readFileSync(serverPath, "utf8");
  const contactSource = fs.readFileSync(fileURLToPath(new URL("../mcp/journey-a-contact-evidence.mjs", import.meta.url)), "utf8");
  assert.match(server, /beta_wait_for_renewal_conversation_evidence/);
  assert.match(server, /beta_get_renewal_conversation_evidence/);
  assert.match(server, /beta_select_renewal_deck_content/);
  assert.match(server, /beta_revise_renewal_customer_copy/);
  assert.match(server, /beta_complete_renewal_conversation/);
  assert.match(server, /RENEWAL_ACCOUNT_ALREADY_ACTIVE/);
  assert.match(server, /run\.deckContent\.customer_slides/);
  assert.doesNotMatch(server, /limited_brief/);
  assert.match(server, /RENEWAL_CUSTOMER_COPY_REVISION_REQUIRED/);
  assert.match(server, /beta_record_renewal_partial_evidence_decision/);
  assert.match(server, /evidence_ready_with_gaps/);
  assert.match(server, /customer_content_review/);
  assert.doesNotMatch(server, /supported_hypotheses:/);
  assert.match(skill, /workflow: "renewal_conversation_brief"/);
  assert.match(skill, /customer_content_review\.tables/);
  assert.doesNotMatch(contactSource, /Promise\.all/);
});

test("renewal evidence and renderer source are integrity-bound for release packaging", () => {
  assertPackagedIntegrity(["mcp/renewal-conversation-brief.mjs", "mcp/renewal-conversation-renderer.mjs"]);
});

test("meeting-prep Gong selection is integrity-bound and cannot use raw call-content fields", () => {
  const selectionSource = fs.readFileSync(fileURLToPath(new URL("../mcp/meeting-prep-call-selection.mjs", import.meta.url)), "utf8");
  assert.match(selectionSource, /MART_GONG_CALLS_BCV/);
  assert.match(selectionSource, /PRESENTATION\.BULLSEYE_PRO\.SALES_ACTIVITY/);
  assert.match(selectionSource, /GONG_CONVERSATION_PARTICIPANTS_BCV/);
  assert.doesNotMatch(selectionSource, /call\.GONG_CALL_URL/);
  assert.doesNotMatch(selectionSource, /call\.GONG_CALL_TRANSCRIPT_CURATED/);
  assert.doesNotMatch(selectionSource, /GONG_CALL_TRANSCRIPTS_BCV/);
  assert.doesNotMatch(selectionSource, /EMAIL_ADDRESS/);
  assertPackagedIntegrity(["mcp/meeting-prep-call-selection.mjs", "mcp/meeting-prep-selected-call-evidence.mjs"]);
});

test("approved Converge is the primary full-call path, not a second Snowflake screening path", () => {
  const skill = fs.readFileSync(skillPath, "utf8");
  const start = skill.indexOf("### Gong discovery and selected-call evidence through Converge");
  const end = skill.indexOf("When preparing `CustomerContentV1`", start);
  const flow = skill.slice(start, end);
  assert.match(flow, /beta_start_converge_call_lookup/);
  assert.match(flow, /beta_get_selected_converge_call_request/);
  assert.match(flow, /beta_bind_converge_call_evidence/);
  assert.match(flow, /Do not call\s+`beta_start_selected_call_evidence`/);
  assert.match(flow, /Multiple account\/opportunity associations are legitimate/);
  assert.doesNotMatch(flow, /obtain.*confirmation|no_service_data: true|no_suspected_l5: true/);
  assertPackagedIntegrity(["mcp/converge-meeting-prep.mjs", "mcp/server.mjs", "skills/csm-copilot-beta/SKILL.md", "config/source-connection-policy.json"]);
});

test("account-level book queries are integrity-bound and cannot fall back to raw SQL or customer content", () => {
  const portfolioSource = fs.readFileSync(fileURLToPath(new URL("../mcp/book-of-business-portfolio-query.mjs", import.meta.url)), "utf8");
  const productSources = fs.readFileSync(fileURLToPath(new URL("../mcp/product-analytics-sources.mjs", import.meta.url)), "utf8");
  assert.match(portfolioSource, /PRODUCT_ANALYTICS_SOURCES\.copilot/);
  assert.match(productSources, /FUNCTIONAL\.PRODUCT_ANALYTICS\.COPILOT_CRM_DAILY_SNAPSHOT/);
  assert.doesNotMatch(productSources, /PRODUCT_ANALYTICS_V2/);
  assert.match(portfolioSource, /CRM_RENEWAL_OWNER_NAME/);
  assert.match(portfolioSource, /CRM_IS_COPILOT_PAID_PENETRATED/);
  assert.doesNotMatch(portfolioSource, /GAINSIGHT_CALL_TO_ACTION_BCV/);
  assert.doesNotMatch(portfolioSource, /SALESFORCE_CONTACT/);
  assert.doesNotMatch(portfolioSource, /GONG_/);
  assert.doesNotMatch(portfolioSource, /TRANSCRIPT/);
  assertPackagedIntegrity(["mcp/book-of-business-portfolio-query.mjs", "mcp/book-of-business-read-session.mjs", "mcp/book-of-business-read-jobs.mjs", "mcp/product-analytics-sources.mjs"]);
});
