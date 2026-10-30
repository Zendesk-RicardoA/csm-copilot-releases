import { PersistentSnowflakeSession as Base } from './outreach-multi-recipient-loader.mjs';
import { rowsFor } from './renewal-synthetic-session.mjs';

export class PersistentSnowflakeSession extends Base {
  async query(sql, options) {
    if (sql.startsWith('SELECT CURRENT_USER()')) return [{ CURRENT_USER: 'manager@example.invalid', CURRENT_ROLE: 'PUBLIC', CURRENT_WAREHOUSE: 'INVENTED_WH' }];
    if (sql.includes("CURRENT_ROLE() AS current_role") && sql.includes("'scope' AS row_type")) {
      if (sql.includes('SUCCESS_OWNER_C_GC') || sql.includes('current_user_candidates')) throw new Error('Manager search invented a CSM book.');
      return [
        { ROW_TYPE: 'scope', CURRENT_USER: 'manager@example.invalid', CURRENT_ROLE: 'PUBLIC', CURRENT_WAREHOUSE: 'INVENTED_WH' },
        { ROW_TYPE: 'account', ACCOUNT_ID: '001000000000000AAA', ACCOUNT_NAME: 'Invented Managed Company' },
      ];
    }
    try { return await super.query(sql, options); }
    catch (error) {
      if (!sql.includes('001000000000000AAA')) throw error;
      return rowsFor(sql);
    }
  }
}
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('persistent-snowflake-session.mjs')) return { url: import.meta.url, shortCircuit: true };
  return nextResolve(specifier, context);
}
