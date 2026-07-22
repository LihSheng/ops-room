const VERDICTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'NEEDS_HUMAN']);
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

export function parseStructuredReview(text) {
  let value;
  try {
    value = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('Review result must be valid JSON');
  }
  if (!value || typeof value !== 'object' || !VERDICTS.has(value.verdict)) {
    throw new Error('Review result has an invalid verdict');
  }
  if (!Array.isArray(value.findings)) throw new Error('Review result findings must be an array');
  const findings = value.findings.map((finding) => {
    if (!finding || !SEVERITIES.has(finding.severity) || !finding.file || !finding.title || !finding.description) {
      throw new Error('Review result contains an invalid finding');
    }
    return { ...finding, auto_fixable: finding.auto_fixable === true };
  });
  const blocking = findings.filter((finding) => finding.severity !== 'low');
  if (value.verdict === 'APPROVE' && blocking.length > 0) {
    throw new Error('APPROVE cannot include blocking findings');
  }
  if (value.verdict === 'REQUEST_CHANGES' && findings.length === 0) {
    throw new Error('REQUEST_CHANGES must include findings');
  }
  return { summary: String(value.summary || ''), verdict: value.verdict, requires_human: value.requires_human === true, findings };
}
