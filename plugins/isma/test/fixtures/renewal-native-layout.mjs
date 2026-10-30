import crypto from 'node:crypto';

// Independent invented native dimensions. This does not import the fit
// estimator or calculate expected customer copy using the producer.
export function inventedRenewalNativeLayout(requestJson) {
  const request=JSON.parse(requestJson),source='b'.repeat(64),components=request.releaseComponents;
  const fit=(width,height,font)=>({widthPt:width,heightPt:height,fontSizePt:font,lineSpacingPct:100,spaceAbovePt:0,spaceBelowPt:0});
  const result={schema_version:'1.0',contract:'renewal-native-preflight-v1',native_fit_request_ref:request.nativeFitRequestRef,source_fingerprint:source,creates_artifact:false,
    slides:[
      {role:'progress',subtitle_fit:fit(640,18.9,21),cards:Array.from({length:3},()=>({headline:fit(176,52,12),metric_comparison:fit(176,44,11),why_it_matters:fit(176,110,11)}))},
      {role:'opportunities',subtitle_fit:fit(640,18.9,21),cards:Array.from({length:3},()=>({headline:fit(176,52,12),what_the_data_shows:fit(176,44,11),customer_impact_opportunity:fit(176,110,11)}))},
      {role:'focus',cards:Array.from({length:3},()=>({focus_area:fit(176,52,12),customer_benefit:fit(176,174,11)}))},
    ],renderer_components:{...components.renderers.renewal_preparation,renderer_baseline:components.renderer_baseline,native_contract:components.native_contract,
      native_fit_contract:components.native_fit_contract,renewal_layout_contract:components.renewal_layout_contract,renewal_preflight_contract:components.renewal_preflight_contract,master_contract_sha256:components.master_contract_sha256,approved_master_binding_fingerprint:source}};
  return refreshInventedLayoutDigest(result);
}
export function refreshInventedLayoutDigest(result) {
  function sorted(value){if(Array.isArray(value))return value.map(sorted);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==null&&value[key]!==undefined).map(key=>[key,sorted(value[key])]));}
  result.layout_fingerprint=crypto.createHash('sha256').update(JSON.stringify(sorted({contract:result.contract,slides:result.slides}))).digest('hex');return result;
}
