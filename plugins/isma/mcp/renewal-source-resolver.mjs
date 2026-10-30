import crypto from "node:crypto";
import { BetaError } from "./core.mjs";

const LANGUAGE_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", nl: "Dutch", ja: "Japanese", ko: "Korean", zh: "Chinese",
  sv: "Swedish", fi: "Finnish", ru: "Russian",
};

function headerIndex(headers, candidates) {
  const normalized = headers.map((value) => String(value || "").trim().toLowerCase());
  return candidates.map((candidate) => normalized.indexOf(candidate)).find((index) => index >= 0) ?? -1;
}

function rowsToRecords(rows) {
  const [headers = [], ...values] = rows;
  return values.filter((row) => row.some((value) => String(value || "").trim())).map((row) => Object.fromEntries(headers.map((header, index) => [String(header || "").trim(), row[index] ?? ""])));
}

function priorityMatches(value, priority) {
  return String(value || "").trim().toUpperCase().match(/^P[0-4]\b/)?.[0] === priority;
}

export function languageName(language) {
  const normalized = String(language || "").toLowerCase().split("-")[0];
  return LANGUAGE_NAMES[normalized] || null;
}

export function selectRenewalSequence({ templateRows, sequenceRows, priority, language, languageVariant = null }) {
  if (!/^P[0-4]$/.test(priority || "")) throw new BetaError("INVALID_RENEWAL_PRIORITY", "Choose a renewal priority from P0 to P4.");
  const languageLabel = languageName(language);
  if (!languageLabel) {
    return { status: "language_not_mapped", priority, language, message: "There is no approved renewal-template language mapping for this customer language." };
  }
  const variant = languageVariant || ({ "es-ES": "EMEA", "pt-PT": "EMEA", "pt-BR": "LATAM", "es-MX": "LATAM", "es-AR": "LATAM", "es-CL": "LATAM", "es-CO": "LATAM" })[language] || null;
  const sequenceRecords = rowsToRecords(sequenceRows || []).filter(row => row.Language || row.Locale);
  const languageRows = sequenceRecords.filter(row => {
    const label = String(row.Language || row.Locale).trim();
    return (label === languageLabel || label.startsWith(languageLabel + " - ") || label.startsWith(languageLabel + " (")) &&
      (!variant || label.toLowerCase().includes(variant.toLowerCase()));
  });
  if (languageRows.length > 1) return { status: variant ? "language_mapping_ambiguous" : "language_variant_required", priority, language,
    language_options: languageRows.map(row => String(row.Language || row.Locale).trim()),
    message: "Choose the customer language variant from the current tracker; do not guess a region." };
  const sequenceRow = languageRows[0];
  if (sequenceRecords.length && !sequenceRow) return { status: "language_not_mapped", priority, language };
  const selectedLanguage = String(sequenceRow?.Language || sequenceRow?.Locale || languageLabel).trim();
  const selectedVariant = variant || (selectedLanguage.match(/(?: - |\()(.+?)\)?$/)?.[1] ?? null);
  const baseCode = String(language).toLowerCase().split("-")[0];
  const templates = rowsToRecords(templateRows || []).filter(row => {
    const priorityValue = row.Priority || row["CTA Priority"] || row["Clari Groove"] || row["Gainsight title"] || "";
    if (!priorityMatches(priorityValue, priority)) return false;
    if (row.Language || row.Locale) return [selectedLanguage, languageLabel].some(label => String(row.Language || row.Locale).trim().toLowerCase() === label.toLowerCase());
    const marker = String(row["Clari Groove"] || "").match(/\[([^\]]+)\]\s*$/)?.[1]?.toUpperCase();
    if (!marker) return false;
    const code = ({ ja: "JP" })[baseCode] || baseCode.toUpperCase();
    return marker.split(/\s*-\s*/).includes(code) && (!selectedVariant || marker.includes(selectedVariant.toUpperCase()));
  });
  if (templates.length > 1) return { status: "template_mapping_ambiguous", priority, language,
    message: "More than one priority and language mapping matched. Do not select the first one." };
  const template = templates[0];
  if (!template) {
    return { status: "template_mapping_unavailable", priority, language, language_label: languageLabel, message: "The approved tracker has no matching renewal sequence mapping." };
  }
  // The localization tracker's Sequence column is authoritative. "Clari Groove
  // Copy" can name an old copy and is never a substitute for the current guide.
  const sequenceTitle = sequenceRow?.Sequence || template.Sequence || template["Sequence title"] || template["Grove title"] || template["Clari sequence"] || null;
  return {
    status: sequenceTitle ? "mapped" : "template_mapping_unavailable",
    priority,
    language,
    language_label: selectedLanguage,
    sequence_title: sequenceTitle,
    one_pager_title: sequenceRow?.["Localized One Pager"] || sequenceRow?.["One pager"] || template["Localized One Pager"] || null,
    reviewed: String(sequenceRow?.Completed ?? sequenceRow?.Reviewed ?? template.Completed ?? "").toLowerCase() === "true",
  };
}

