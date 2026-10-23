export async function load(url, context, nextLoad) {
  const clock = new URL("./renewal-review-clock.mjs", import.meta.url).href;
  if (url.endsWith("/mcp/server.mjs")) {
    const loaded = await nextLoad(url, context);
    const source = String(loaded.source).replace(/^#![^\n]*\n/, "");
    return { ...loaded, source: `import { installClock } from ${JSON.stringify(clock)}; installClock();\n${source}` };
  }
  if (url.endsWith("/mcp/persistent-snowflake-session.mjs")) {
    const fixture = new URL("./renewal-synthetic-session.mjs", import.meta.url).href;
    return { format: "module", shortCircuit: true, source: `
      import { rowsFor } from ${JSON.stringify(fixture)};
      import { completeInventedCollectionDelay, collectionIsHeld } from ${JSON.stringify(clock)};
      export class PersistentSnowflakeSession {
        async query(sql) {
          if (sql.includes("GAINSIGHT_COMPANY_BCV") && !sql.includes("owned_open_ctas")) {
            completeInventedCollectionDelay();
            while (collectionIsHeld()) await new Promise(resolve => setTimeout(resolve, 5));
          }
          return rowsFor(sql);
        }
        close() {}
      }` };
  }
  return nextLoad(url, context);
}
