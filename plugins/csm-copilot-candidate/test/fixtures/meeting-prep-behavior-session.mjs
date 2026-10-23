import { rowsFor } from './renewal-synthetic-session.mjs';
import { BetaError } from '../../mcp/core.mjs';

const key = 'invented_behavior_call';
export class PersistentSnowflakeSession {
  async query(sql) {
    // The selected-instance CTE mentions RBA too: match the actual outer Guide
    // query before the older generic fixture's broad RBA-join branch.
    if (sql.includes('FACT_GUIDE_ARTICLE_VIEWS_DAILY_SNAPSHOT')) return [{
      GUIDE_KNOWLEDGE_VIEWS_MONTH: 202608, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS_MONTH: 202508,
      GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, GUIDE_KNOWLEDGE_VIEWS: 1343,
      YEAR_AGO_GUIDE_KNOWLEDGE_VIEW_VALUE_COUNT: 1, YEAR_AGO_GUIDE_KNOWLEDGE_VIEWS: 1277,
      GUIDE_KNOWLEDGE_VIEW_TREND_SERIES: [{ period: '202603', knowledge_views: 1200 }, { period: '202608', knowledge_views: 1343 }],
    }];
    if (sql.includes('best_accounts') || sql.includes("SHA2(CONCAT('account:'")) return [
      { ROW_TYPE: 'scope', SCOPE_COUNT: 1, ACCOUNT_MATCH_COUNT: 1 },
      { ROW_TYPE: 'account', SCOPE_COUNT: 1, ACCOUNT_MATCH_COUNT: 1, ACCOUNT_ID: '001000000000000AAA', ACCOUNT_NAME: 'Invented Orchard' },
    ];
    if (sql.includes('recent_gong_spotlights_json')) return [{ RECENT_GONG_SPOTLIGHTS_JSON: JSON.stringify([{
      conversation_key: key, spotlight_brief: 'Agents manually route requests and want a clearer workflow.',
      spotlight_key_points: ['Agents manually route requests.', 'The team wants less repeated handling.'],
      spotlight_next_steps: ['Invented owner will review routing.'],
    }]) }];
    if (sql.includes('PRESENTATION.BULLSEYE_PRO.SALES_ACTIVITY')) return [{
      RELIABLY_MATCHED_CALL_COUNT: 1, LATEST_RELIABLY_MATCHED_CALL_AT: '2026-09-10',
      RECENT_CALLS_JSON: JSON.stringify([{ conversation_key: key, call_at: '2026-09-10', title: 'Invented workflow review', match_strength: 'account context' }]),
    }];
    if (sql.includes('PRESENTATION.SUCCESS.BULLSEYE_VALUE_SELLING')) return rowsFor(sql).slice(0, 1).map(row => ({ ...row, TICKET_CHANNEL_GROUP: 'All', TICKET_REPLY: 'All' }));
    // Any attempted legacy lookup or transcript read is a hard stop, not a mock success.
    if (/bounded_calls|reliably_matched_call_keys|transcript_count|AS safety_state|AS finding_index/.test(sql)) {
      throw new BetaError('INVENTED_MODEL_BOUNDARY', 'A separate recording read was not requested.');
    }
    return rowsFor(sql);
  }
  close() {}
}
