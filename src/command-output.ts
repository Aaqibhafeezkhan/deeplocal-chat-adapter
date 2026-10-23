// Finite diagnostic redaction, not a scanner for arbitrary unlabelled secrets.
const credentialName = '(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?key|token|password|passwd|secret|cookie)';
const value = '(?:"(?:\\\\.|[^"\\\\])*"?|\'(?:\\\\.|[^\'\\\\])*\'?|[^\\s&,;]+)';
const assignment = new RegExp(`(\\b${credentialName}["']?\\s*[:=]\\s*)${value}`, 'gi');
const option = new RegExp(`((?:^|\\s)--?${credentialName}(?:=|\\s+))${value}`, 'gi');

export function redactCommandOutput(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[private key redacted]')
    .replace(/(\b(?:(?:proxy-)?authorization|(?:set-)?cookie)["']?\s*[:=]\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(/\bbearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/"']*@/gi, '$1[redacted]@')
    .replace(assignment, '$1[redacted]')
    .replace(option, '$1[redacted]')
    .replace(/((?:^|\s)(?:--user(?:\s+|=)|-u(?:\s+|=)?))[^\s]+:[^\s]+/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|sk-[a-z0-9_-]{16,})\b/gi, '[redacted]');
}

/** Include JSON escaping in the budget. Retain both the start and diagnostic tail. */
export function boundedCommandText(text: string, budget: number): { text: string; truncated: boolean } {
  if (JSON.stringify(text).length <= budget) return { text, truncated: false };
  const marker = '\n... truncated ...\n';
  const half = Math.floor((budget - JSON.stringify(marker).length - 4) / 2);
  const fit = (tail: boolean) => {
    let low = 0, high = Math.min(text.length, half);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const part = tail ? text.slice(-mid) : text.slice(0, mid);
      if (JSON.stringify(part).length <= half) low = mid; else high = mid - 1;
    }
    return tail ? text.slice(-low).replace(/^[\uDC00-\uDFFF]/, '') : text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
  };
  return { text: fit(false) + marker + fit(true), truncated: true };
}
