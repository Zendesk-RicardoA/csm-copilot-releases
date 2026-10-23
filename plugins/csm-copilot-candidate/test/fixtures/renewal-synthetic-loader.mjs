// Test-only replacement for the managed reader. The server process also gets
// an invalid Snowflake Python path, so a loader failure cannot reach a source.
export async function load(url, context, nextLoad) {
  if (url.endsWith("/mcp/persistent-snowflake-session.mjs")) {
    const fixture = new URL("./renewal-synthetic-session.mjs", import.meta.url).href;
    return {
      format: "module",
      shortCircuit: true,
      source: `export { PersistentSnowflakeSession } from ${JSON.stringify(fixture)};`,
    };
  }
  return nextLoad(url, context);
}
