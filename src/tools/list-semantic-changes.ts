import { z } from 'zod';
import { GitClient } from '../git/git-client.js';
import { ParserManager } from '../parser/parser-manager.js';
import { ConflictDetector } from '../detector/conflict-detector.js';
import { TypeScriptExtractor } from '../extractor/typescript-extractor.js';
import { SemanticDiff } from '../extractor/semantic-model.js';
import { getLanguageForFile, SemanticChange } from '../types.js';

export const ListSemanticChangesInput = z.object({
  repoPath: z.string().describe('Absolute path to the Git repository'),
  branch: z.string().describe('Branch to analyze'),
  baseBranch: z.string().optional().describe('Base branch to compare against (defaults to merge-base with HEAD)'),
});

export type ListSemanticChangesParams = z.infer<typeof ListSemanticChangesInput>;

export async function listSemanticChanges(
  params: ListSemanticChangesParams,
  parser: ParserManager
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const git = new GitClient(params.repoPath);

  const branchExists = await git.branchExists(params.branch);
  if (!branchExists) {
    return { content: [{ type: 'text', text: `Error: Branch "${params.branch}" does not exist.` }] };
  }

  const base = params.baseBranch ?? 'HEAD';
  const mergeBase = await git.getMergeBase(base, params.branch);
  const changedFiles = await git.getChangedFiles(mergeBase, params.branch);

  const detector = new ConflictDetector(git, parser);
  const allChanges: { filePath: string; changes: SemanticChange[] }[] = [];

  for (const file of changedFiles) {
    if (!parser.supportsLanguage(file.filePath)) continue;

    const [baseContent, branchContent] = await Promise.all([
      git.getFileContent(mergeBase, file.filePath),
      git.getFileContent(params.branch, file.filePath),
    ]);

    const tsExtractor = new TypeScriptExtractor();

    const baseModel = baseContent ? (() => {
      const tree = parser.parse(baseContent, file.filePath);
      if (!tree) return null;
      const lang = getLanguageForFile(file.filePath);
      if (lang === 'typescript' || lang === 'javascript') {
        return tsExtractor.extract(tree, file.filePath, lang);
      }
      return null;
    })() : null;

    const branchModel = branchContent ? (() => {
      const tree = parser.parse(branchContent, file.filePath);
      if (!tree) return null;
      const lang = getLanguageForFile(file.filePath);
      if (lang === 'typescript' || lang === 'javascript') {
        return tsExtractor.extract(tree, file.filePath, lang);
      }
      return null;
    })() : null;

    const diff = detector.computeSemanticDiff(baseModel, branchModel, file.filePath);
    const changes = diffToSemanticChanges(diff, file.filePath);

    if (changes.length > 0) {
      allChanges.push({ filePath: file.filePath, changes });
    }
  }

  return { content: [{ type: 'text', text: formatChangesReport(params.branch, mergeBase, allChanges) }] };
}

function diffToSemanticChanges(diff: SemanticDiff, filePath: string): SemanticChange[] {
  const changes: SemanticChange[] = [];

  for (const f of diff.addedFunctions) {
    changes.push({ type: 'function-added', symbolName: f.name, description: `New function (${f.parameters.length} params)`, filePath });
  }
  for (const f of diff.removedFunctions) {
    changes.push({ type: 'function-removed', symbolName: f.name, description: 'Function removed', filePath });
  }
  for (const { before, after } of diff.changedFunctions) {
    changes.push({
      type: 'function-signature-changed',
      symbolName: before.name,
      description: `Signature changed (params: ${before.parameters.length}→${after.parameters.length}, return: ${before.returnType ?? 'void'}→${after.returnType ?? 'void'})`,
      filePath,
    });
  }
  for (const e of diff.addedExports) {
    changes.push({ type: 'export-added', symbolName: e.name, description: `New export (${e.kind})`, filePath });
  }
  for (const e of diff.removedExports) {
    changes.push({ type: 'export-removed', symbolName: e.name, description: 'Export removed', filePath });
  }
  for (const i of diff.addedImports) {
    changes.push({
      type: 'import-added',
      symbolName: i.source,
      description: `New import: { ${i.specifiers.map((s) => s.name).join(', ')} }`,
      filePath,
    });
  }
  for (const i of diff.removedImports) {
    changes.push({
      type: 'import-removed',
      symbolName: i.source,
      description: `Import removed: { ${i.specifiers.map((s) => s.name).join(', ')} }`,
      filePath,
    });
  }
  for (const t of diff.addedTypes) {
    changes.push({ type: 'type-added', symbolName: t.name, description: `New ${t.kind} (${t.fields.length} fields)`, filePath });
  }
  for (const t of diff.removedTypes) {
    changes.push({ type: 'type-removed', symbolName: t.name, description: `${t.kind} removed`, filePath });
  }
  for (const { before, after } of diff.changedTypes) {
    changes.push({
      type: 'type-changed',
      symbolName: before.name,
      description: `${before.kind} changed (fields: ${before.fields.length}→${after.fields.length})`,
      filePath,
    });
  }
  for (const e of diff.addedEnums) {
    changes.push({ type: 'enum-value-added', symbolName: e.name, description: `New enum (${e.members.length} members)`, filePath });
  }
  for (const e of diff.removedEnums) {
    changes.push({ type: 'enum-value-removed', symbolName: e.name, description: 'Enum removed', filePath });
  }

  return changes;
}

function formatChangesReport(
  branch: string,
  base: string,
  allChanges: { filePath: string; changes: SemanticChange[] }[]
): string {
  const lines: string[] = [];

  lines.push(`# Semantic Changes on \`${branch}\``);
  lines.push('');
  lines.push(`**Base:** \`${base.substring(0, 8)}\``);
  lines.push(`**Total files with semantic changes:** ${allChanges.length}`);
  lines.push(`**Total changes:** ${allChanges.reduce((sum, f) => sum + f.changes.length, 0)}`);

  if (allChanges.length === 0) {
    lines.push('');
    lines.push('No semantic changes detected on this branch.');
  } else {
    for (const { filePath, changes } of allChanges) {
      lines.push('');
      lines.push(`## \`${filePath}\``);
      for (const change of changes) {
        lines.push(`- **${change.type}**: \`${change.symbolName}\` — ${change.description}`);
      }
    }
  }

  return lines.join('\n');
}