async function apiJson(fetchImpl, url, accessToken) {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new BetaError("RENEWAL_SOURCE_UNAVAILABLE", "The approved renewal source could not be read.", { status: response.status });
  return body;
}

function exactNameQuery(name, mimeType = null) {
  const parts = [`name = '${String(name).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`, "trashed = false"];
  if (mimeType) parts.push(`mimeType = '${mimeType}'`);
  return parts.join(" and ");
}

export async function resolveRenewalSourceWithGoogleDrive({ accessToken, priority, language, fetchImpl = fetch }) {
  if (!accessToken) throw new BetaError("GOOGLE_SHARED_SOURCE_SIGN_IN_REQUIRED", "Google Drive sign-in is required to read the approved renewal sequence.");
  const trackerQuery = encodeURIComponent("mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and name contains 'Renewal' ");
  const trackerResponse = await apiJson(fetchImpl, `https://www.googleapis.com/drive/v3/files?q=${trackerQuery}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=20`, accessToken);
  const trackers = trackerResponse.files || [];
  const tracker = trackers.find((file) => /^(?:H2 )?Renewal Sequences$/i.test(file.name || "")) || trackers.find((file) => /renewal sequences/i.test(file.name || ""));
  if (!tracker) return { status: "tracker_unavailable", priority, language, message: "The approved renewal tracker was not found in Google Drive." };
  const ranges = encodeURIComponent("Template Link!A:Z");
  const sequenceRanges = encodeURIComponent("H2 Renewal Sequences!A:Z");
  const sheet = await apiJson(fetchImpl, `https://sheets.googleapis.com/v4/spreadsheets/${tracker.id}/values:batchGet?ranges=${ranges}&ranges=${sequenceRanges}`, accessToken);
  const valueRanges = sheet.valueRanges || [];
  const mapping = selectRenewalSequence({
    templateRows: valueRanges[0]?.values || [], sequenceRows: valueRanges[1]?.values || [], priority, language,
  });
  if (mapping.status !== "mapped") return { ...mapping, tracker_state: "checked" };
  const lookup = async (title) => {
    if (!title) return null;
    const query = encodeURIComponent(exactNameQuery(title));
    const result = await apiJson(fetchImpl, `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,webViewLink)&pageSize=2`, accessToken);
    return result.files?.length === 1 ? result.files[0] : null;
  };
  const [sequence, onePager] = await Promise.all([lookup(mapping.sequence_title), lookup(mapping.one_pager_title)]);
  return {
    ...mapping,
    tracker_state: "checked",
    sequence: sequence ? { title: sequence.name, link: sequence.webViewLink || null, mime_type: sequence.mimeType } : null,
    one_pager: onePager ? { title: onePager.name, link: onePager.webViewLink || null } : null,
    status: sequence ? "sequence_located_copy_unread" : "sequence_copy_unavailable",
    next_action: sequence
      ? "The file is located, but its copy has not been read. Use the connected native Google Drive reader before drafting from it."
      : "Ask whether to wait for the approved sequence copy or continue with an evidence-based draft without sequence wording.",
  };
}

const DIGEST = /^[a-f0-9]{64}$/;
const TTL_MS = 15 * 60_000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const MIME_SHEET = "application/vnd.google-apps.spreadsheet";
const MIME_DOC = "application/vnd.google-apps.document";
const TRACKER_TITLE = /^(?:H[12]\s+(?:\d{4}\s+)?)?Renewal Sequences(?:\s*\|\s*Localization Tracker)?$/i;
const fail = (code, message) => { throw new BetaError(code, message); };
const invalid = () => fail("RENEWAL_NATIVE_RESULT_INVALID", "Pass only the requested native Drive result projection, never private email, account data or transcript content.");
function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function sourceId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) invalid();
  return value;
}
function colName(number) {
  let value = "";
  while (number) { number--; value = String.fromCharCode(65 + number % 26) + value; number = Math.floor(number / 26); }
  return value;
}

