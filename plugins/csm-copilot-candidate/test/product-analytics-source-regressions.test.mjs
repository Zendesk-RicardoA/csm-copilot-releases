import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRenewalGuideAdoptionSql, buildRenewalCopilotAdoptionSql,
  buildRenewalSuiteAdoptionSql, buildRenewalBasicToolsAdoptionSql,
  buildRenewalAiAgentsAdoptionSql, buildRenewalTeamAndTechContextSql, buildRenewalHistoricalSlaPolicySql,
  buildRenewalConversationBrief, readRenewalConversationEvidenceWithSession,
} from "../mcp/renewal-conversation-brief.mjs";
import { buildAccountContextSql, buildContactEvidenceSql } from "../mcp/journey-a-contact-evidence.mjs";
import { buildBookOfBusinessPortfolioQuerySql } from "../mcp/book-of-business-portfolio-query.mjs";
import { buildAccountIntelligenceDisplay } from "../mcp/account-intelligence-display.mjs";

const ACCOUNT = "001000000000000AAA";
const NOW = new Date("2026-10-14T12:00:00Z");
const policies = {
  ACCOUNT_NAME: "Invented Company", TEAM_SETUP_INSTANCE_COUNT: 2,
  TEAM_SETUP_HISTORICAL_SLA_TOTAL_POLICY_COUNT: 3,
  TEAM_SETUP_HISTORICAL_SLA_MAX_POLICY_COUNT: 3,
  TEAM_SETUP_HISTORICAL_SLA_POSITIVE_INSTANCE_COUNT: 1,
  TEAM_SETUP_HISTORICAL_SLA_COVERED_INSTANCE_COUNT: 2,
  TEAM_SETUP_HISTORICAL_SLA_UNKNOWN_INSTANCE_COUNT: 0,
  TEAM_SETUP_HISTORICAL_SLA_CONFLICT_INSTANCE_COUNT: 0,
  TEAM_SETUP_HISTORICAL_SLA_OLDEST_DATE: "2025-01-28",
  TEAM_SETUP_HISTORICAL_SLA_NEWEST_DATE: "2025-01-30",
};
function review(row = policies) {
  return buildRenewalConversationBrief({ accountContextRow: row, now: NOW,
    sourceStates: { account_context: "checked", team_setup_and_tech_stack: "checked" } });
}

for (const [name, build, table] of [
  ["Guide", buildRenewalGuideAdoptionSql, "GUIDE_ADOPTION_CRM_DAILY_SNAPSHOT"],
  ["Copilot", buildRenewalCopilotAdoptionSql, "COPILOT_CRM_DAILY_SNAPSHOT"],
  ["Suite", buildRenewalSuiteAdoptionSql, "ZENDESK_SUITE_CRM_DAILY_SNAPSHOT"],
  ["Basic tools", buildRenewalBasicToolsAdoptionSql, "BASIC_TOOLS_AND_RULES_CRM_DAILY_SNAPSHOT"],
  ["AI Agents", buildRenewalAiAgentsAdoptionSql, "AI_AGENTS_CRM_DAILY_SNAPSHOT"],
]) {
  test(`${name} uses the approved non-V2 source, scoped independently to the selected account`, () => {
    const sql = build(ACCOUNT);
    assert.ok(sql.includes(`FROM FUNCTIONAL.PRODUCT_ANALYTICS.${table}`));
    assert.ok(sql.includes(`WHERE CRM_ACCOUNT_ID = '${ACCOUNT}'`));
    assert.match(sql, /ORDER BY SOURCE_SNAPSHOT_DATE DESC/);
    assert.doesNotMatch(sql, /PRODUCT_ANALYTICS_V2|CURRENT_DATE\(\) - 1|\bJOIN\b|COALESCE/);
    assert.throws(() => build("unscoped'; SELECT 1"), { code: "INVALID_ACCOUNT_SELECTION" });
  });
}

