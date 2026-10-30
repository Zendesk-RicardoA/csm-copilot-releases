const accountId = (n) => `001${String(n).padStart(12, "0")}AAA`;
const contactId = (n) => `003${String(n).padStart(12, "0")}AAA`;

export class PersistentSnowflakeSession {
  async query(sql, { timeoutMs } = {}) {
    if (sql.includes("owned_open_ctas")) {
      if (timeoutMs !== 25_000) throw new Error("Invented CTA deadline changed.");
      return [{ ROW_TYPE: "scope", SCOPE_COUNT: 1 }, ...Array.from({ length: 5 }, (_, n) => ({
        ROW_TYPE: "cta", CTA_ID: `invented-cta-${n + 1}`, ACCOUNT_ID: accountId(n + 1),
        ACCOUNT_NAME: `Invented ${n + 1}`, CTA_NAME: `${n === 0 ? "P0" : "P1"}: Invented adoption task`,
        CTA_STATUS: "New", CTA_CREATED_AT: "2026-09-10T12:00:00Z",
        CTA_STATUS_IS_OPEN: true, CTA_DISPOSITION: "queue",
      }))];
    }
    if (sql.includes("bounded_contacts")) {
      if (timeoutMs !== 25_000) throw new Error("Invented snapshot deadline changed.");
      return Array.from({ length: 5 }, (_, n) => ({ ACCOUNT_ID: accountId(n + 1), CONTACT_ID: contactId(n + 1),
        CONTACT_NAME: `Person ${n + 1}`, CONTACT_EMAIL: null, CONTACT_TITLE: "Support Lead",
        LATEST_SALES_TOUCH_AT: "2026-09-11T12:00:00Z", CANDIDATE_COUNT: 1 }));
    }
    if (sql.includes("native_bulk_contact_details")) {
      if (timeoutMs !== 120_000 || !sql.includes("SALESFORCE_CONTACT_FORMULA_BCV")) throw new Error("Invented detail boundary changed.");
      await new Promise((resolve) => setTimeout(resolve, 45));
      return Array.from({ length: 5 }, (_, n) => ({ ACCOUNT_ID: accountId(n + 1), CONTACT_ID: contactId(n + 1),
        CONTACT_NAME: `Person ${n + 1}`, CONTACT_EMAIL: `person${n + 1}@example.invalid`, CONTACT_TITLE: "Support Lead" }));
    }
    throw new Error("The invented bulk fixture has no governed result for this statement.");
  }
  close() {}
}
