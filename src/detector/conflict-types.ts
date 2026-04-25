import { ConflictType, ConflictSeverity } from '../types.js';

export interface ConflictRule {
  type: ConflictType;
  severity: ConflictSeverity;
  weight: number; // used for risk scoring
}

export const CONFLICT_RULES: Record<ConflictType, ConflictRule> = {
  'type-signature-change': {
    type: 'type-signature-change',
    severity: 'error',
    weight: 10,
  },
  'removed-export': {
    type: 'removed-export',
    severity: 'error',
    weight: 10,
  },
  'parameter-change': {
    type: 'parameter-change',
    severity: 'error',
    weight: 8,
  },
  'interface-contract-break': {
    type: 'interface-contract-break',
    severity: 'error',
    weight: 9,
  },
  'enum-constant-change': {
    type: 'enum-constant-change',
    severity: 'warning',
    weight: 6,
  },
  'import-path-change': {
    type: 'import-path-change',
    severity: 'warning',
    weight: 5,
  },
};

export function calculateRiskScore(conflicts: { type: ConflictType }[]): number {
  return conflicts.reduce((score, c) => score + (CONFLICT_RULES[c.type]?.weight ?? 0), 0);
}