test("both outreach reads and the in-book Copilot filter use the same approved sources", () => {
  for (const build of [buildAccountContextSql, buildContactEvidenceSql]) {
    const sql = build(ACCOUNT);
    assert.match(sql, /FUNCTIONAL\.PRODUCT_ANALYTICS\.GUIDE_ADOPTION_CRM_DAILY_SNAPSHOT/);
    assert.match(sql, /FUNCTIONAL\.PRODUCT_ANALYTICS\.COPILOT_CRM_DAILY_SNAPSHOT/);
    assert.doesNotMatch(sql, /PRODUCT_ANALYTICS_V2/);
    assert.match(sql, /LEFT JOIN guide_adoption/);
    assert.match(sql, /LEFT JOIN copilot_adoption/);
  }
  const sql = buildBookOfBusinessPortfolioQuerySql({
    columns: ["account_name", "copilot_paid_status", "copilot_snapshot_date"],
    filters: [{ field: "copilot_paid_status", operator: "equals", value: "paid_not_adopted" }],
  });
  assert.match(sql, /FUNCTIONAL\.PRODUCT_ANALYTICS\.COPILOT_CRM_DAILY_SNAPSHOT/);
  assert.doesNotMatch(sql, /PRODUCT_ANALYTICS_V2/);
  assert.match(sql, /company\.SUCCESS_OWNER_C_GC = authenticated_csm\.GSID/);
  assert.match(sql, /WHEN copilot\.CRM_ACCOUNT_ID IS NULL THEN 'not_assessed'/);
  assert.doesNotMatch(sql, /COALESCE\(copilot\.paid_adopted, FALSE\)/);
});

test("selected contact evidence takes the account's latest available snapshot for each product", () => {
  const sql = buildContactEvidenceSql(ACCOUNT);
  assert.match(sql, /FROM FUNCTIONAL\.PRODUCT_ANALYTICS\.GUIDE_ADOPTION_CRM_DAILY_SNAPSHOT\n  WHERE CRM_ACCOUNT_ID = \(SELECT account_id FROM account_brief\)\n  QUALIFY ROW_NUMBER\(\) OVER \(ORDER BY SOURCE_SNAPSHOT_DATE DESC\) = 1/);
  assert.match(sql, /FROM FUNCTIONAL\.PRODUCT_ANALYTICS\.COPILOT_CRM_DAILY_SNAPSHOT\n  WHERE CRM_ACCOUNT_ID = \(SELECT account_id FROM account_brief\)\n  QUALIFY ROW_NUMBER\(\) OVER \(ORDER BY SOURCE_SNAPSHOT_DATE DESC\) = 1/);
  assert.doesNotMatch(sql, /latest_guide_snapshot|latest_copilot_snapshot|CURRENT_DATE\(\) - 1/);
});

test("historical SLA read is separate, selected-account scoped, and date attributed", () => {
  const sql = buildRenewalHistoricalSlaPolicySql(ACCOUNT);
  assert.match(sql, /FUNCTIONAL\.PRODUCT_ANALYTICS\.BQ_PRODUCT_ARCHIVE_SLA_POLICIES_EDW/);
  assert.match(sql, /JOIN account_instances AS instance ON archive\.ACCOUNT_ID = instance\.instance_account_id/);
  assert.match(sql, /PARTITION BY archive\.ACCOUNT_ID/);
  assert.match(sql, /MIN\(run_at\)::DATE/);
  assert.match(sql, /MAX\(run_at\)::DATE/);
  assert.match(sql, /NUM_SLAS_ACTIVE > 0/);
  assert.match(sql, /CRM_ACCOUNT_ID = '001000000000000AAA'/);
  assert.match(sql, /unknown_policy_instance_count/);
  assert.match(sql, /conflict_instance_count/);
  assert.throws(() => buildRenewalHistoricalSlaPolicySql("unscoped'"), { code: "INVALID_ACCOUNT_SELECTION" });
});

for (const [name, build] of [["shared renewal/meeting", buildRenewalTeamAndTechContextSql], ["outreach", buildAccountContextSql]]) {
  test(`${name} setup remains available if the historical archive fails`, () => {
    const sql = build(ACCOUNT);
    assert.match(sql, /NULL::BOOLEAN AS team_setup_sla_active/);
    assert.doesNotMatch(sql, /PRODUCT_ANALYTICS_V2|CRM_HAS_SLA_OLA_ACTIVE_USAGE/);
    assert.doesNotMatch(sql, /BQ_PRODUCT_ARCHIVE_SLA_POLICIES_EDW/);
    assert.match(sql, /FUNCTIONAL\.PRODUCT_ANALYTICS\.SECURITY_FEATURES_INSTANCE_DAILY_SNAPSHOT/);
    assert.match(sql, /FUNCTIONAL\.PRODUCT_ANALYTICS\.BASIC_TOOLS_AND_RULES_INSTANCE_DAILY_SNAPSHOT/);
    assert.match(sql, /FUNCTIONAL\.PRODUCT_ANALYTICS\.GUIDE_ADOPTION_INSTANCE_DAILY_SNAPSHOT/);
    assert.match(sql, /MIN\(SOURCE_SNAPSHOT_DATE\) AS security_oldest_snapshot_date/);
    assert.match(sql, /MAX\(SOURCE_SNAPSHOT_DATE\) AS security_newest_snapshot_date/);
    assert.match(sql, /MIN\(SOURCE_SNAPSHOT_DATE\) AS basic_tools_oldest_snapshot_date/);
    assert.match(sql, /MAX\(SOURCE_SNAPSHOT_DATE\) AS basic_tools_newest_snapshot_date/);
    assert.match(sql, /MIN\(SOURCE_SNAPSHOT_DATE\) AS guide_connector_oldest_snapshot_date/);
    assert.match(sql, /MAX\(SOURCE_SNAPSHOT_DATE\) AS guide_connector_newest_snapshot_date/);
    assert.doesNotMatch(sql, /CURRENT_DATE\(\) - 1/);
  });
}

