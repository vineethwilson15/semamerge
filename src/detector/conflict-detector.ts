import path from 'node:path';
import {
  FileSemanticModel,
  SemanticDiff,
  FunctionSignature,
  TypeDeclaration,
  ImportDeclaration,
  ExportDeclaration,
  EnumDeclaration,
  ConstantDeclaration,
} from '../extractor/semantic-model.js';
import {
  SemanticConflict,
  RiskLevel,
  FileAnalysisResult,
  SemanticChange,
  AnalysisResult,
} from '../types.js';
import { CONFLICT_RULES, calculateRiskScore } from './conflict-types.js';
import { GitClient } from '../git/git-client.js';
import { ParserManager } from '../parser/parser-manager.js';
import { TypeScriptExtractor } from '../extractor/typescript-extractor.js';
import { getLanguageForFile } from '../types.js';

export class ConflictDetector {
  private git: GitClient;
  private parser: ParserManager;
  private tsExtractor: TypeScriptExtractor;

  constructor(git: GitClient, parser: ParserManager) {
    this.git = git;
    this.parser = parser;
    this.tsExtractor = new TypeScriptExtractor();
  }

  async analyzeBranches(
    branchA: string,
    branchB: string,
    baseBranch?: string
  ): Promise<AnalysisResult> {
    const { base, branchAChanges, branchBChanges, overlappingFiles } =
      await this.git.getThreeWayChangedFiles(branchA, branchB, baseBranch);

    // Get all unique files touched by either branch
    const allFilesA = new Set(branchAChanges.map((f) => f.filePath));
    const allFilesB = new Set(branchBChanges.map((f) => f.filePath));

    const fileResults: FileAnalysisResult[] = [];
    const allConflicts: SemanticConflict[] = [];

    // Analyze overlapping files (both branches modified the same file)
    for (const filePath of overlappingFiles) {
      if (!this.parser.supportsLanguage(filePath)) continue;

      const result = await this.analyzeFileThreeWay(filePath, base, branchA, branchB);
      if (result) {
        fileResults.push(result);
        allConflicts.push(...result.conflicts);
      }
    }

    // Cross-file analysis: Branch A changes exports, Branch B imports from those files
    const crossFileConflicts = await this.detectCrossFileConflicts(
      base,
      branchA,
      branchB,
      branchAChanges.map((f) => f.filePath),
      branchBChanges.map((f) => f.filePath)
    );
    allConflicts.push(...crossFileConflicts);

    const riskScore = calculateRiskScore(allConflicts);
    const riskLevel = this.scoreToRiskLevel(riskScore);

    return {
      repoPath: '',
      branchA,
      branchB,
      baseBranch: base,
      conflicts: allConflicts,
      riskLevel,
      summary: this.generateSummary(allConflicts, riskLevel, branchA, branchB),
      fileResults,
    };
  }

  async analyzeFileThreeWay(
    filePath: string,
    base: string,
    branchA: string,
    branchB: string
  ): Promise<FileAnalysisResult | null> {
    const [baseContent, contentA, contentB] = await Promise.all([
      this.git.getFileContent(base, filePath),
      this.git.getFileContent(branchA, filePath),
      this.git.getFileContent(branchB, filePath),
    ]);

    const baseModel = this.extractModel(baseContent, filePath);
    const modelA = this.extractModel(contentA, filePath);
    const modelB = this.extractModel(contentB, filePath);

    if (!baseModel && !modelA && !modelB) return null;

    const diffA = this.computeSemanticDiff(baseModel, modelA, filePath);
    const diffB = this.computeSemanticDiff(baseModel, modelB, filePath);

    const conflicts = this.detectConflictsFromDiffs(diffA, diffB, filePath);
    const branchAChanges = this.diffToChanges(diffA, filePath);
    const branchBChanges = this.diffToChanges(diffB, filePath);

    return { filePath, conflicts, branchAChanges, branchBChanges };
  }

  async analyzeFilePair(
    filePath: string,
    branchA: string,
    branchB: string
  ): Promise<FileAnalysisResult | null> {
    const base = await this.git.getMergeBase(branchA, branchB);
    return this.analyzeFileThreeWay(filePath, base, branchA, branchB);
  }

  private extractModel(content: string | null, filePath: string): FileSemanticModel | null {
    if (!content) return null;

    const tree = this.parser.parse(content, filePath);
    if (!tree) return null;

    const lang = getLanguageForFile(filePath);
    if (lang === 'typescript' || lang === 'javascript') {
      return this.tsExtractor.extract(tree, filePath, lang);
    }

    return null;
  }

