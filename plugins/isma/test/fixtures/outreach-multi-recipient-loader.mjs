import fs from 'node:fs';
import { PersistentSnowflakeSession as Base } from './contact-priority-session.mjs';

export class PersistentSnowflakeSession extends Base {
  async query(sql, options) {
    // Invented test counter only. Never record SQL, contacts or result values.
    fs.appendFileSync(process.env.CSM_INVENTED_RECIPIENT_QUERY_TRACE, 'query\n');
    return super.query(sql, options);
  }
}
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('persistent-snowflake-session.mjs')) return { url: import.meta.url, shortCircuit: true };
  return nextResolve(specifier, context);
}