test("historical policies retain dates, coverage and positive-instance counts without current-usage claims", () => {
  const result = review();
  const setup = result.shared_account_intelligence.sections.team_and_setup.facts;
  assert.equal(setup.sla_active, null);
  assert.deepEqual(setup.historical_sla_policies, {
    state: "historical", coverage_state: "checked", current_usage_state: "not_established",
    total_policy_count: 3, max_policy_count_per_instance: 3, instances_with_policies: 1,
    covered_instance_count: 2, expected_instance_count: 2, unknown_policy_instance_count: 0,
    conflict_instance_count: 0, oldest_snapshot_date: "2025-01-28", newest_snapshot_date: "2025-01-30",
    note: "Historical policy configuration for currently linked instances; this does not establish current SLA use or OLA configuration.",
  });
  assert.ok(!JSON.stringify(result.opportunity_and_focus_pairs).includes("setup:sla_active:false"));
});

test("a missing or null archive observation cannot become zero policies or no SLA use", () => {
  for (const row of [
    { ...policies, TEAM_SETUP_HISTORICAL_SLA_COVERED_INSTANCE_COUNT: 0, TEAM_SETUP_HISTORICAL_SLA_TOTAL_POLICY_COUNT: null,
      TEAM_SETUP_HISTORICAL_SLA_OLDEST_DATE: null, TEAM_SETUP_HISTORICAL_SLA_NEWEST_DATE: null },
    { ...policies, TEAM_SETUP_HISTORICAL_SLA_UNKNOWN_INSTANCE_COUNT: 1 },
    { ...policies, TEAM_SETUP_HISTORICAL_SLA_COVERED_INSTANCE_COUNT: 1 },
    { ...policies, TEAM_SETUP_HISTORICAL_SLA_CONFLICT_INSTANCE_COUNT: 1 },
  ]) {
    const setup = review(row).shared_account_intelligence.sections.team_and_setup.facts;
    assert.equal(setup.sla_active, null);
    assert.equal(setup.historical_sla_policies.total_policy_count, null);
    assert.equal(setup.historical_sla_policies.instances_with_policies, null);
    assert.notEqual(setup.historical_sla_policies.coverage_state, "checked");
    assert.equal(setup.historical_sla_policies.current_usage_state, "not_established");
  }
});

test("a measured historical zero remains zero but never becomes a current SLA finding", () => {
  const setup = review({ ...policies, TEAM_SETUP_HISTORICAL_SLA_TOTAL_POLICY_COUNT: 0,
    TEAM_SETUP_HISTORICAL_SLA_MAX_POLICY_COUNT: 0, TEAM_SETUP_HISTORICAL_SLA_POSITIVE_INSTANCE_COUNT: 0 })
    .shared_account_intelligence.sections.team_and_setup.facts;
  assert.equal(setup.historical_sla_policies.total_policy_count, 0);
  assert.equal(setup.historical_sla_policies.instances_with_policies, 0);
  assert.equal(setup.sla_active, null);
});

test("setup facts keep dated instance source coverage visible without a new table dump", () => {
  const result = review({ ...policies,
    TEAM_SETUP_SECURITY_OLDEST_SNAPSHOT_DATE: "2026-10-12",
    TEAM_SETUP_SECURITY_NEWEST_SNAPSHOT_DATE: "2026-10-13",
    TEAM_SETUP_BASIC_TOOLS_OLDEST_SNAPSHOT_DATE: "2026-10-13",
    TEAM_SETUP_BASIC_TOOLS_NEWEST_SNAPSHOT_DATE: "2026-10-13",
    TECH_STACK_GUIDE_CONNECTOR_OLDEST_SNAPSHOT_DATE: "2026-10-13",
    TECH_STACK_GUIDE_CONNECTOR_NEWEST_SNAPSHOT_DATE: "2026-10-13",
  });
  const facts = result.shared_account_intelligence.sections.team_and_setup.facts;
  assert.deepEqual(facts.configuration_snapshot_dates.security, { oldest: "2026-10-12", newest: "2026-10-13" });
  assert.match(buildAccountIntelligenceDisplay(result.shared_account_intelligence).markdown,
    /Setup snapshot dates: security 2026-10-12–2026-10-13; rule types 2026-10-13; Guide connectors 2026-10-13/);
});

