import { describe, expect, it, vi } from 'vitest';
import { formatReviewReport, submitReviewTool, validateReviewReport } from '../../src/review-report';
import { ReviewEvidenceSource, ReviewFinding } from '../../src/review-types';

function source(overrides: Partial<ReviewEvidenceSource> = {}): ReviewEvidenceSource {
  return {
    request: { source: 'unstaged' }, label: 'Unstaged changes', diff: 'patch', limitations: ['Only changed hunks were reviewed.'],
    files: [{ path: 'src/example.ts', status: 'M', binary: false, hunks: [{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 2 }] }],
    readFile: vi.fn(async () => 'unchanged\nconst unsafe = true;\nuse(unsafe);\n'),
    ...overrides,
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: 'Unsafe default', severity: 'High', classification: 'confirmed', explanation: 'The default bypasses the intended guard.',
    evidence: 'const unsafe = true;', path: 'src/example.ts', side: 'target', startLine: 2, endLine: 2,
    ...overrides,
  };
}

const payload = (...findings: ReviewFinding[]) => ({ summary: 'Reviewed the selected changes.', findings });

it('defines a bounded structured submit tool without model-provided test or limitation fields', () => {
  const tool = submitReviewTool();
  expect(tool.function.name).toBe('submit_review');
  expect(tool.function.parameters).toMatchObject({
    additionalProperties: false, required: ['summary', 'findings'],
    properties: { findings: { maxItems: 20, items: { required: expect.arrayContaining(['evidence', 'side', 'startLine', 'severity']) } } },
  });
});

it('validates source evidence, keeps immutable content once per path and side, and sorts severity then location', async () => {
  const evidence = source();
  const report = await validateReviewReport(payload(
    finding({ severity: 'Low' }), finding({ severity: 'Critical', startLine: 3, endLine: 3, evidence: 'use(unsafe);' }),
    finding({ severity: 'Critical' }),
  ), evidence);
  expect(report.findings.map(item => [item.severity, item.startLine])).toEqual([['Critical', 2], ['Critical', 3], ['Low', 2]]);
  expect(evidence.readFile).toHaveBeenCalledExactlyOnceWith('src/example.ts', 'target');
  expect(report.sources).toEqual([{ path: 'src/example.ts', side: 'target', content: 'unchanged\nconst unsafe = true;\nuse(unsafe);\n' }]);
  expect(report.testsRun).toBe(false);
  expect(report.limitations).toEqual(evidence.limitations);
  expect(report.limitations).not.toBe(evidence.limitations);
});

it('formats an empty report with a bounded assurance caveat and truthful test status', async () => {
  const evidence = source();
  const report = await validateReviewReport(payload(), evidence);
  const markdown = formatReviewReport(report);
  expect(evidence.readFile).not.toHaveBeenCalled();
  expect(markdown).toContain('## Confirmed findings\n\nNone reported.');
  expect(markdown).toContain('## Potential risks\n\nNone reported.');
  expect(markdown).toContain('This does not establish that the changes are defect-free.');
  expect(markdown).toContain('Tests were not run.');
  expect(markdown).toContain('Only changed hunks were reviewed');
});

it('preserves the historical base side of renamed or deleted files', async () => {
  const evidence = source({
    request: { source: 'commits', base: 'abc', target: 'def' }, label: 'abc..def',
    files: [{ path: 'src/renamed.ts', oldPath: 'src/example.ts', status: 'R100', binary: false, hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] }],
  });
  const report = await validateReviewReport(payload(finding({ side: 'base' })), evidence);
  expect(evidence.readFile).toHaveBeenCalledExactlyOnceWith('src/example.ts', 'base');
  expect(report.sources[0]).toMatchObject({ path: 'src/example.ts', side: 'base' });
  expect(formatReviewReport(report)).toContain('src/example\\.ts:2 (base side)');
  evidence.files[0].status = 'D';
  await expect(validateReviewReport(payload(finding({ path: 'src/renamed.ts' })), evidence)).rejects.toThrow('file or side');
  await expect(validateReviewReport(payload(finding({ side: 'base' })), evidence)).resolves.toMatchObject({ testsRun: false });
});

