// Test-only source replacement. An impossible Snowflake executable is also
// configured by the harness, so a failed fixture cannot reach a live source.
export async function load(url, context, nextLoad) {
  if (url.endsWith("/mcp/book-of-business-read-session.mjs")) {
    const fixture = new URL("./preinstall-synthetic-book-session.mjs", import.meta.url).href;
    return {
      format: "module", shortCircuit: true,
      source: `export { BookOfBusinessReadSession, BOOK_OF_BUSINESS_READ_TIMEOUT_MS, BOOK_OF_BUSINESS_RETRY_TIMEOUT_MS, runBookOfBusinessStatement } from ${JSON.stringify(fixture)};`,
    };
  }
  if (url.endsWith("/mcp/persistent-snowflake-session.mjs")) {
    const fixture = new URL("./preinstall-synthetic-outreach-session.mjs", import.meta.url).href;
    return { format: "module", shortCircuit: true, source: `export { PersistentSnowflakeSession } from ${JSON.stringify(fixture)};` };
  }
  return nextLoad(url, context);
}
