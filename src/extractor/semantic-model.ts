/**
 * Semantic model types — the structured representation of code semantics
 * extracted from ASTs across different languages.
 */

export interface FunctionSignature {
  name: string;
  parameters: ParameterInfo[];
  returnType: string | null;
  exported: boolean;
  isAsync: boolean;
  line?: number;
}

export interface ParameterInfo {
  name: string;
  type: string | null;
  optional: boolean;
  defaultValue: string | null;
}

export interface TypeDeclaration {
  name: string;
  kind: 'interface' | 'type' | 'class';
  fields: FieldInfo[];
  exported: boolean;
  line?: number;
}

export interface FieldInfo {
  name: string;
  type: string | null;
  optional: boolean;
}

export interface ImportDeclaration {
  source: string;
  specifiers: ImportSpecifier[];
  isDefault: boolean;
  isNamespace: boolean;
  line?: number;
}

export interface ImportSpecifier {
  name: string;
  alias: string | null;
}

export interface ExportDeclaration {
  name: string;
  kind: 'function' | 'class' | 'type' | 'interface' | 'variable' | 'enum' | 'default' | 'unknown';
  line?: number;
}

export interface EnumDeclaration {
  name: string;
  members: EnumMember[];
  exported: boolean;
  line?: number;
}

export interface EnumMember {
  name: string;
  value: string | null;
}

export interface ConstantDeclaration {
  name: string;
  type: string | null;
  value: string | null;
  exported: boolean;
  line?: number;
}

/**
 * The full semantic model for a single file.
 */
export interface FileSemanticModel {
  filePath: string;
  language: string;
  functions: FunctionSignature[];
  types: TypeDeclaration[];
  imports: ImportDeclaration[];
  exports: ExportDeclaration[];
  enums: EnumDeclaration[];
  constants: ConstantDeclaration[];
}

/**
 * Represents the semantic diff between two versions of a file.
 */
export interface SemanticDiff {
  filePath: string;
  addedFunctions: FunctionSignature[];
  removedFunctions: FunctionSignature[];
  changedFunctions: { before: FunctionSignature; after: FunctionSignature }[];
  addedExports: ExportDeclaration[];
  removedExports: ExportDeclaration[];
  addedImports: ImportDeclaration[];
  removedImports: ImportDeclaration[];
  changedImports: { before: ImportDeclaration; after: ImportDeclaration }[];
  addedTypes: TypeDeclaration[];
  removedTypes: TypeDeclaration[];
  changedTypes: { before: TypeDeclaration; after: TypeDeclaration }[];
  addedEnums: EnumDeclaration[];
  removedEnums: EnumDeclaration[];
  changedEnums: { before: EnumDeclaration; after: EnumDeclaration }[];
  addedConstants: ConstantDeclaration[];
  removedConstants: ConstantDeclaration[];
  changedConstants: { before: ConstantDeclaration; after: ConstantDeclaration }[];
}

export function createEmptySemanticModel(filePath: string, language: string): FileSemanticModel {
  return {
    filePath,
    language,
    functions: [],
    types: [],
    imports: [],
    exports: [],
    enums: [],
    constants: [],
  };
}