describe('rejects invalid locations before reading arbitrary source paths', () => {
  it.each([
    { path: '../secret' }, { path: '/src/example.ts' }, { path: 'src\\example.ts' },
    { path: 'src/./example.ts' }, { path: 'C:/src/example.ts' }, { path: 'missing.ts' },
    { startLine: 1, endLine: 2 }, { startLine: 3, endLine: 4 }, { startLine: 3, endLine: 2 },
    { startLine: 2.5 }, { startLine: 0 }, { endLine: Infinity },
  ])('%j', async (overrides) => {
    const evidence = source();
    await expect(validateReviewReport(payload(finding(overrides)), evidence)).rejects.toThrow('location');
    expect(evidence.readFile).not.toHaveBeenCalled();
  });

  it('rejects empty spans, binary files, and the absent base side of additions', async () => {
    for (const file of [
      { path: 'src/example.ts', status: 'M', binary: false, hunks: [{ oldStart: 1, oldLines: 0, newStart: 2, newLines: 0 }] },
      { path: 'src/example.ts', status: 'M', binary: true, hunks: [{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 2 }] },
      { path: 'src/example.ts', status: 'A', binary: false, hunks: [{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 2 }] },
    ]) {
      const evidence = source({ files: [file] });
      await expect(validateReviewReport(payload(finding({ side: 'base' })), evidence)).rejects.toThrow('location');
      expect(evidence.readFile).not.toHaveBeenCalled();
    }
  });

  it('rejects a range crossing separate hunks and a line beyond the actual source', async () => {
    const evidence = source({ files: [{ path: 'src/example.ts', status: 'M', binary: false, hunks: [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }, { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
    ] }] });
    await expect(validateReviewReport(payload(finding({ endLine: 3 })), evidence)).rejects.toThrow('hunk');
    evidence.files[0].hunks = [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3 }];
    await expect(validateReviewReport(payload(finding({ startLine: 4, endLine: 4 })), evidence)).rejects.toThrow('source file');
  });
});

it('rejects forged or misplaced evidence rather than silently dropping a finding', async () => {
  await expect(validateReviewReport(payload(finding({ evidence: 'invented();' })), source())).rejects.toThrow('evidence');
  await expect(validateReviewReport(payload(finding({ evidence: 'use(unsafe);' })), source())).rejects.toThrow('evidence');
  await expect(validateReviewReport(payload(finding(), finding({ evidence: 'invented();' })), source())).rejects.toThrow('evidence');
});

it('matches multiline evidence across CRLF without altering saved source content', async () => {
  const content = 'unchanged\r\nconst unsafe = true;\r\nuse(unsafe);\r\n';
  const report = await validateReviewReport(payload(finding({ endLine: 3, evidence: 'const unsafe = true;\nuse(unsafe);' })), source({ readFile: async () => content }));
  expect(report.sources[0].content).toBe(content);
});

it.each([
  null, [], {}, { summary: 'ok', findings: {} }, { summary: '', findings: [] },
  { summary: 'x'.repeat(4001), findings: [] }, { summary: 'ok', findings: Array.from({ length: 21 }, () => finding()) },
  { ...payload(), testsRun: true }, { ...payload(), limitations: ['all tests passed'] },
  { summary: 'ok', findings: [null] }, { summary: 'ok', findings: [[]] },
  payload({ ...finding(), severity: 'Urgent' } as unknown as ReviewFinding),
  payload({ ...finding(), classification: 'certain' } as unknown as ReviewFinding),
  payload({ ...finding(), side: 'live' } as unknown as ReviewFinding),
  payload(finding({ evidence: ' ' })), payload(finding({ title: 'x'.repeat(201) })),
  payload(finding({ explanation: 'x'.repeat(4001) })), payload(finding({ evidence: 'x'.repeat(4001) })),
])('rejects malformed, oversized, or forged report fields (%#)', async (input) => {
  await expect(validateReviewReport(input as Record<string, unknown>, source())).rejects.toThrow('Invalid review');
});

it('escapes model Markdown and HTML and separates confirmed findings from potential risks', async () => {
  const report = await validateReviewReport(payload(
    finding({ title: '[click](command:evil)', explanation: '<script>alert(1)</script>' }),
    finding({ classification: 'potential', severity: 'Low', title: 'Potential risk' }),
  ), source());
  const markdown = formatReviewReport(report);
  expect(markdown).toContain('\\[click\\]\\(command:evil\\)');
  expect(markdown).toContain('&lt;script&gt;alert\\(1\\)&lt;/script&gt;');
  expect(markdown).not.toContain('<script>');
  expect(markdown.indexOf('### High:')).toBeLessThan(markdown.indexOf('## Potential risks'));
  expect(markdown.indexOf('### Low:')).toBeGreaterThan(markdown.indexOf('## Potential risks'));
  expect(markdown).toContain('> const unsafe = true;');
});
