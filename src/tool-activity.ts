import { ToolCall } from './protocol';
import { parseToolInput } from './tool-input';

export interface ToolActivity {
  id: string;
  title: string;
  detail: string;
  state: 'running' | 'success' | 'error' | 'declined' | 'cancelled';
}

const titles: Record<string, string> = {
  create_file: 'Create file', write_file: 'Write file', replace_in_file: 'Modify file', delete_file: 'Delete file',
  read_file: 'Read file', open_file: 'Open file', get_workspace_summary: 'Inspect workspace',
  list_workspace_files: 'List files', search_workspace: 'Search workspace',
  get_active_file: 'Inspect active editor', get_selection: 'Read selection',
  get_diagnostics: 'Check diagnostics', run_command: 'Run command',
};

// These are presentation heuristics, not a credential scanner. Match names and
// syntax rather than trying to extract secret values from shell/search text.
const sensitiveFiles = new Set(['.env', '.envrc', '.aws', '.ssh', '.kube', '.gnupg', '.npmrc', '.netrc', '.pypirc', '.git-credentials']);
const credentialName = '(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?key|token|password|passwd|secret)';
const credentialAssignment = new RegExp(`\\b${credentialName}["']?\\s*[:=]`, 'i');
const credentialOption = new RegExp(`(?:^|[\\s"'])--?${credentialName}["']?(?:\\s|=|$)`, 'i');

/** Shared by new tool activity and the presentation of previously stored labels. */
export function redactToolActivityDetail(target: string): string {
  if (typeof target !== 'string') return '';
  const sensitivePath = target.split(/[\\/\s"'`;|&(){},=<>]+/).some(part => sensitiveFiles.has(part.toLowerCase())
    || /^\.env[.*?]/i.test(part)
    || /^(?:credentials?|secrets?|service[-_]account|private[-_]key)(?:\.|$)/i.test(part)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(part)
    || /\.(?:pem|key|p12|pfx)$/i.test(part));
  const credentials = credentialAssignment.test(target) || credentialOption.test(target)
    || /\b(?:proxy-)?authorization["']?\s*[:=]|\bbearer\s+\S/i.test(target)
    || /(?:^|\s)(?:--user(?:\s+|=)|-u(?:\s+|=)?)[^\s]+:[^\s]+/i.test(target)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^\s/"'@]+@/i.test(target);
  // Replace the whole target: quoting/whitespace can make a value span words,
  // and truncating first could expose a credential prefix without its marker.
  return sensitivePath || credentials ? '[sensitive target redacted]' : target.slice(0, 240);
}

/** Surface only the action and target, never source code/tool argument payloads. */
export function toolActivity(id: string, call: ToolCall): ToolActivity {
  let detail = '';
  try {
    const args = parseToolInput(call.function.arguments);
    const target = args?.path ?? args?.command ?? args?.query ?? args?.pattern;
    if (typeof target === 'string') detail = redactToolActivityDetail(target);
  } catch { /* Malformed input will be reported by the tool executor. */ }
  return { id, title: titles[call.function.name] ?? call.function.name, detail, state: 'running' };
}
