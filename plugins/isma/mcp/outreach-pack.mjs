export function buildOutreachPack({ cta = null, brief, contacts = [], sourceStates = {}, sourceGaps = [], renewalGuidance = null, status = "ready" } = {}) {
  return {
    schema_version: "1.0",
    status,
    sections: {
      cta_and_urgency: cta,
      account_summary: brief?.account_summary || brief || null,
      performance_trends: brief?.product_performance_metrics || null,
      suggested_contacts: contacts,
      renewal_guidance: renewalGuidance,
      source_gaps: [...new Set(sourceGaps)],
      email_preview: null,
    },
    source_states: sourceStates,
    presentation: {
      format: "fixed_sections_and_tables",
      required_order: ["cta_and_urgency", "account_summary", "performance_trends", "suggested_contacts", "renewal_guidance", "source_gaps", "email_preview"],
      instruction: "Keep contacts and metric trends as tables. Do not hide returned records in prose or collapse source gaps.",
    },
  };
}
