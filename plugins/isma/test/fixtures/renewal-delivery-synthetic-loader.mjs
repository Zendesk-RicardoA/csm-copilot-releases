// No production connector is reachable through this fixture.
export async function load(url, context, nextLoad) {
  if (url.endsWith('/mcp/persistent-snowflake-session.mjs')) return {
    format: 'module', shortCircuit: true,
    source: `import { PersistentSnowflakeSession as ActualInventedSession } from ${JSON.stringify(new URL('./meeting-prep-behavior-session.mjs', import.meta.url).href)};
      export class PersistentSnowflakeSession extends ActualInventedSession {
        async query(sql) {
          const scenario=process.env.CSM_INVENTED_RENEWAL_DELIVERY_SCENARIO;
          if(scenario==='authorized_delay' && sql.includes('GAINSIGHT_COMPANY_BCV') && !sql.includes('owned_open_ctas')) {
            const delay=Number(process.env.CSM_INVENTED_RENEWAL_DELIVERY_DELAY_MS || 80);
            if(!Number.isFinite(delay)||delay<0||delay>40000)throw Error('Invalid invented delay');
            await new Promise(resolve=>setTimeout(resolve,delay));
          }
          if(scenario==='partial_no_authorization' && sql.includes('PRESENTATION.SUCCESS.BULLSEYE_VALUE_SELLING')) return [];
          return super.query(sql);
        }
        close() {}
      }`,
  };
  if (url.endsWith('/mcp/account-brief-chart-files.mjs') && process.env.CSM_INVENTED_RENEWAL_DELIVERY_SCENARIO === 'chart_failure') {
    return { format: 'module', shortCircuit: true, source: `
      import { TemporaryAccountBriefChartFiles as ActualFiles } from ${JSON.stringify(url + '?invented-actual')};
      import { BetaError } from ${JSON.stringify(new URL('../../mcp/core.mjs', import.meta.url).href)};
      export * from ${JSON.stringify(url + '?invented-actual')};
      export class TemporaryAccountBriefChartFiles extends ActualFiles {
        async create(result, options) {
          const receipt=JSON.parse(result.content[0].text);
          if(receipt.title==='Ticket volume') throw new BetaError('ACCOUNT_BRIEF_CHART_UNAVAILABLE','Invented volume delivery failure');
          return super.create(result,options);
        }
      }` };
  }
  return nextLoad(url, context);
}
