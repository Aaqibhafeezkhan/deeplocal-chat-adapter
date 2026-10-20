export type ReviewSource = 'unstaged' | 'staged' | 'commits';

export interface ReviewRequest {
  source: ReviewSource;
  base?: string;
  target?: string;
}

export type ReviewSide = 'base' | 'target';

export interface ReviewHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ReviewFile {
  path: string;
  oldPath?: string;
  status: string;
  binary: boolean;
  hunks: ReviewHunk[];
}

export interface ReviewEvidenceSource {
  request: ReviewRequest;
  files: ReviewFile[];
  diff: string;
  label: string;
  limitations: string[];
  readFile(path: string, side?: ReviewSide): Promise<string>;
}

export interface ReviewFinding {
  title: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  classification: 'confirmed' | 'potential';
  explanation: string;
  evidence: string;
  path: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
}

export interface ReviewReport {
  summary: string;
  findings: ReviewFinding[];
  limitations: string[];
  sources: Array<{ path: string; side: ReviewSide; content: string }>;
  label: string;
  testsRun: false;
}