export function projectNativeRenewalCopyReceipt({ fileId, toolResult }) {
  sourceId(fileId);
  const result = toolResult?.structuredContent;
  if (toolResult?.isError || !result || result.truncated === true || result.partial === true || result.next_page_token || result.next_cursor || toolResult?._meta?.truncated)
    fail("RENEWAL_SEQUENCE_COPY_REQUIRED", "The native document result must contain the complete guide, not a confirmation, outline or partial response.");
  if (result.documentId !== fileId) fail("RENEWAL_SOURCE_FILE_MISMATCH", "The document paragraphs belong to a different requested file.");
  if (!Array.isArray(result.paragraphs) || !result.paragraphs.length || result.paragraphs.some(p => typeof p?.text !== "string"))
    fail("RENEWAL_SEQUENCE_COPY_REQUIRED", "The native document did not return usable complete paragraphs.");
  const copy = result.paragraphs.map(p => p.text).join("");
  if (!copy.trim() || copy.length > 100000) fail("RENEWAL_SEQUENCE_COPY_REQUIRED", "The complete guide is empty or exceeds the copy limit; do not shorten it silently.");
  const receipt = { file_ref_digest: hash(fileId), content_digest: hash(copy), character_count: copy.length, truncated: false };
  // Available only in the host's current memory; never serialized into a case,
  // log, fixture, returned receipt or reusable configuration.
  Object.defineProperty(receipt, "runtimeCopy", { value: copy });
  return receipt;
}

/** Native Drive credentials stay in the desktop connector. This control issues
 * bounded reads and binds metadata/receipts; actual guide text stays transient
 * in the host and is never sent here, written to a case or treated as approval. */