  computeSemanticDiff(
    base: FileSemanticModel | null,
    target: FileSemanticModel | null,
    filePath: string
  ): SemanticDiff {
    const empty: SemanticDiff = {
      filePath,
      addedFunctions: [],
      removedFunctions: [],
      changedFunctions: [],
      addedExports: [],
      removedExports: [],
      addedImports: [],
      removedImports: [],
      changedImports: [],
      addedTypes: [],
      removedTypes: [],
      changedTypes: [],
      addedEnums: [],
      removedEnums: [],
      changedEnums: [],
      addedConstants: [],
      removedConstants: [],
      changedConstants: [],
    };

    if (!base && !target) return empty;
    if (!base && target) {
      // All new
      return {
        ...empty,
        addedFunctions: target.functions,
        addedExports: target.exports,
        addedImports: target.imports,
        addedTypes: target.types,
        addedEnums: target.enums,
        addedConstants: target.constants,
      };
    }
    if (base && !target) {
      // All removed
      return {
        ...empty,
        removedFunctions: base.functions,
        removedExports: base.exports,
        removedImports: base.imports,
        removedTypes: base.types,
        removedEnums: base.enums,
        removedConstants: base.constants,
      };
    }

    // Both exist — diff them
    const b = base!;
    const t = target!;

    empty.addedFunctions = t.functions.filter((f) => !b.functions.some((bf) => bf.name === f.name));
    empty.removedFunctions = b.functions.filter((f) => !t.functions.some((tf) => tf.name === f.name));
    empty.changedFunctions = t.functions
      .filter((f) => {
        const bf = b.functions.find((bf) => bf.name === f.name);
        return bf && !this.functionsEqual(bf, f);
      })
      .map((f) => ({ before: b.functions.find((bf) => bf.name === f.name)!, after: f }));

    empty.addedExports = t.exports.filter((e) => !b.exports.some((be) => be.name === e.name));
    empty.removedExports = b.exports.filter((e) => !t.exports.some((te) => te.name === e.name));

    empty.addedImports = t.imports.filter(
      (i) => !b.imports.some((bi) => bi.source === i.source && this.importsEqual(bi, i))
    );
    empty.removedImports = b.imports.filter(
      (i) => !t.imports.some((ti) => ti.source === i.source && this.importsEqual(ti, i))
    );
    empty.changedImports = t.imports
      .filter((i) => {
        const bi = b.imports.find((bi) => bi.source === i.source);
        return bi && !this.importsEqual(bi, i);
      })
      .map((i) => ({ before: b.imports.find((bi) => bi.source === i.source)!, after: i }));

    empty.addedTypes = t.types.filter((ty) => !b.types.some((bt) => bt.name === ty.name));
    empty.removedTypes = b.types.filter((ty) => !t.types.some((tt) => tt.name === ty.name));
    empty.changedTypes = t.types
      .filter((ty) => {
        const bt = b.types.find((bt) => bt.name === ty.name);
        return bt && !this.typesEqual(bt, ty);
      })
      .map((ty) => ({ before: b.types.find((bt) => bt.name === ty.name)!, after: ty }));

    empty.addedEnums = t.enums.filter((e) => !b.enums.some((be) => be.name === e.name));
    empty.removedEnums = b.enums.filter((e) => !t.enums.some((te) => te.name === e.name));
    empty.changedEnums = t.enums
      .filter((e) => {
        const be = b.enums.find((be) => be.name === e.name);
        return be && !this.enumsEqual(be, e);
      })
      .map((e) => ({ before: b.enums.find((be) => be.name === e.name)!, after: e }));

    empty.addedConstants = t.constants.filter((c) => !b.constants.some((bc) => bc.name === c.name));
    empty.removedConstants = b.constants.filter((c) => !t.constants.some((tc) => tc.name === c.name));
    empty.changedConstants = t.constants
      .filter((c) => {
        const bc = b.constants.find((bc) => bc.name === c.name);
        return bc && !this.constantsEqual(bc, c);
      })
      .map((c) => ({ before: b.constants.find((bc) => bc.name === c.name)!, after: c }));

    return empty;
  }

