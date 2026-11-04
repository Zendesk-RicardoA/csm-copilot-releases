# Read-only data analysis

Use this path for factual analysis that a built-in report cannot express. A limited
report catalog describes that report, not the data available through the existing
connection. Do not tell the CSM a query is impossible merely because a field,
join, comparison, grouping or status is absent from that catalog.

## Execute the requested read

1. Treat a clear analysis request as authorization to perform the read. State the
   scope briefly and run it in the same turn. Do not ask for a second "run it",
   a case, a CTA selection, an outreach review, a deck or a draft approval.
   If the user explicitly requested SQL review before execution, honor that.
2. Check `beta_setup_status` for `portfolio_analytics` once. Reuse its verified
   connection in the same session. A missing built-in field is not a failed
   connection. A genuine source failure is not a reason to switch connection,
   role or warehouse, repeatedly reopen capabilities, or broaden the query.
3. Use the installed plugin's `config/source-connection-policy.json` connection
   and `approved_read_only_roles`. Resolve the CLI with
   `mcp/snowflake-runtime.mjs` (`resolveSnowflakeCommand` and
   `snowflakeEnvironment`), so the same path works with ISMA's private runtime.
   Do not assume `snow` is on PATH or install another client.
4. Verify `CURRENT_USER()` and `CURRENT_ROLE()` on that same connection. Require
   the configured read-only role and exactly one current Gainsight user for the
   signed-in identity before a current-book query. Do not accept an identity,
   role or book owner invented in chat. A missing or ambiguous identity is a
   visible source problem, never a zero-account finding.
5. Use authoritative source definitions. Prefer the bundled source maps and
   product-source configuration. Consult `csm-data-query` and `zdp-explore`
   when available; they are helpful references, not additional required installs.
   Their absence does not block the source patterns bundled here. Resolve only
   the genuinely missing schema detail; do not rediscover known tables.
6. Run one bounded SELECT or WITH...SELECT statement through the existing
   Snowflake CLI. Pass arguments as an array with `shell: false`, and bind or
   safely quote filter values. Never interpolate user text into shell code or
   SQL identifiers. Do not execute DDL, DML, procedure calls, COPY, PUT/GET,
   role/permission changes, or multiple SQL statements as an analysis query.
7. Keep the requested population, measures, date range and grain literal.
   For "my book", use the current Gainsight Success Owner book. CTA ownership
   is a separate property; it must not define the book. Existing bounded manager
   scope remains bounded; do not infer a manager's team book from selected-account
   access or reuse another CSM's identity.
8. Apply a result bound and expose the complete matching count. Page or offer the
   remaining rows when needed; never call a truncated table complete. Report
   missing mappings and unknown statuses separately. Preserve source, snapshot
   date, query time and any failure in the answer.
9. Do not save customer rows, identifiers or result exports to the repository,
   a case, cache, spreadsheet or local file merely to answer in chat. A requested
   export has its own explicit destination and authorization. Results stay transient.
   Do not use this path to fetch transcripts, expose contact addresses, record approvals,
   create drafts, or bypass case evidence and review. Those workflows keep their
   existing native controls. Legacy TAM/toolkit reports remain outside this path.

This is a general analytical route. The example below is a source pattern, not
an exhaustive list of supported questions. Prefer a typed report when it can
answer the exact question without changing the requested scope.

## Current-book CTA ownership example

Known source relationships:

- Current rows use `VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP`.
- CSM identity: `CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV.EMAIL` matches
  `CURRENT_USER()`; use its unique current `GSID`.
- Book: `CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV.SUCCESS_OWNER_C_GC`
  equals that GSID. `SFDC_ACCOUNT_ID` supplies CRM account grain; preserve missing
  CRM mappings instead of dropping them.
- CTAs: `GAINSIGHT_CALL_TO_ACTION_BCV.COMPANY_ID` joins the company's `GSID`.
  `OWNER_ID` is the CTA owner. Do not substitute `ASSIGNED_TO_C_GC`.
- Owner names come from a LEFT JOIN to current `GAINSIGHT_USER_BCV`.
- Status: LEFT JOIN `GAINSIGHT_DA_PICKLIST_BCV` using `STATUS_ID = GSID`,
  `CATEGORY = 'CTA_STATUS'` and the current-row filter. Use `IS_OPEN_STATUS`;
  missing status remains unknown. Do not guess a `cta.STATUS` text column.

For "accounts in my book with a CTA owned by someone else", include open and
closed CTAs unless a status was specified. Summarize both separately. Exclude
unassigned owners from "someone else" and identify them separately if requested.
If the CSM says "open", filter only `cta_status_is_open = TRUE`; if they say
"New", use the exact status label. Do not silently change "all CTAs" to "open".

The following read returns detail for aggregation by account in memory. It keeps
a full matching-CTA count before the bound. Display only requested fields, group
by the transient account key rather than name alone, and keep different owners
visible. Do not present a CTA count as an account count. If the limit is reached,
obtain the distinct account total separately before making an account-count claim.

```sql
WITH authenticated_csm AS (
  SELECT DISTINCT GSID
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV
  WHERE LOWER(EMAIL) = LOWER(CURRENT_USER())
    AND VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
), current_book AS (
  SELECT company.GSID AS company_id,
         company.SFDC_ACCOUNT_ID AS account_id,
         company.NAME AS account_name,
         me.GSID AS csm_id
  FROM CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV AS company
  JOIN authenticated_csm AS me ON company.SUCCESS_OWNER_C_GC = me.GSID
  WHERE company.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
    AND (SELECT COUNT(*) FROM authenticated_csm) = 1
), matching_ctas AS (
  SELECT DISTINCT book.company_id, book.account_id, book.account_name,
         cta.GSID AS cta_id, cta.NAME AS cta_title,
         COALESCE(NULLIF(TRIM(owner.NAME), ''), 'Owner name unavailable') AS cta_owner,
         status_pl.NAME AS cta_status, status_pl.IS_OPEN_STATUS AS cta_status_is_open,
         cta.DUE_DATE AS cta_due_at
  FROM current_book AS book
  JOIN CLEANSED.GAINSIGHT.GAINSIGHT_CALL_TO_ACTION_BCV AS cta
    ON cta.COMPANY_ID = book.company_id
   AND cta.OWNER_ID <> book.csm_id
  LEFT JOIN CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV AS owner
    ON owner.GSID = cta.OWNER_ID
   AND owner.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
  LEFT JOIN CLEANSED.GAINSIGHT.GAINSIGHT_DA_PICKLIST_BCV AS status_pl
    ON status_pl.GSID = cta.STATUS_ID
   AND status_pl.CATEGORY = 'CTA_STATUS'
   AND status_pl.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
  WHERE cta.VALID_TO_TIMESTAMP >= '9999-01-01'::TIMESTAMP
    AND NULLIF(TRIM(cta.OWNER_ID), '') IS NOT NULL
)
SELECT company_id, account_id, account_name, cta_id, cta_title, cta_owner,
       cta_status, cta_status_is_open, cta_due_at,
       COUNT(*) OVER () AS total_matching_ctas
FROM matching_ctas
ORDER BY account_name, account_id, company_id, cta_owner, cta_id
LIMIT 501
```

A total above 500 means the first 500 detail rows are a partial page; the extra
row proves overflow. Continue using the same stable ordering, and report
conflicting current mappings before combining inconsistent records.
