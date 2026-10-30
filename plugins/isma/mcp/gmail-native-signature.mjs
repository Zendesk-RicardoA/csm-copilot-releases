// Gmail is the authority for the user's saved signature. A connector-created
// draft is not evidence that Gmail inserted it automatically.
export function nativeGmailSignatureHandling() {
  return { mode: 'gmail_native', local_profile_required: false,
    applied_automatically: false, applied_by: 'user_in_gmail',
    instruction: 'Open the saved draft in Gmail and use Insert signature to apply your saved signature if needed. Review the final message before sending.' };
}