  private detectConflictsFromDiffs(
    diffA: SemanticDiff,
    diffB: SemanticDiff,
    filePath: string
  ): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];

    // 1. Both branches changed the same function's signature
    for (const changeA of diffA.changedFunctions) {
      const changeB = diffB.changedFunctions.find((c) => c.before.name === changeA.before.name);
      if (changeB) {
        conflicts.push({
          type: 'type-signature-change',
          severity: CONFLICT_RULES['type-signature-change'].severity,
          filePath,
          description: `Both branches modified function "${changeA.before.name}" with different signatures`,
          branchAChange: this.describeFunctionChange(changeA.before, changeA.after),
          branchBChange: this.describeFunctionChange(changeB.before, changeB.after),
          location: { symbolName: changeA.before.name, line: changeA.after.line },
        });
      }
    }

    // 2. Branch A changed a function signature, Branch B uses it (added call / import)
    for (const changeA of diffA.changedFunctions) {
      if (!this.functionsParamsEqual(changeA.before, changeA.after)) {
        // Check if branch B added imports of the function or has it unchanged
        const branchBHasUnchanged = !diffB.changedFunctions.some(
          (c) => c.before.name === changeA.before.name
        );
        if (branchBHasUnchanged && !diffB.removedFunctions.some((f) => f.name === changeA.before.name)) {
          conflicts.push({
            type: 'parameter-change',
            severity: CONFLICT_RULES['parameter-change'].severity,
            filePath,
            description: `Branch A changed parameters of "${changeA.before.name}" — Branch B may still call it with old signature`,
            branchAChange: this.describeFunctionChange(changeA.before, changeA.after),
            branchBChange: 'Uses existing signature (no changes)',
            location: { symbolName: changeA.before.name, line: changeA.after.line },
          });
        }
      }
    }

    // Symmetric check: Branch B changed params, Branch A uses it
    for (const changeB of diffB.changedFunctions) {
      if (!this.functionsParamsEqual(changeB.before, changeB.after)) {
        const branchAHasUnchanged = !diffA.changedFunctions.some(
          (c) => c.before.name === changeB.before.name
        );
        if (branchAHasUnchanged && !diffA.removedFunctions.some((f) => f.name === changeB.before.name)) {
          // Avoid duplicate if already reported above
          const alreadyReported = conflicts.some(
            (c) => c.location?.symbolName === changeB.before.name && c.type === 'parameter-change'
          );
          if (!alreadyReported) {
            conflicts.push({
              type: 'parameter-change',
              severity: CONFLICT_RULES['parameter-change'].severity,
              filePath,
              description: `Branch B changed parameters of "${changeB.before.name}" — Branch A may still call it with old signature`,
              branchAChange: 'Uses existing signature (no changes)',
              branchBChange: this.describeFunctionChange(changeB.before, changeB.after),
              location: { symbolName: changeB.before.name, line: changeB.after.line },
            });
          }
        }
      }
    }

    // 3. Branch A removed an export, Branch B adds an import of it (or depends on it)
    for (const removedExport of diffA.removedExports) {
      const addedImport = diffB.addedImports.find((i) =>
        i.specifiers.some((s) => s.name === removedExport.name)
      );
      if (addedImport) {
        conflicts.push({
          type: 'removed-export',
          severity: CONFLICT_RULES['removed-export'].severity,
          filePath,
          description: `Branch A removed export "${removedExport.name}" but Branch B imports it`,
          branchAChange: `Removed export "${removedExport.name}"`,
          branchBChange: `Added import of "${removedExport.name}" from "${addedImport.source}"`,
          location: { symbolName: removedExport.name },
        });
      }
    }

    // Symmetric
    for (const removedExport of diffB.removedExports) {
      const addedImport = diffA.addedImports.find((i) =>
        i.specifiers.some((s) => s.name === removedExport.name)
      );
      if (addedImport) {
        conflicts.push({
          type: 'removed-export',
          severity: CONFLICT_RULES['removed-export'].severity,
          filePath,
          description: `Branch B removed export "${removedExport.name}" but Branch A imports it`,
          branchAChange: `Added import of "${removedExport.name}" from "${addedImport.source}"`,
          branchBChange: `Removed export "${removedExport.name}"`,
          location: { symbolName: removedExport.name },
        });
      }
    }

    // 4. Interface/type contract break: both branches modify the same type differently
    for (const changeA of diffA.changedTypes) {
      const changeB = diffB.changedTypes.find((c) => c.before.name === changeA.before.name);
      if (changeB) {
        conflicts.push({
          type: 'interface-contract-break',
          severity: CONFLICT_RULES['interface-contract-break'].severity,
          filePath,
          description: `Both branches modified ${changeA.before.kind} "${changeA.before.name}" differently`,
          branchAChange: this.describeTypeChange(changeA.before, changeA.after),
          branchBChange: this.describeTypeChange(changeB.before, changeB.after),
          location: { symbolName: changeA.before.name, line: changeA.after.line },
        });
      }
    }

    // Branch A adds required field to interface, Branch B doesn't update implementations
    for (const changeA of diffA.changedTypes) {
      const newRequiredFields = changeA.after.fields.filter(
        (f) => !f.optional && !changeA.before.fields.some((bf) => bf.name === f.name)
      );
      if (newRequiredFields.length > 0) {
        const branchBDidntChange = !diffB.changedTypes.some(
          (c) => c.before.name === changeA.before.name
        );
        if (branchBDidntChange) {
          conflicts.push({
            type: 'interface-contract-break',
            severity: CONFLICT_RULES['interface-contract-break'].severity,
            filePath,
            description: `Branch A added required field(s) to "${changeA.before.name}" — Branch B implementations may be incomplete`,
            branchAChange: `Added required fields: ${newRequiredFields.map((f) => f.name).join(', ')}`,
            branchBChange: 'No changes to this type (may have stale implementations)',
            location: { symbolName: changeA.before.name },
          });
        }
      }
    }

    // 5. Enum/constant conflicts
    for (const changeA of diffA.changedEnums) {
      const changeB = diffB.changedEnums.find((c) => c.before.name === changeA.before.name);
      if (changeB) {
        conflicts.push({
          type: 'enum-constant-change',
          severity: CONFLICT_RULES['enum-constant-change'].severity,
          filePath,
          description: `Both branches modified enum "${changeA.before.name}" differently`,
          branchAChange: this.describeEnumChange(changeA.before, changeA.after),
          branchBChange: this.describeEnumChange(changeB.before, changeB.after),
          location: { symbolName: changeA.before.name },
        });
      }
    }

    // Branch A removes enum member, Branch B might use it
    for (const changeA of diffA.changedEnums) {
      const removedMembers = changeA.before.members.filter(
        (m) => !changeA.after.members.some((am) => am.name === m.name)
      );
      if (removedMembers.length > 0 && !diffB.changedEnums.some((c) => c.before.name === changeA.before.name)) {
        conflicts.push({
          type: 'enum-constant-change',
          severity: CONFLICT_RULES['enum-constant-change'].severity,
          filePath,
          description: `Branch A removed enum member(s) from "${changeA.before.name}" — Branch B may reference them`,
          branchAChange: `Removed members: ${removedMembers.map((m) => m.name).join(', ')}`,
          branchBChange: 'No changes to this enum (may reference removed members)',
          location: { symbolName: changeA.before.name },
        });
      }
    }

    return conflicts;
  }

  private async detectCrossFileConflicts(
    base: string,
    branchA: string,
    branchB: string,
    filesA: string[],
    filesB: string[]
  ): Promise<SemanticConflict[]> {
    const conflicts: SemanticConflict[] = [];

    // For files modified on branch A, check if their exports changed
    // and if branch B has files that import from them
    for (const fileA of filesA) {
      if (!this.parser.supportsLanguage(fileA)) continue;

      const [baseContent, contentA] = await Promise.all([
        this.git.getFileContent(base, fileA),
        this.git.getFileContent(branchA, fileA),
      ]);

      const baseModel = this.extractModel(baseContent, fileA);
      const modelA = this.extractModel(contentA, fileA);
      const diff = this.computeSemanticDiff(baseModel, modelA, fileA);

      // Check if branch A removed exports that branch B's new files import
      for (const removedExport of diff.removedExports) {
        for (const fileB of filesB) {
          if (!this.parser.supportsLanguage(fileB)) continue;

          const contentB = await this.git.getFileContent(branchB, fileB);
          const modelB = this.extractModel(contentB, fileB);
          if (!modelB) continue;

          const importsRemoved = modelB.imports.some(
            (imp) =>
              this.importMatchesFile(imp.source, fileB, fileA) &&
              imp.specifiers.some((s) => s.name === removedExport.name)
          );

          if (importsRemoved) {
            conflicts.push({
              type: 'removed-export',
              severity: 'error',
              filePath: fileA,
              description: `Branch A removed export "${removedExport.name}" from ${fileA}, but Branch B imports it in ${fileB}`,
              branchAChange: `Removed export "${removedExport.name}" from ${fileA}`,
              branchBChange: `Imports "${removedExport.name}" in ${fileB}`,
              location: { symbolName: removedExport.name },
            });
          }
        }
      }

      // Check parameter changes for cross-file impact
      for (const changedFunc of diff.changedFunctions) {
        if (!changedFunc.before.exported) continue;
        if (this.functionsParamsEqual(changedFunc.before, changedFunc.after)) continue;

        for (const fileB of filesB) {
          if (!this.parser.supportsLanguage(fileB)) continue;

          const contentB = await this.git.getFileContent(branchB, fileB);
          const modelB = this.extractModel(contentB, fileB);
          if (!modelB) continue;

          const importsFunc = modelB.imports.some(
            (imp) =>
              this.importMatchesFile(imp.source, fileB, fileA) &&
              imp.specifiers.some((s) => s.name === changedFunc.before.name)
          );

          if (importsFunc) {
            conflicts.push({
              type: 'parameter-change',
              severity: 'error',
              filePath: fileA,
              description: `Branch A changed params of exported "${changedFunc.before.name}" in ${fileA} — Branch B calls it in ${fileB}`,
              branchAChange: this.describeFunctionChange(changedFunc.before, changedFunc.after),
              branchBChange: `Imports and uses "${changedFunc.before.name}" in ${fileB}`,
              location: { symbolName: changedFunc.before.name },
            });
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Check if an import source from importingFile could refer to targetFile.
   * e.g. importSource='./utils', importingFile='src/service.ts', targetFile='src/utils.ts' → true
   */
  private importMatchesFile(importSource: string, importingFile: string, targetFile: string): boolean {
    const targetNoExt = targetFile.replace(/\.[^.]+$/, '');
    const targetBasename = path.basename(targetNoExt);

    // Direct substring match (covers absolute/aliased imports)
    if (importSource.includes(targetBasename)) {
      // Resolve relative import if it starts with . or ..
      if (importSource.startsWith('.')) {
        const importingDir = path.dirname(importingFile);
        const resolved = path.posix.normalize(path.posix.join(importingDir.replace(/\\/g, '/'), importSource));
        const targetNorm = targetNoExt.replace(/\\/g, '/');
        return resolved === targetNorm || targetNorm.endsWith(resolved);
      }
      return true;
    }
    return false;
  }

  // --- Comparison helpers ---

  private functionsEqual(a: FunctionSignature, b: FunctionSignature): boolean {
    return (
      this.functionsParamsEqual(a, b) &&
      a.returnType === b.returnType &&
      a.isAsync === b.isAsync &&
      a.exported === b.exported
    );
  }

  private functionsParamsEqual(a: FunctionSignature, b: FunctionSignature): boolean {
    if (a.parameters.length !== b.parameters.length) return false;
    return a.parameters.every(
      (p, i) =>
        p.name === b.parameters[i].name &&
        p.type === b.parameters[i].type &&
        p.optional === b.parameters[i].optional
    );
  }

  private importsEqual(a: ImportDeclaration, b: ImportDeclaration): boolean {
    if (a.source !== b.source) return false;
    if (a.specifiers.length !== b.specifiers.length) return false;
    return a.specifiers.every(
      (s, i) => s.name === b.specifiers[i].name && s.alias === b.specifiers[i].alias
    );
  }

  private typesEqual(a: TypeDeclaration, b: TypeDeclaration): boolean {
    if (a.fields.length !== b.fields.length) return false;
    return a.fields.every(
      (f, i) =>
        f.name === b.fields[i].name &&
        f.type === b.fields[i].type &&
        f.optional === b.fields[i].optional
    );
  }

  private enumsEqual(a: EnumDeclaration, b: EnumDeclaration): boolean {
    if (a.members.length !== b.members.length) return false;
    return a.members.every(
      (m, i) => m.name === b.members[i].name && m.value === b.members[i].value
    );
  }

  private constantsEqual(a: ConstantDeclaration, b: ConstantDeclaration): boolean {
    return a.type === b.type && a.value === b.value;
  }

  private diffToChanges(diff: SemanticDiff, filePath: string): SemanticChange[] {
    const changes: SemanticChange[] = [];

    for (const f of diff.addedFunctions) {
      changes.push({ type: 'function-added', symbolName: f.name, description: `New function (${f.parameters.length} params)`, filePath });
    }
    for (const f of diff.removedFunctions) {
      changes.push({ type: 'function-removed', symbolName: f.name, description: 'Function removed', filePath });
    }
    for (const { before, after } of diff.changedFunctions) {
      changes.push({ type: 'function-signature-changed', symbolName: before.name, description: this.describeFunctionChange(before, after), filePath });
    }
    for (const e of diff.addedExports) {
      changes.push({ type: 'export-added', symbolName: e.name, description: `New export (${e.kind})`, filePath });
    }
    for (const e of diff.removedExports) {
      changes.push({ type: 'export-removed', symbolName: e.name, description: 'Export removed', filePath });
    }
    for (const i of diff.addedImports) {
      changes.push({ type: 'import-added', symbolName: i.source, description: `New import: { ${i.specifiers.map((s) => s.name).join(', ')} }`, filePath });
    }
    for (const i of diff.removedImports) {
      changes.push({ type: 'import-removed', symbolName: i.source, description: `Import removed`, filePath });
    }
    for (const t of diff.addedTypes) {
      changes.push({ type: 'type-added', symbolName: t.name, description: `New ${t.kind}`, filePath });
    }
    for (const t of diff.removedTypes) {
      changes.push({ type: 'type-removed', symbolName: t.name, description: `${t.kind} removed`, filePath });
    }
    for (const { before, after } of diff.changedTypes) {
      changes.push({ type: 'type-changed', symbolName: before.name, description: this.describeTypeChange(before, after), filePath });
    }

    return changes;
  }

  // --- Description helpers ---

  private describeFunctionChange(before: FunctionSignature, after: FunctionSignature): string {
    const changes: string[] = [];
    if (!this.functionsParamsEqual(before, after)) {
      changes.push(
        `params: (${before.parameters.map((p) => p.name).join(', ')}) → (${after.parameters.map((p) => p.name).join(', ')})`
      );
    }
    if (before.returnType !== after.returnType) {
      changes.push(`return: ${before.returnType ?? 'void'} → ${after.returnType ?? 'void'}`);
    }
    if (before.isAsync !== after.isAsync) {
      changes.push(after.isAsync ? 'made async' : 'made sync');
    }
    return changes.join('; ') || 'signature changed';
  }

  private describeTypeChange(before: TypeDeclaration, after: TypeDeclaration): string {
    const added = after.fields.filter((f) => !before.fields.some((bf) => bf.name === f.name));
    const removed = before.fields.filter((f) => !after.fields.some((af) => af.name === f.name));
    const parts: string[] = [];
    if (added.length) parts.push(`added fields: ${added.map((f) => f.name).join(', ')}`);
    if (removed.length) parts.push(`removed fields: ${removed.map((f) => f.name).join(', ')}`);
    return parts.join('; ') || 'type changed';
  }

  private describeEnumChange(before: EnumDeclaration, after: EnumDeclaration): string {
    const added = after.members.filter((m) => !before.members.some((bm) => bm.name === m.name));
    const removed = before.members.filter((m) => !after.members.some((am) => am.name === m.name));
    const parts: string[] = [];
    if (added.length) parts.push(`added: ${added.map((m) => m.name).join(', ')}`);
    if (removed.length) parts.push(`removed: ${removed.map((m) => m.name).join(', ')}`);
    return parts.join('; ') || 'enum changed';
  }

  private scoreToRiskLevel(score: number): RiskLevel {
    if (score === 0) return 'safe';
    if (score <= 10) return 'warning';
    return 'danger';
  }

  private generateSummary(
    conflicts: SemanticConflict[],
    riskLevel: RiskLevel,
    branchA: string,
    branchB: string
  ): string {
    if (conflicts.length === 0) {
      return `No semantic conflicts detected between "${branchA}" and "${branchB}". Merge appears safe.`;
    }

    const errors = conflicts.filter((c) => c.severity === 'error').length;
    const warnings = conflicts.filter((c) => c.severity === 'warning').length;

    let summary = `Found ${conflicts.length} potential semantic conflict(s) between "${branchA}" and "${branchB}"`;
    if (errors > 0) summary += ` — ${errors} error(s)`;
    if (warnings > 0) summary += `, ${warnings} warning(s)`;
    summary += `. Risk level: **${riskLevel.toUpperCase()}**.`;

    return summary;
  }
}
