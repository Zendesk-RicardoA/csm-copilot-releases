import crypto from 'node:crypto';
import Native from './approved-native-contract.js';
import { BetaError } from './core.mjs';
import { activeRenewalTemplateBinding, RENEWAL_CONVERSATION_RENDERER_BASELINE } from './renewal-conversation-renderer.mjs';

const digest = value => crypto.createHash('sha256').update(Native.canonicalSourceJson(value)).digest('hex');
const contentDigest = deck => digest(Native.renewalReviewedContent(deck));
const scopeDigest = (record,owner,content) => digest({case_id:record.case_id,owner_ref:owner,revision:record.revision,
  package_version:record.package_version,account_ref:record.journey_state?.account_ref_digest || record.account_ref_digest || record.renewal_conversation?.account_ref_digest,content_digest:content});

export function beginRenewalNativePreflight({caseRecord,ownerRef,deckContent,now=Date.now(),expiresAt=now+900000}) {
  const content=contentDigest(deckContent);
  return {requestRef:crypto.randomUUID(),scopeDigest:scopeDigest(caseRecord,ownerRef,content),contentDigest:content,
    packageVersion:caseRecord.package_version,operatorRef:ownerRef,revision:caseRecord.revision,
    expiresAt:Math.min(expiresAt,now+900000)};
}

export function renewalNativeLayoutRequest(pending,releaseComponents) {
  return {schemaVersion:'1.0',packageVersion:pending.packageVersion,rendererBaseline:RENEWAL_CONVERSATION_RENDERER_BASELINE,
    operatorRef:pending.operatorRef,privateDraftAuthorized:false,nativeFitRequestRef:pending.requestRef,releaseComponents,
    bridgeInput:{mode:'capture_layout',artifactKind:'renewal_conversation_brief',templateBinding:activeRenewalTemplateBinding()}};
}

function assertScope(pending,record,owner,deck,now) {
  if (!pending || pending.expiresAt<=now) throw new BetaError('RENEWAL_NATIVE_PREFLIGHT_EXPIRED','The native layout request expired. Capture it again from the private renewal template; no draft was created.');
  const content=contentDigest(deck);
  if (pending.contentDigest!==content || pending.scopeDigest!==scopeDigest(record,owner,content)) throw new BetaError('RENEWAL_NATIVE_PREFLIGHT_SCOPE_MISMATCH','The native layout result does not match this owner, account, package, revision and exact customer wording.');
}

function assertInventory(result) {
  const top=['schema_version','contract','native_fit_request_ref','source_fingerprint','layout_fingerprint','slides','creates_artifact','renderer_components'];
  const geometryKeys=['widthPt','heightPt','fontSizePt','lineSpacingPct','spaceAbovePt','spaceBelowPt'];
  if (!result || result.schema_version!=='1.0' || result.creates_artifact!==false || Object.keys(result).some(key=>!top.includes(key)) ||
    !/^[a-f0-9]{64}$/.test(result.source_fingerprint || '') || !/^[a-f0-9]{64}$/.test(result.layout_fingerprint || '') || Native.renewalLayoutIssue(result)) {
    throw new BetaError('RENEWAL_NATIVE_LAYOUT_REQUIRED','Return the complete read-only native layout capture, not a fit claim or guessed geometry.');
  }
  for (const slide of result.slides) {
    if (Object.keys(slide).some(key=>!['role','subtitle_fit','cards'].includes(key))) throw new BetaError('RENEWAL_NATIVE_LAYOUT_REQUIRED','The captured native layout contains an unsupported field.');
    for (const fit of [slide.subtitle_fit,...slide.cards.flatMap(card=>Object.values(card))].filter(Boolean)) if(Object.keys(fit).some(key=>!geometryKeys.includes(key))) throw new BetaError('RENEWAL_NATIVE_LAYOUT_REQUIRED','Use captured dimensions and native text style only.');
  }
  const inventory={contract:result.contract,slides:structuredClone(result.slides)};
  if (digest(inventory)!==result.layout_fingerprint) throw new BetaError('RENEWAL_NATIVE_LAYOUT_REQUIRED','The native layout digest does not match its returned geometry.');
  return {...inventory,source_fingerprint:result.source_fingerprint};
}

export function bindRenewalNativePreflight({pending,nativeResult,caseRecord,ownerRef,deckContent,now=Date.now()}) {
  assertScope(pending,caseRecord,ownerRef,deckContent,now);
  if (nativeResult?.native_fit_request_ref!==pending.requestRef) throw new BetaError('RENEWAL_NATIVE_PREFLIGHT_SCOPE_MISMATCH','This native result is for another layout request.');
  const inventory=assertInventory(nativeResult),issue=Native.renewalTextFitIssue(deckContent.customer_slides,inventory);
  if (issue) throw new BetaError(issue.code,'Shorten the indicated wording before approval. The private renderer will not rewrite it, resize its font or drop selected cards.',issue);
  return {inventory,receipt:{schema_version:'1.0',contract:Native.renewalNativePreflightContract,native_fit_request_ref:pending.requestRef,
    source_fingerprint:nativeResult.source_fingerprint,layout_fingerprint:nativeResult.layout_fingerprint,content_digest:pending.contentDigest,
    scope_digest:pending.scopeDigest,reviewed_revision:caseRecord.revision,package_version:caseRecord.package_version,
    expires_at:new Date(pending.expiresAt).toISOString()}};
}

export function assertRenewalNativePreflight({receipt,inventory,caseRecord,ownerRef,deckContent,now=Date.now()}) {
  if (!receipt || !inventory || receipt.contract!==Native.renewalNativePreflightContract) throw new BetaError('RENEWAL_NATIVE_PREFLIGHT_REQUIRED','Capture and check the native renewal layout before wording approval.');
  const content=contentDigest(deckContent),expires=Date.parse(receipt.expires_at);
  if (!Number.isFinite(expires) || expires<=now) throw new BetaError('RENEWAL_NATIVE_PREFLIGHT_EXPIRED','The native layout check expired. Recheck it before approval or a private draft.');
  if (receipt.content_digest!==content || receipt.scope_digest!==scopeDigest(caseRecord,ownerRef,content) || receipt.source_fingerprint!==inventory.source_fingerprint ||
      receipt.layout_fingerprint!==digest({contract:inventory.contract,slides:inventory.slides})) throw new BetaError('RENEWAL_NATIVE_PREFLIGHT_SCOPE_MISMATCH','The native layout receipt no longer matches the reviewed content and case.');
  const issue=Native.renewalTextFitIssue(deckContent.customer_slides,inventory);
  if (issue) throw new BetaError(issue.code,'The selected renewal wording does not fit the captured native layout.',issue);
  return true;
}
