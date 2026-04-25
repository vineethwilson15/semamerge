import { z } from 'zod';
import { GitClient } from '../git/git-client.js';
import { ParserManager } from '../parser/parser-manager.js';
import { ConflictDetector } from '../detector/conflict-detector.js';
import { AnalysisResult, SemanticConflict } from '../types.js';

export const CheckMergeSafetyInput = z.object({
  repoPath: z.string().describe('Absolute path to the Git repository'),
  sourceBranch: z.string().describe('The branch being merged (source)'),
  targetBranch: z.string().describe('The branch being merged into (target)'),
});

export type CheckMergeSafetyParams = z.infer<typeof CheckMergeSafetyInput>;

export async function checkMergeSafety(
  params: CheckMergeSafetyParams,
  parser: ParserManager
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const git = new GitClient(params.repoPath);

  // Validate branches exist
  const [sourceExists, targetExists] = await Promise.all([
    git.branchExists(params.sourceBranch),
    git.branchExists(params.targetBranch),
  ]);

  if (!sourceExists) {
    return { content: [{ type: 'text', text: `Error: Branch "${params.sourceBranch}" does not exist.` }] };
  }
  if (!targetExists) {
    return { content: [{ type: 'text', text: `Error: Branch "${params.targetBranch}" does not exist.` }] };
  }

  const detector = new ConflictDetector(git, parser);
  const result = await detector.analyzeBranches(params.sourceBranch, params.targetBranch);
  result.repoPath = params.repoPath;

  return { content: [{ type: 'text', text: formatMergeSafetyReport(result) }] };
}

function formatMergeSafetyReport(result: AnalysisResult): string {
  const lines: string[] = [];

  const icon = result.riskLevel === 'safe' ? '✅' : result.riskLevel === 'warning' ? '⚠️' : '🚨';
  lines.push(`# ${icon} Merge Safety Check`);
  lines.push('');
  lines.push(`**Source:** \`${result.branchA}\` → **Target:** \`${result.branchB}\``);
  lines.push(`**Risk Level:** ${result.riskLevel.toUpperCase()}`);
  lines.push('');
  lines.push(result.summary);

  if (result.conflicts.length > 0) {
    lines.push('');
    lines.push('## Conflicts');
    lines.push('');
    for (const conflict of result.conflicts) {
      lines.push(formatConflict(conflict));
    }
  }

  return lines.join('\n');
}

function formatConflict(conflict: SemanticConflict): string {
  const icon = conflict.severity === 'error' ? '❌' : '⚠️';
  const lines = [
    `### ${icon} ${conflict.type} — ${conflict.description}`,
    `- **File:** \`${conflict.filePath}\``,
  ];
  if (conflict.location?.symbolName) {
    lines.push(`- **Symbol:** \`${conflict.location.symbolName}\``);
  }
  lines.push(`- **Branch A:** ${conflict.branchAChange}`);
  lines.push(`- **Branch B:** ${conflict.branchBChange}`);
  lines.push('');
  return lines.join('\n');
}
