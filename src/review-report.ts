import { ChatTool } from './protocol';
import { ReviewEvidenceSource, ReviewFinding, ReviewReport } from './review-types';

const MAX_FINDINGS = 20;
const MAX_TEXT = 4000;
const MAX_TITLE = 200;
const MAX_PATH = 4096;
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
const CLASSIFICATIONS = ['confirmed', 'potential'] as const;
const SIDES = ['base', 'target'] as const;
const FINDING_FIELDS = ['title', 'severity', 'classification', 'explanation', 'evidence', 'path', 'side', 'startLine', 'endLine'];

export function submitReviewTool(): ChatTool {
  const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
  return {
    type: 'function',
    function: {
      name: 'submit_review',
      description: 'Submit the completed read-only code review. Cite exact evidence from changed lines; classify uncertain findings as potential. Tests are not run by this review.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'findings'],
        properties: {
          summary: text(MAX_TEXT),
          findings: {
            type: 'array', maxItems: MAX_FINDINGS,
            items: {
              type: 'object', additionalProperties: false, required: FINDING_FIELDS,
              properties: {
                title: text(MAX_TITLE), severity: { type: 'string', enum: SEVERITIES },
                classification: { type: 'string', enum: CLASSIFICATIONS },
                explanation: text(MAX_TEXT), evidence: text(MAX_TEXT), path: text(MAX_PATH),
                side: { type: 'string', enum: SIDES },
                startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
    },
  };
}

/** Validate every finding before presenting any model-generated review as a report. */
export async function validateReviewReport(input: Record<string, unknown>, source: ReviewEvidenceSource): Promise<ReviewReport> {
  const payload = record(input);
  fields(payload, ['summary', 'findings']);
  const summary = boundedText(payload.summary, 'summary', MAX_TEXT);
  if (!Array.isArray(payload.findings) || payload.findings.length > MAX_FINDINGS) {
    throw new Error(`Invalid review findings: expected an array of at most ${MAX_FINDINGS} findings.`);
  }
  const findings = payload.findings.map((value): ReviewFinding => {
    const item = record(value);
    fields(item, FINDING_FIELDS);
    const finding: ReviewFinding = {
      title: boundedText(item.title, 'title', MAX_TITLE),
      severity: enumValue(item.severity, SEVERITIES, 'severity'),
      classification: enumValue(item.classification, CLASSIFICATIONS, 'classification'),
      explanation: boundedText(item.explanation, 'explanation', MAX_TEXT),
      evidence: boundedText(item.evidence, 'evidence', MAX_TEXT),
      path: boundedText(item.path, 'path', MAX_PATH),
      side: enumValue(item.side, SIDES, 'side'),
      startLine: lineNumber(item.startLine), endLine: lineNumber(item.endLine),
    };
    if (finding.endLine < finding.startLine) throw new Error('Invalid review location: line range is reversed.');
    if (!canonicalPath(finding.path)) throw new Error('Invalid review location: expected a canonical repository path.');
    const file = source.files.find(file => finding.path === (finding.side === 'base' ? file.oldPath ?? file.path : file.path));
    if (!file || file.binary || (finding.side === 'base' && file.status.startsWith('A')) || (finding.side === 'target' && file.status.startsWith('D'))) {
      throw new Error('Invalid review location: file or side is absent from the reviewed text changes.');
    }
    const inHunk = file.hunks.some(hunk => {
      const start = finding.side === 'base' ? hunk.oldStart : hunk.newStart;
      const count = finding.side === 'base' ? hunk.oldLines : hunk.newLines;
      return count > 0 && finding.startLine >= start && finding.endLine < start + count;
    });
    if (!inHunk) throw new Error('Invalid review location: cited lines must be inside one changed hunk.');
    return finding;
  });

  const sources: ReviewReport['sources'] = [];
  const contentByLocation = new Map<string, string>();
  for (const finding of findings) {
    const key = JSON.stringify([finding.path, finding.side]);
    let content = contentByLocation.get(key);
    if (content === undefined) {
      content = await source.readFile(finding.path, finding.side);
      contentByLocation.set(key, content);
      sources.push({ path: finding.path, side: finding.side, content });
    }
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    // A trailing newline terminates the last line rather than creating another source line.
    if (lines[lines.length - 1] === '') lines.pop();
    if (finding.endLine > lines.length) throw new Error('Invalid review location: cited lines exceed the source file.');
    const cited = lines.slice(finding.startLine - 1, finding.endLine).join('\n');
    if (!cited.includes(finding.evidence.replace(/\r\n/g, '\n'))) {
      throw new Error('Invalid review evidence: evidence must occur verbatim in the cited source lines.');
    }
  }
  findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
    || a.path.localeCompare(b.path) || a.side.localeCompare(b.side) || a.startLine - b.startLine || a.endLine - b.endLine);
  return { summary, findings, limitations: [...source.limitations], sources, label: source.label, testsRun: false };
}

export function formatReviewReport(report: ReviewReport): string {
  const lines = ['# Code review', '', escapeMarkdown(report.label), '', escapeMarkdown(report.summary)];
  for (const classification of CLASSIFICATIONS) {
    lines.push('', `## ${classification === 'confirmed' ? 'Confirmed findings' : 'Potential risks'}`);
    const findings = report.findings.filter(finding => finding.classification === classification);
    if (!findings.length) lines.push('', 'None reported.');
    for (const finding of findings) {
      const location = `${finding.path}:${finding.startLine}${finding.endLine === finding.startLine ? '' : `-${finding.endLine}`}`;
      lines.push('', `### ${finding.severity}: ${escapeMarkdown(finding.title)}`,
        '', `${escapeMarkdown(location)} (${finding.side} side)`,
        '', escapeMarkdown(finding.explanation), '', 'Evidence:', '',
        ...finding.evidence.split(/\r?\n/).map(line => `> ${escapeMarkdown(line)}`));
    }
  }
  if (!report.findings.length) {
    lines.push('', 'No actionable findings were identified in the reviewed changes. This does not establish that the changes are defect-free.');
  }
  lines.push('', '## Limitations', '', 'Tests were not run. This was a read-only review.');
  for (const limitation of report.limitations) lines.push('', `- ${escapeMarkdown(limitation)}`);
  return lines.join('\n');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review payload: expected an object.');
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) {
    throw new Error('Invalid review payload: unexpected or missing fields.');
  }
}

function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid review ${name}: expected nonempty text of at most ${max} characters.`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`Invalid review ${name}.`);
  return value as T;
}

function lineNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid review location: expected positive integer line numbers.');
  return value;
}

function canonicalPath(value: string): boolean {
  return !value.includes('\\') && !value.includes(':') && !value.startsWith('/')
    && !/[\r\n\t]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
}
