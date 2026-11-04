"""Execute the bundled Snowflake query against invented, in-memory relational fixtures."""
import json
import sqlite3
import sys

payload = json.load(sys.stdin)
db = sqlite3.connect(":memory:")
db.row_factory = sqlite3.Row
db.create_function("CURRENT_USER", 0, lambda: "invented-csm@example.invalid")
tables = {
    "CLEANSED.GAINSIGHT.GAINSIGHT_USER_BCV": "gs_user",
    "CLEANSED.GAINSIGHT.GAINSIGHT_COMPANY_BCV": "gs_company",
    "CLEANSED.GAINSIGHT.GAINSIGHT_CALL_TO_ACTION_BCV": "gs_cta",
    "CLEANSED.GAINSIGHT.GAINSIGHT_DA_PICKLIST_BCV": "gs_status",
}
db.executescript("""
CREATE TABLE gs_user(GSID TEXT, EMAIL TEXT, NAME TEXT, VALID_TO_TIMESTAMP TEXT);
CREATE TABLE gs_company(GSID TEXT, SFDC_ACCOUNT_ID TEXT, NAME TEXT, SUCCESS_OWNER_C_GC TEXT, VALID_TO_TIMESTAMP TEXT);
CREATE TABLE gs_cta(GSID TEXT, COMPANY_ID TEXT, OWNER_ID TEXT, NAME TEXT, STATUS_ID TEXT, DUE_DATE TEXT, VALID_TO_TIMESTAMP TEXT);
CREATE TABLE gs_status(GSID TEXT, CATEGORY TEXT, NAME TEXT, IS_OPEN_STATUS BOOLEAN, VALID_TO_TIMESTAMP TEXT);
""")
current, old = "9999-12-31", "2020-01-01"
db.executemany("INSERT INTO gs_user VALUES(?,?,?,?)", [
    ("invented-me", "invented-csm@example.invalid", "Invented CSM", current),
    ("invented-other", "invented-owner@example.invalid", "Invented Owner", current),
])
if payload.get("ambiguous_identity"):
    db.execute("INSERT INTO gs_user VALUES(?,?,?,?)",
               ("invented-me-two", "invented-csm@example.invalid", "Invented Conflicting CSM", current))
db.executemany("INSERT INTO gs_company VALUES(?,?,?,?,?)", [
    ("invented-company", "invented-account", "Invented Bay", "invented-me", current),
    ("invented-outside", "invented-outside-account", "Invented Outside", "invented-other", current),
    ("invented-archived", "invented-archived-account", "Invented Archived", "invented-me", old),
])
db.executemany("INSERT INTO gs_status VALUES(?,?,?,?,?)", [
    ("invented-open", "CTA_STATUS", "New", True, current),
    ("invented-closed", "CTA_STATUS", "Completed", False, current),
])
db.executemany("INSERT INTO gs_cta VALUES(?,?,?,?,?,?,?)", [
    ("invented-open-cta", "invented-company", "invented-other", "Invented Open Work", "invented-open", "2026-01-01", current),
    ("invented-closed-cta", "invented-company", "invented-other", "Invented Closed Work", "invented-closed", "2026-01-01", current),
    ("invented-unknown-status", "invented-company", "invented-unresolved-owner", "Invented Status Gap", "invented-missing", "2026-01-01", current),
    ("invented-own", "invented-company", "invented-me", "Invented Own Work", "invented-open", "2026-01-01", current),
    ("invented-unassigned", "invented-company", None, "Invented Unassigned", "invented-open", "2026-01-01", current),
    ("invented-blank", "invented-company", "  ", "Invented Blank Owner", "invented-open", "2026-01-01", current),
    ("invented-outside-cta", "invented-outside", "invented-other", "Invented Outside Work", "invented-open", "2026-01-01", current),
    ("invented-old-cta", "invented-company", "invented-other", "Invented Archived Work", "invented-open", "2026-01-01", old),
    ("invented-old-book-cta", "invented-archived", "invented-other", "Invented Archived Book Work", "invented-open", "2026-01-01", current),
])
sql = payload["sql"]
for original, local in tables.items():
    sql = sql.replace(original, local)
sql = sql.replace("::TIMESTAMP", "")
print(json.dumps([dict(row) for row in db.execute(sql)]))
