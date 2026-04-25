export interface BranchPair {
  repoPath: string;
  branchA: string;
  branchB: string;
  baseBranch?: string;
}

export interface FileChange {
  filePath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string; // for renames
}

export interface AnalysisResult {
  repoPath: string;
  branchA: string;
  branchB: string;
  baseBranch: string;
  conflicts: SemanticConflict[];
  riskLevel: RiskLevel;
  summary: string;
  fileResults: FileAnalysisResult[];
}

export interface FileAnalysisResult {
  filePath: string;
  conflicts: SemanticConflict[];
  branchAChanges: SemanticChange[];
  branchBChanges: SemanticChange[];
}

export interface SemanticConflict {
  type: ConflictType;
  severity: ConflictSeverity;
  filePath: string;
  description: string;
  branchAChange: string;
  branchBChange: string;
  location?: {
    line?: number;
    symbolName?: string;
  };
}

export interface SemanticChange {
  type: ChangeType;
  symbolName: string;
  description: string;
  filePath: string;
}

export type ConflictType =
  | 'type-signature-change'
  | 'removed-export'
  | 'parameter-change'
  | 'interface-contract-break'
  | 'enum-constant-change'
  | 'import-path-change';

export type ConflictSeverity = 'error' | 'warning' | 'info';

export type RiskLevel = 'safe' | 'warning' | 'danger';

export type ChangeType =
  | 'function-added'
  | 'function-removed'
  | 'function-signature-changed'
  | 'export-added'
  | 'export-removed'
  | 'import-added'
  | 'import-removed'
  | 'import-changed'
  | 'type-added'
  | 'type-removed'
  | 'type-changed'
  | 'interface-changed'
  | 'enum-value-added'
  | 'enum-value-removed'
  | 'parameter-added'
  | 'parameter-removed'
  | 'parameter-changed'
  | 'constant-changed';

export type SupportedLanguage = 'typescript' | 'javascript' | 'python';

export function getLanguageForFile(filePath: string): SupportedLanguage | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    default:
      return null;
  }
}