test("the concise brief actually shows the historical count, date range and current-data gap", () => {
  const display = buildAccountIntelligenceDisplay(review().shared_account_intelligence);
  const rendered = display.markdown;
  assert.match(rendered, /Historical SLA policies/);
  assert.match(rendered, /3 policies/);
  assert.match(rendered, /2025-01-28.*2025-01-30/);
  assert.match(rendered, /current use not established/i);
  assert.doesNotMatch(rendered, /Historical SLA policies[^\n]*Details available on request/);
});

test("managed shared evidence retains successful product reads when one product has no snapshot", async () => {
  const queries = [];
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT, now: NOW,
    session: { query: async sql => {
      queries.push(sql);
      if (sql.includes("GAINSIGHT_COMPANY_BCV")) return [{ ACCOUNT_NAME: "Invented Company" }];
      if (sql.includes("SALESFORCE_ACCOUNT_BCV")) return [{ ACCOUNT_NAME: "Invented Company" }];
      if (sql.includes("GUIDE_ADOPTION_CRM_DAILY_SNAPSHOT")) return [];
      if (sql.includes("COPILOT_CRM_DAILY_SNAPSHOT")) return [{ COPILOT_PAID_ADOPTED: true, COPILOT_SNAPSHOT_DATE: "2026-10-11" }];
      if (sql.includes("BQ_PRODUCT_ARCHIVE_SLA_POLICIES_EDW")) return [policies];
      if (sql.includes("SECURITY_FEATURES_INSTANCE_DAILY_SNAPSHOT")) return [{ TEAM_SETUP_INSTANCE_COUNT: 2 }];
      return [];
    } },
  });
  const brief = result.review_package.shared_account_intelligence;
  assert.equal(brief.source_states.guide_adoption, "no_data");
  assert.equal(brief.source_states.copilot_adoption, "checked");
  assert.equal(brief.sections.product_footprint.facts.observed_use_ladders.copilot_paid.adopted, true);
  assert.equal(brief.sections.product_footprint.facts.source_snapshot_dates.copilot_paid, "2026-10-11");
  assert.equal(brief.sections.team_and_setup.facts.historical_sla_policies.newest_snapshot_date, "2025-01-30");
  assert.ok(queries.every(sql => !sql.includes("PRODUCT_ANALYTICS_V2")));
});

test("archive failure leaves the shared setup read and other account evidence intact", async () => {
  const result = await readRenewalConversationEvidenceWithSession({ accountId: ACCOUNT, now: NOW,
    session: { query: async sql => {
      if (sql.includes("BQ_PRODUCT_ARCHIVE_SLA_POLICIES_EDW")) throw new Error("Invented archive unavailable");
      if (sql.includes("GAINSIGHT_COMPANY_BCV") || sql.includes("SALESFORCE_ACCOUNT_BCV")) return [{ ACCOUNT_NAME: "Invented Company" }];
      if (sql.includes("SECURITY_FEATURES_INSTANCE_DAILY_SNAPSHOT")) return [{ TEAM_SETUP_INSTANCE_COUNT: 1,
        TEAM_SETUP_CUSTOM_ROLE_INSTANCE_COUNT: 0, TECH_STACK_SSO_ENABLED_INSTANCE_COUNT: 0 }];
      return [];
    } },
  });
  assert.equal(result.full_brief_source_states.team_setup_and_tech_stack, "checked");
  assert.equal(result.full_brief_source_states.historical_sla_policies, "query_failed");
  assert.equal(result.review_package.shared_account_intelligence.sections.team_and_setup.facts.instance_count, 1);
  assert.equal(result.review_package.shared_account_intelligence.sections.team_and_setup.facts.custom_role_instance_count, 0);
  assert.equal(result.review_package.shared_account_intelligence.sections.team_and_setup.facts.sla_active, null);
  assert.equal(result.review_package.shared_account_intelligence.sections.team_and_setup.facts.historical_sla_policies, undefined);
});
