import { z } from 'zod';
import { GitClient } from '../git/git-client.js';
import { ParserManager } from '../parser/parser-manager.js';
import { ConflictDetector } from '../detector/conflict-detector.js';
import { AnalysisResult, SemanticConflict } from '../types.js';

export const AnalyzeBranchesInput = z.object({
  repoPath: z.string().describe('Absolute path to the Git repository'),
  branchA: z.string().describe('First branch to compare'),
  branchB: z.string().describe('Second branch to compare'),
  baseBranch: z.string().optional().describe('Common base branch (auto-detected if not provided)'),
});

export type AnalyzeBranchesParams = z.infer<typeof AnalyzeBranchesInput>;

export async function analyzeBranches(
  params: AnalyzeBranchesParams,
  parser: ParserManager
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const git = new GitClient(params.repoPath);

  const [aExists, bExists] = await Promise.all([
    git.branchExists(params.branchA),
    git.branchExists(params.branchB),
  ]);

  if (!aExists) {
    return { content: [{ type: 'text', text: `Error: Branch "${params.branchA}" does not exist.` }] };
  }
  if (!bExists) {
    return { content: [{ type: 'text', text: `Error: Branch "${params.branchB}" does not exist.` }] };
  }

  const detector = new ConflictDetector(git, parser);
  const result = await detector.analyzeBranches(params.branchA, params.branchB, params.baseBranch);
  result.repoPath = params.repoPath;

  return { content: [{ type: 'text', text: formatDetailedReport(result) }] };
}

function formatDetailedReport(result: AnalysisResult): string {
  const lines: string[] = [];

  lines.push('# Semantic Branch Analysis');
  lines.push('');
  lines.push(`| Property | Value |`);
  lines.push(`|----------|-------|`);
  lines.push(`| Branch A | \`${result.branchA}\` |`);
  lines.push(`| Branch B | \`${result.branchB}\` |`);
  lines.push(`| Base | \`${result.baseBranch}\` |`);
  lines.push(`| Risk Level | **${result.riskLevel.toUpperCase()}** |`);
  lines.push(`| Total Conflicts | ${result.conflicts.length} |`);
  lines.push('');
  lines.push(result.summary);

  if (result.fileResults.length > 0) {
    lines.push('');
    lines.push('## Per-File Analysis');

    for (const file of result.fileResults) {
      lines.push('');
      lines.push(`### \`${file.filePath}\``);

      if (file.branchAChanges.length > 0) {
        lines.push('');
        lines.push('**Branch A changes:**');
        for (const change of file.branchAChanges) {
          lines.push(`- ${change.type}: \`${change.symbolName}\` — ${change.description}`);
        }
      }

      if (file.branchBChanges.length > 0) {
        lines.push('');
        lines.push('**Branch B changes:**');
        for (const change of file.branchBChanges) {
          lines.push(`- ${change.type}: \`${change.symbolName}\` — ${change.description}`);
        }
      }

      if (file.conflicts.length > 0) {
        lines.push('');
        lines.push('**Conflicts:**');
        for (const conflict of file.conflicts) {
          const icon = conflict.severity === 'error' ? '❌' : '⚠️';
          lines.push(`- ${icon} **${conflict.type}**: ${conflict.description}`);
          lines.push(`  - Branch A: ${conflict.branchAChange}`);
          lines.push(`  - Branch B: ${conflict.branchBChange}`);
        }
      }
    }
  }

  if (result.conflicts.length > 0) {
    const crossFile = result.conflicts.filter(
      (c) => !result.fileResults.some((f) => f.conflicts.includes(c))
    );
    if (crossFile.length > 0) {
      lines.push('');
      lines.push('## Cross-File Conflicts');
      for (const conflict of crossFile) {
        const icon = conflict.severity === 'error' ? '❌' : '⚠️';
        lines.push(`- ${icon} **${conflict.type}** in \`${conflict.filePath}\`: ${conflict.description}`);
        lines.push(`  - Branch A: ${conflict.branchAChange}`);
        lines.push(`  - Branch B: ${conflict.branchBChange}`);
      }
    }
  }

  return lines.join('\n');
}
