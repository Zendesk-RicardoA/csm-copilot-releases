// Test-only wall clock, isolated in a child whose Snowflake runtime is disabled.
import fs from "node:fs";
const RealDate = globalThis.Date;
const offset = () => Number(JSON.parse(fs.readFileSync(process.env.CSM_INVENTED_RENEWAL_CLOCK, "utf8")).offset_ms || 0);
export function installClock() {
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset()])); }
    static now() { return RealDate.now() + offset(); }
  };
}
export function completeInventedCollectionDelay() {
  const file = process.env.CSM_INVENTED_RENEWAL_CLOCK;
  const clock = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!clock.collection_elapsed_ms || clock.collection_delay_used) return;
  fs.writeFileSync(file, JSON.stringify({ ...clock, offset_ms: clock.collection_elapsed_ms, collection_delay_used: true }));
}
export function collectionIsHeld() {
  return JSON.parse(fs.readFileSync(process.env.CSM_INVENTED_RENEWAL_CLOCK, "utf8")).hold_collection === true;
}
