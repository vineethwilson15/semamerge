import { z } from 'zod';
import { GitClient } from '../git/git-client.js';
import { ParserManager } from '../parser/parser-manager.js';
import { ConflictDetector } from '../detector/conflict-detector.js';
import { FileAnalysisResult, SemanticConflict } from '../types.js';

export const AnalyzeFilePairInput = z.object({
  repoPath: z.string().describe('Absolute path to the Git repository'),
  filePath: z.string().describe('Path to the file within the repository'),
  branchA: z.string().describe('First branch'),
  branchB: z.string().describe('Second branch'),
});

export type AnalyzeFilePairParams = z.infer<typeof AnalyzeFilePairInput>;

export async function analyzeFilePair(
  params: AnalyzeFilePairParams,
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

  if (!parser.supportsLanguage(params.filePath)) {
    return {
      content: [{
        type: 'text',
        text: `Error: Unsupported file type for "${params.filePath}". Supported: .ts, .tsx, .js, .jsx, .mjs, .cjs, .py`,
      }],
    };
  }

  const detector = new ConflictDetector(git, parser);
  const result = await detector.analyzeFilePair(params.filePath, params.branchA, params.branchB);

  if (!result) {
    return {
      content: [{
        type: 'text',
        text: `No semantic data could be extracted for "${params.filePath}". The file may not exist on both branches.`,
      }],
    };
  }

  return { content: [{ type: 'text', text: formatFilePairReport(result, params.branchA, params.branchB) }] };
}

function formatFilePairReport(
  result: FileAnalysisResult,
  branchA: string,
  branchB: string
): string {
  const lines: string[] = [];

  lines.push(`# Semantic Diff: \`${result.filePath}\``);
  lines.push('');
  lines.push(`**Branch A:** \`${branchA}\` | **Branch B:** \`${branchB}\``);
  lines.push('');

  if (result.branchAChanges.length > 0) {
    lines.push(`## Changes on \`${branchA}\``);
    for (const change of result.branchAChanges) {
      lines.push(`- **${change.type}**: \`${change.symbolName}\` — ${change.description}`);
    }
    lines.push('');
  }

  if (result.branchBChanges.length > 0) {
    lines.push(`## Changes on \`${branchB}\``);
    for (const change of result.branchBChanges) {
      lines.push(`- **${change.type}**: \`${change.symbolName}\` — ${change.description}`);
    }
    lines.push('');
  }

  if (result.conflicts.length > 0) {
    lines.push('## Semantic Conflicts');
    lines.push('');
    for (const conflict of result.conflicts) {
      const icon = conflict.severity === 'error' ? '❌' : '⚠️';
      lines.push(`### ${icon} ${conflict.type}`);
      lines.push(`**${conflict.description}**`);
      lines.push(`- Branch A: ${conflict.branchAChange}`);
      lines.push(`- Branch B: ${conflict.branchBChange}`);
      if (conflict.location?.symbolName) {
        lines.push(`- Symbol: \`${conflict.location.symbolName}\``);
      }
      lines.push('');
    }
  } else {
    lines.push('## No Semantic Conflicts');
    lines.push('No conflicting semantic changes detected in this file.');
  }

  return lines.join('\n');
}
