// Exercise the actual packaged server with only its clock and source replaced.
export async function load(url, context, nextLoad) {
  const fixture = new URL("./renewal-resume-session.mjs", import.meta.url).href;
  if (url.endsWith("/mcp/server.mjs")) {
    const loaded = await nextLoad(url, context);
    const source = String(loaded.source).replace(/^#![^\n]*\n/, "");
    return { ...loaded, source: `import { installClock } from ${JSON.stringify(fixture)}; installClock();\n${source}` };
  }
  if (url.endsWith("/mcp/persistent-snowflake-session.mjs")) {
    return { format: "module", shortCircuit: true,
      source: `export { PersistentSnowflakeSession } from ${JSON.stringify(fixture)};` };
  }
  return nextLoad(url, context);
}
