// Invented-only reader and clock. No credentials, SDK or live source is loaded.
import fs from "node:fs";
import { rowsFor } from "./renewal-synthetic-session.mjs";

const RealDate = Date;
const readControl = () => JSON.parse(fs.readFileSync(process.env.CSM_INVENTED_RENEWAL_RESUME, "utf8"));

export function installClock() {
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [readControl().now_ms])); }
    static now() { return readControl().now_ms; }
  };
}

export class PersistentSnowflakeSession {
  async query(sql) {
    const file = process.env.CSM_INVENTED_RENEWAL_RESUME;
    const before = readControl();
    fs.writeFileSync(file, JSON.stringify({ ...before, query_count: before.query_count + 1 }));
    const accountRead = sql.includes("GAINSIGHT_COMPANY_BCV") && !sql.includes("owned_open_ctas");
    if (accountRead) {
      while (readControl().hold_account_read) await new Promise(resolve => setTimeout(resolve, 5));
    }
    const rows = structuredClone(rowsFor(sql));
    return accountRead ? rows.map(row => ({ ...row, NET_ARR_USD: readControl().arr_usd })) : rows;
  }
  close() { this.closed = true; }
}