export class NativeRenewalSourceBridge {
  constructor({ now = () => Date.now(), randomUUID = crypto.randomUUID } = {}) {
    this.now = now; this.randomUUID = randomUUID; this.reads = new Map(); this.connections = new Map(); this.connectionRequests = new Map(); this.receipts = new Map();
  }
  prune() {
    for (const map of [this.reads, this.connections, this.connectionRequests, this.receipts]) for (const [key, value] of map) if (value.expiresAt <= this.now()) map.delete(key);
  }
  retain(map, key, value) {
    this.prune(); map.set(key, value);
    const timer = setTimeout(() => this.prune(), Math.max(1, value.expiresAt - this.now() + 1)); timer.unref?.();
  }
  requestConnection(ownerRef) {
    const ref = this.randomUUID(); this.retain(this.connectionRequests, ref, { ownerRef, expiresAt: this.now() + TTL_MS });
    return { status: "native_google_drive_check_required", connection_ref: ref,
      native_request: { provider: "Google Drive", tool: "get_profile", arguments: {} },
      next_action: "Check the existing connected Google Drive profile. Do not request a separate OAuth client or sign-in." };
  }
  connect({ ref, ownerRef, connected, profileDigest }) {
    this.prune(); const request = this.connectionRequests.get(ref);
    if (!request || request.ownerRef !== ownerRef) fail("RENEWAL_SOURCE_READ_EXPIRED", "The native Drive connection check expired. Check the connected profile again.");
    this.checkProfile({ connected, profile_digest: profileDigest }, ownerRef, request.expiresAt);
    this.connectionRequests.delete(ref);
    return { status: "ready", provider: "native_google_drive", source_copy_checked: false, separate_sign_in_required: false };
  }
  health(ownerRef) {
    this.prune(); return this.connections.has(ownerRef)
      ? { state: "ready", provider: "native_google_drive", source_copy_checked: false, next_action: null }
      : { state: "native_connection_not_checked", next_action: null,
        warning: "The app's Google Drive connection will be checked when renewal guidance is needed. The sequence copy has not been read." };
  }
  checkProfile(result, ownerRef, expiresAt) {
    exactKeys(result, ["connected", "profile_digest"]);
    if (result.connected !== true || !DIGEST.test(result.profile_digest || "")) invalid();
    this.retain(this.connections, ownerRef, { profileDigest: result.profile_digest, expiresAt });
  }
  start({ ownerRef, caseRecord, priority, language, languageVariant = null }) {
    if (caseRecord.tester_id !== ownerRef || caseRecord.case_kind !== "real_authorized_journey_a" ||
      caseRecord.journey_state?.active_journey !== "journey_a" || !DIGEST.test(caseRecord.journey_state?.account_ref_digest || ""))
      fail("RENEWAL_ACCOUNT_REQUIRED", "Bind the selected outreach account before reading its renewal guidance.");
    if (!/^P[0-4]$/.test(priority || "") || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language || "") ||
      (languageVariant !== null && !["EMEA", "LATAM", "Simplified", "Traditional"].includes(languageVariant))) invalid();
    const ref = this.randomUUID();
    const run = { ownerRef, caseId: caseRecord.case_id, packageVersion: caseRecord.package_version,
      accountDigest: caseRecord.journey_state.account_ref_digest, priority, language, languageVariant,
      expiresAt: this.now() + TTL_MS, stage: "profile", files: new Map(), pages: 0, pageTokens: new Set(), cellCount: 0 };
    this.retain(this.reads, ref, run);
    return this.request(ref, run, "get_profile", {});
  }
  request(ref, run, tool, args) {
    run.request = { provider: "Google Drive", tool, arguments: args };
    return { status: "native_google_drive_read_required", renewal_source_ref: ref, stage: run.stage,
      native_request: structuredClone(run.request), expires_at: new Date(run.expiresAt).toISOString(),
      source_copy_checked: false, next_action: "Run only this connected native Drive read, then continue with its bounded result. No email approval or draft is created." };
  }
  gap(ref, run, status, extra = {}) {
    this.reads.delete(ref);
    for (const [key, value] of this.receipts) if (value.ownerRef === run.ownerRef && value.receipt.case_id === run.caseId) this.receipts.delete(key);
    return { status, priority: run.priority, language: run.language, copy_state: "not_read", ...extra,
      next_action: "Ask whether to wait for the approved sequence copy or continue with an evidence-based draft without sequence wording." };
  }
  search(ref, run, stage, title = null, pageToken = null) {
    run.stage = stage;
    const query = title ? exactNameQuery(title) : "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and name contains 'Renewal Sequences'";
    return this.request(ref, run, "search", { item_type: "document", best_effort_fetch: false,
      special_filter_query_str: query, topn: 20, ...(pageToken ? { page_token: pageToken } : {}) });
  }
  acceptSearch(ref, run, result) {
    exactKeys(result, ["results", "next_page_token"]);
    if (!Array.isArray(result.results) || result.results.length > 20 || ++run.pages > 5) fail("RENEWAL_SOURCE_LIMIT", "The native Drive search exceeded its bounded pages. Narrow or identify the approved tracker; no complete result was returned.");
    for (const file of result.results) {
      exactKeys(file, ["id", "title", "mime_type", "url", "updated_at"]); sourceId(file.id);
      if (typeof file.title !== "string" || !file.title || file.title.length > 500 || typeof file.mime_type !== "string") invalid();
      const match = run.stage === "tracker_search" ? file.mime_type === MIME_SHEET && TRACKER_TITLE.test(file.title.trim())
        : file.title === (["sequence_search", "sequence_presence_recheck"].includes(run.stage) ? run.mapping.sequence_title : run.mapping.one_pager_title);
      if (match) run.files.set(file.id, structuredClone(file));
    }
    if (result.next_page_token) {
      if (typeof result.next_page_token !== "string" || result.next_page_token.length > 4096 || run.pageTokens.has(result.next_page_token)) fail("RENEWAL_SOURCE_LIMIT", "Native Drive pagination did not advance. The search is incomplete.");
      run.pageTokens.add(result.next_page_token);
      return this.search(ref, run, run.stage, run.stage === "tracker_search" ? null : ["sequence_search", "sequence_presence_recheck"].includes(run.stage) ? run.mapping.sequence_title : run.mapping.one_pager_title, result.next_page_token);
    }
    const files = [...run.files.values()];
    if (run.stage === "sequence_presence_recheck") {
      if (files.length !== 1 || files[0].id !== run.sequence.id || files[0].mime_type !== run.sequence.mime_type)
        fail("RENEWAL_SOURCE_FILE_MISMATCH", "The exact guide is no longer uniquely present in the current non-trashed native Drive search.");
      return this.afterCopy(ref, run);
    }
    if (run.stage === "tracker_search") {
      if (files.length !== 1) return this.gap(ref, run, files.length ? "tracker_ambiguous" : "tracker_unavailable");
      run.tracker = files[0]; run.stage = "tracker_metadata";
      return this.request(ref, run, "get_spreadsheet_metadata", { spreadsheet_id: run.tracker.id });
    }
    if (run.stage === "one_pager_search") {
      const link = files.length === 1 && typeof files[0].url === "string" && /^https:\/\/(?:docs\.google\.com|drive\.google\.com)\//.test(files[0].url) && files[0].url.includes(files[0].id) ? files[0].url : null;
      run.onePager = files.length === 1 ? { title: files[0].title, link, state: "located_not_read" } : { state: files.length ? "ambiguous" : "unavailable" };
      return this.finish(ref, run);
    }
    if (files.length !== 1) return this.gap(ref, run, files.length ? "sequence_ambiguous" : "sequence_copy_unavailable");
    run.sequence = files[0]; run.stage = "sequence_metadata";
    return this.metadataRequest(ref, run);
  }
  metadataRequest(ref, run) {
    return this.request(ref, run, "get_file_metadata", { fileId: run.sequence.id, fields: "id,name,mimeType,webViewLink,modifiedTime,trashed" });
  }
  readSheet(ref, run) {
    const sheet = run.sheets[run.sheetIndex]; run.stage = run.header ? "tracker_rows" : "tracker_header";
    const start = run.header ? run.nextRow : 1, end = run.header ? Math.min(start + 249, sheet.rows) : 1;
    const columns = run.header ? run.header.length : sheet.columns;
    run.cellCount += (end - start + 1) * columns;
    if (run.cellCount > 50000) fail("RENEWAL_SOURCE_LIMIT", "The tracker exceeds the bounded cell-read limit. No partial mapping is usable.");
    return this.request(ref, run, "get_spreadsheet_range", { spreadsheet_id: run.tracker.id, sheet_name: sheet.title,
      range: `A${start}:${colName(columns)}${end}`, value_render_option: "FORMATTED_VALUE" });
  }
  accept({ ref, ownerRef, caseRecord, tool, sourceStatus, result }) {
    this.prune(); const run = this.reads.get(ref);
    if (!run || run.ownerRef !== ownerRef) fail("RENEWAL_SOURCE_READ_EXPIRED", "The temporary source read expired or was lost after restart. Read the current guide again.");
    if (run.caseId !== caseRecord.case_id || run.packageVersion !== caseRecord.package_version ||
      run.accountDigest !== caseRecord.journey_state?.account_ref_digest || caseRecord.tester_id !== ownerRef || caseRecord.journey_state?.active_journey !== "journey_a")
      fail("RENEWAL_SOURCE_SCOPE_MISMATCH", "The native Drive read belongs to a different owner, case, package or account.");
    if (tool !== run.request.tool) fail("RENEWAL_NATIVE_TOOL_MISMATCH", "Return the result of the issued native Drive tool, not another source.");
    if (!["ok", "timed_out", "unavailable"].includes(sourceStatus)) invalid();
    if (sourceStatus !== "ok") {
      if (run.stage === "one_pager_search") { run.onePager = { state: sourceStatus, content_checked: false }; return this.finish(ref, run); }
      return this.gap(ref, run, "renewal_source_unavailable", { failure_stage: run.stage, source_state: sourceStatus });
    }
    if (run.stage === "profile") {
      this.checkProfile(result, ownerRef, run.expiresAt); return this.search(ref, run, "tracker_search");
    }
    if (tool === "search") return this.acceptSearch(ref, run, result);
    if (run.stage === "tracker_metadata") {
      exactKeys(result, ["spreadsheetId", "sheets"]);
      if (result.spreadsheetId !== run.tracker.id || !Array.isArray(result.sheets)) invalid();
      for (const sheet of result.sheets) {
        exactKeys(sheet, ["properties"]); exactKeys(sheet.properties, ["sheetId", "title", "gridProperties"]);
        if (sheet.properties.gridProperties) exactKeys(sheet.properties.gridProperties, ["rowCount", "columnCount", "frozenRowCount", "frozenColumnCount"]);
      }
      const expected = ["Template Link", "H2 Renewal Sequences"];
      run.sheets = expected.map(title => {
        const matches = result.sheets.filter(sheet => sheet?.properties?.title === title);
        if (matches.length !== 1) return null;
        const grid = matches[0].properties.gridProperties;
        if (!Number.isInteger(grid?.rowCount) || !Number.isInteger(grid?.columnCount) || grid.rowCount < 1 || grid.columnCount < 1 || grid.rowCount > 5000 || grid.columnCount > 50)
          fail("RENEWAL_SOURCE_LIMIT", "The tracker grid is outside its safe bounded read limits.");
        return { title, rows: grid.rowCount, columns: grid.columnCount };
      });
      if (run.sheets.some(sheet => !sheet)) return this.gap(ref, run, "tracker_layout_unavailable");
      run.sheetIndex = 0; run.header = null; run.tables = []; run.nextRow = 2;
      return this.readSheet(ref, run);
    }
    if (tool === "get_spreadsheet_range") {
      exactKeys(result, ["range", "majorDimension", "values"]);
      const expectedRange = `'${run.request.arguments.sheet_name.replace(/'/g, "''")}'!${run.request.arguments.range}`;
      const alternateRange = `${run.request.arguments.sheet_name}!${run.request.arguments.range}`;
      const [first, last] = run.request.arguments.range.match(/\d+/g).map(Number);
      if (![expectedRange, alternateRange].includes(result.range) || (result.majorDimension && result.majorDimension !== "ROWS") ||
        !Array.isArray(result.values) || result.values.length > last - first + 1 || result.values.some(row => !Array.isArray(row) || row.length > run.sheets[run.sheetIndex].columns || row.some(cell => cell !== null && !["string", "number", "boolean"].includes(typeof cell)))) invalid();
      if (run.stage === "tracker_header") {
        run.header = result.values[0];
        if (!Array.isArray(run.header) || !run.header.length || run.header.some(v => typeof v !== "string") || new Set(run.header).size !== run.header.length) invalid();
        run.tables[run.sheetIndex] = [run.header];
      } else {
        // Retain only mapping columns, never reviewer names or unrelated rows.
        const allowed = ["Priority", "CTA Priority", "Gainsight title", "Clari Groove", "Language", "Locale", "Sequence", "Sequence title", "Grove title", "Clari sequence", "Localized One Pager", "One pager", "Completed", "Reviewed"];
        run.tables[run.sheetIndex].push(...result.values.map(row => row.map((value, index) => allowed.includes(run.header[index]) ? value : "")));
        run.nextRow = last + 1;
      }
      if (run.nextRow <= run.sheets[run.sheetIndex].rows) return this.readSheet(ref, run);
      if (run.sheetIndex === 0) { run.sheetIndex = 1; run.header = null; run.nextRow = 2; return this.readSheet(ref, run); }
      run.mapping = selectRenewalSequence({ templateRows: run.tables[0], sequenceRows: run.tables[1], priority: run.priority, language: run.language, languageVariant: run.languageVariant });
      delete run.tables; delete run.header;
      if (run.mapping.status !== "mapped") return this.gap(ref, run, run.mapping.status, run.mapping);
      if (!run.mapping.reviewed) return this.gap(ref, run, "sequence_not_reviewed");
      run.files = new Map(); run.pages = 0; run.pageTokens = new Set();
      return this.search(ref, run, "sequence_search", run.mapping.sequence_title);
    }
    if (tool === "get_file_metadata") {
      const normalizedNative = Object.hasOwn(result || {}, "title") || Object.hasOwn(result || {}, "mime_type");
      exactKeys(result, normalizedNative ? ["id", "title", "mime_type", "url", "modified_time", "source_visibility_status"]
        : ["id", "name", "mimeType", "webViewLink", "modifiedTime", "trashed"]);
      const metadata = normalizedNative ? { id: result.id, name: result.title, mimeType: result.mime_type,
        webViewLink: result.url, modifiedTime: result.modified_time } : result;
      if (metadata.id !== run.sequence.id || metadata.name !== run.mapping.sequence_title || metadata.mimeType !== run.sequence.mime_type ||
        (!normalizedNative && metadata.trashed !== false) || typeof metadata.modifiedTime !== "string" || !Number.isFinite(Date.parse(metadata.modifiedTime)))
        fail("RENEWAL_SOURCE_FILE_MISMATCH", "The current file metadata does not match the exact approved guide.");
      // The connected app normalizes Google metadata and does not return a
      // trash flag even with fields requested. Never invent that flag or treat
      // access_not_verified as confirmed access. A complete native copy plus
      // an exact final non-trashed search supplies the missing presence proof.
      run.sequenceNeedsPresence ||= normalizedNative;
      if (run.stage === "sequence_recheck") {
        if (metadata.modifiedTime !== run.modifiedTime) fail("RENEWAL_SEQUENCE_CHANGED", "The approved guide changed while it was being read. Repeat the read before reviewing email wording.");
        if (run.sequenceNeedsPresence) { run.files = new Map(); run.pages = 0; run.pageTokens = new Set(); return this.search(ref, run, "sequence_presence_recheck", run.mapping.sequence_title); }
        return this.afterCopy(ref, run);
      }
      run.modifiedTime = metadata.modifiedTime; run.stage = "sequence_copy";
      if (metadata.mimeType === MIME_DOC) return this.request(ref, run, "get_document_text", { document_id: metadata.id });
      const url = metadata.webViewLink;
      if (typeof url !== "string" || !/^https:\/\/(?:docs\.google\.com|drive\.google\.com)\//.test(url) || !url.includes(metadata.id)) invalid();
      return this.request(ref, run, "fetch", { url });
    }
    if (run.stage === "sequence_copy") {
      exactKeys(result, ["content_digest", "character_count", "truncated", "file_ref_digest"]);
      if (result.file_ref_digest !== hash(run.sequence.id)) fail("RENEWAL_SOURCE_FILE_MISMATCH", "The copy receipt belongs to a different Drive file.");
      if (!DIGEST.test(result.content_digest || "") || !Number.isInteger(result.character_count) || result.character_count < 1 || result.character_count > 100000 || result.truncated !== false)
        fail("RENEWAL_SEQUENCE_COPY_REQUIRED", "Read the complete current guide. Missing, empty or shortened copy is not ready for drafting.");
      run.contentDigest = result.content_digest; run.characterCount = result.character_count; run.stage = "sequence_recheck";
      return this.metadataRequest(ref, run);
    }
    invalid();
  }
  afterCopy(ref, run) {
    if (run.mapping.one_pager_title) { run.files = new Map(); run.pages = 0; run.pageTokens = new Set(); return this.search(ref, run, "one_pager_search", run.mapping.one_pager_title); }
    return this.finish(ref, run);
  }
  finish(ref, run) {
    const receipt = { provider: "native_google_drive", case_id: run.caseId, package_version: run.packageVersion,
      account_ref_digest: run.accountDigest, scope_digest: hash(JSON.stringify([run.priority, run.language, run.languageVariant])),
      tracker_ref_digest: hash(run.tracker.id), sequence_ref_digest: hash(run.sequence.id), sequence_content_digest: run.contentDigest,
      sequence_revision_digest: hash(run.modifiedTime), character_count: run.characterCount, expires_at: new Date(run.expiresAt).toISOString() };
    receipt.evidence_digest = hash(JSON.stringify(receipt)); this.reads.delete(ref);
    this.retain(this.receipts, receipt.evidence_digest, { ownerRef: run.ownerRef, receipt: structuredClone(receipt), expiresAt: run.expiresAt });
    return { ...run.mapping, status: "ready", copy_state: "read", sequence: { title: run.sequence.title, mime_type: run.sequence.mime_type },
      one_pager: run.onePager || { state: "not_mapped" }, receipt,
      next_action: "Use the current guide as guidance, not automatic copy. Show the exact recipient, email and signature for review; draft authorization remains separate." };
  }
  assertReceipt(caseRecord, ownerRef) {
    this.prune(); const receipt = caseRecord.renewal_source_receipt, held = this.receipts.get(receipt?.evidence_digest);
    if ([...this.reads.values()].some(run => run.ownerRef === ownerRef && run.caseId === caseRecord.case_id))
      fail("RENEWAL_SOURCE_READ_PENDING", "The current guide is still being checked. Do not approve or draft from a prior copy.");
    if (!held || held.ownerRef !== ownerRef) fail("RENEWAL_SOURCE_READ_EXPIRED", "The current guide is no longer available in this process. Read it again before approving sequence-based email copy.");
    if (JSON.stringify(receipt) !== JSON.stringify(held.receipt) || receipt.case_id !== caseRecord.case_id || receipt.package_version !== caseRecord.package_version ||
      receipt.account_ref_digest !== caseRecord.journey_state?.account_ref_digest || caseRecord.tester_id !== ownerRef)
      fail("RENEWAL_SOURCE_RECEIPT_MISMATCH", "The source receipt no longer matches the owner, case, account or current approved guide.");
    return true;
  }
}
