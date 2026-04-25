import Parser from 'web-tree-sitter';
import {
  FileSemanticModel,
  FunctionSignature,
  ParameterInfo,
  TypeDeclaration,
  FieldInfo,
  ImportDeclaration,
  ImportSpecifier,
  ExportDeclaration,
  EnumDeclaration,
  EnumMember,
  ConstantDeclaration,
  createEmptySemanticModel,
} from './semantic-model.js';

/**
 * Extracts a semantic model from TypeScript/JavaScript ASTs produced by tree-sitter.
 */
export class TypeScriptExtractor {
  extract(tree: Parser.Tree, filePath: string, language: 'typescript' | 'javascript'): FileSemanticModel {
    const model = createEmptySemanticModel(filePath, language);
    const root = tree.rootNode;

    for (let i = 0; i < root.childCount; i++) {
      const node = root.child(i);
      if (!node) continue;

      this.visitTopLevelNode(node, model);
    }

    return model;
  }

  private visitTopLevelNode(node: Parser.SyntaxNode, model: FileSemanticModel): void {
    switch (node.type) {
      case 'function_declaration':
        this.extractFunction(node, model, false);
        break;

      case 'export_statement':
        this.extractExportStatement(node, model);
        break;

      case 'import_statement':
        this.extractImport(node, model);
        break;

      case 'interface_declaration':
        this.extractTypeDeclaration(node, model, 'interface', false);
        break;

      case 'type_alias_declaration':
        this.extractTypeDeclaration(node, model, 'type', false);
        break;

      case 'class_declaration':
        this.extractTypeDeclaration(node, model, 'class', false);
        break;

      case 'enum_declaration':
        this.extractEnum(node, model, false);
        break;

      case 'lexical_declaration':
      case 'variable_declaration':
        this.extractConstants(node, model, false);
        break;

      case 'expression_statement':
        // Could be module.exports = ...
        break;
    }
  }

  private extractExportStatement(node: Parser.SyntaxNode, model: FileSemanticModel): void {
    // export default ...
    const isDefault = node.children.some((c) => c.type === 'default');

    // export { name1, name2 }
    const exportClause = node.childForFieldName('declaration') ?? this.findChild(node, 'export_clause');

    if (exportClause) {
      switch (exportClause.type) {
        case 'function_declaration':
          this.extractFunction(exportClause, model, true);
          break;
        case 'interface_declaration':
          this.extractTypeDeclaration(exportClause, model, 'interface', true);
          break;
        case 'type_alias_declaration':
          this.extractTypeDeclaration(exportClause, model, 'type', true);
          break;
        case 'class_declaration':
          this.extractTypeDeclaration(exportClause, model, 'class', true);
          break;
        case 'enum_declaration':
          this.extractEnum(exportClause, model, true);
          break;
        case 'lexical_declaration':
        case 'variable_declaration':
          this.extractConstants(exportClause, model, true);
          break;
        case 'export_clause':
          this.extractExportClause(exportClause, model);
          break;
      }
    }

    // Track export declarations
    const declaration = node.childForFieldName('declaration');
    if (declaration) {
      const name = this.getDeclarationName(declaration);
      if (name) {
        model.exports.push({
          name,
          kind: isDefault ? 'default' : this.getExportKind(declaration.type),
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  private extractFunction(node: Parser.SyntaxNode, model: FileSemanticModel, exported: boolean): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const params = this.extractParameters(node);
    const returnType = this.extractReturnType(node);
    const isAsync = node.children.some((c) => c.type === 'async');

    const sig: FunctionSignature = {
      name,
      parameters: params,
      returnType,
      exported,
      isAsync,
      line: node.startPosition.row + 1,
    };

    model.functions.push(sig);
    if (exported) {
      model.exports.push({ name, kind: 'function', line: node.startPosition.row + 1 });
    }
  }

  private extractParameters(node: Parser.SyntaxNode): ParameterInfo[] {
    const paramsNode = node.childForFieldName('parameters') ?? this.findChild(node, 'formal_parameters');
    if (!paramsNode) return [];

    const params: ParameterInfo[] = [];

    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (!child) continue;

      if (
        child.type === 'required_parameter' ||
        child.type === 'optional_parameter' ||
        child.type === 'identifier' ||
        child.type === 'assignment_pattern'
      ) {
        const param = this.extractSingleParameter(child);
        if (param) params.push(param);
      }
    }

    return params;
  }

  private extractSingleParameter(node: Parser.SyntaxNode): ParameterInfo | null {
    let name = '';
    let type: string | null = null;
    let optional = false;
    let defaultValue: string | null = null;

    if (node.type === 'identifier') {
      name = node.text;
    } else if (node.type === 'assignment_pattern') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      name = left?.text ?? '';
      defaultValue = right?.text ?? null;
      optional = true;
    } else {
      // required_parameter or optional_parameter
      const pattern = node.childForFieldName('pattern');
      name = pattern?.text ?? node.children.find((c) => c.type === 'identifier')?.text ?? '';
      optional = node.type === 'optional_parameter';

      const typeAnnotation = node.childForFieldName('type') ?? this.findChild(node, 'type_annotation');
      if (typeAnnotation) {
        type = typeAnnotation.text.replace(/^:\s*/, '');
      }

      const defaultNode = node.childForFieldName('value');
      if (defaultNode) {
        defaultValue = defaultNode.text;
        optional = true;
      }
    }

    if (!name) return null;
    return { name, type, optional, defaultValue };
  }

  private extractReturnType(node: Parser.SyntaxNode): string | null {
    const returnType = node.childForFieldName('return_type') ?? this.findChild(node, 'type_annotation');
    if (returnType) {
      return returnType.text.replace(/^:\s*/, '');
    }
    return null;
  }

  private extractTypeDeclaration(
    node: Parser.SyntaxNode,
    model: FileSemanticModel,
    kind: 'interface' | 'type' | 'class',
    exported: boolean
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const fields = this.extractFields(node);

    const typeDecl: TypeDeclaration = {
      name,
      kind,
      fields,
      exported,
      line: node.startPosition.row + 1,
    };

    model.types.push(typeDecl);
    if (exported) {
      model.exports.push({ name, kind, line: node.startPosition.row + 1 });
    }
  }

  private extractFields(node: Parser.SyntaxNode): FieldInfo[] {
    const fields: FieldInfo[] = [];

    const body =
      node.childForFieldName('body') ??
      this.findChild(node, 'interface_body') ??
      this.findChild(node, 'object_type') ??
      this.findChild(node, 'class_body');

    if (!body) return fields;

    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (!child) continue;

      if (
        child.type === 'property_signature' ||
        child.type === 'public_field_definition' ||
        child.type === 'property_definition'
      ) {
        const nameChild = child.childForFieldName('name');
        if (!nameChild) continue;

        const typeAnnotation = child.childForFieldName('type') ?? this.findChild(child, 'type_annotation');
        const optional = child.children.some((c) => c.text === '?');

        fields.push({
          name: nameChild.text,
          type: typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, '') : null,
          optional,
        });
      }
    }

    return fields;
  }

  private extractImport(node: Parser.SyntaxNode, model: FileSemanticModel): void {
    const sourceNode = node.childForFieldName('source') ?? this.findChild(node, 'string');
    if (!sourceNode) return;

    const source = sourceNode.text.replace(/['"]/g, '');
    const specifiers: ImportSpecifier[] = [];
    let isDefault = false;
    let isNamespace = false;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;

      if (child.type === 'import_clause') {
        for (let j = 0; j < child.childCount; j++) {
          const clause = child.child(j);
          if (!clause) continue;

          if (clause.type === 'identifier') {
            isDefault = true;
            specifiers.push({ name: clause.text, alias: null });
          } else if (clause.type === 'named_imports') {
            this.extractNamedImports(clause, specifiers);
          } else if (clause.type === 'namespace_import') {
            isNamespace = true;
            const alias = clause.children.find((c) => c.type === 'identifier');
            if (alias) specifiers.push({ name: '*', alias: alias.text });
          }
        }
      }
    }

    model.imports.push({
      source,
      specifiers,
      isDefault,
      isNamespace,
      line: node.startPosition.row + 1,
    });
  }

  private extractNamedImports(node: Parser.SyntaxNode, specifiers: ImportSpecifier[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child || child.type !== 'import_specifier') continue;

      const nameNode = child.childForFieldName('name');
      const aliasNode = child.childForFieldName('alias');

      if (nameNode) {
        specifiers.push({
          name: nameNode.text,
          alias: aliasNode?.text ?? null,
        });
      }
    }
  }

  private extractExportClause(node: Parser.SyntaxNode, model: FileSemanticModel): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child || child.type !== 'export_specifier') continue;

      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        model.exports.push({
          name: nameNode.text,
          kind: 'unknown',
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  private extractEnum(node: Parser.SyntaxNode, model: FileSemanticModel, exported: boolean): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const members: EnumMember[] = [];

    const body = node.childForFieldName('body') ?? this.findChild(node, 'enum_body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (!child) continue;

        if (child.type === 'enum_member' || child.type === 'enum_assignment') {
          // enum_assignment: property_identifier = value
          const memberName = child.childForFieldName('name')
            ?? this.findChild(child, 'property_identifier');
          const memberValue = child.childForFieldName('value')
            ?? child.children.find((c) => c.type === 'number' || c.type === 'string');
          if (memberName) {
            members.push({
              name: memberName.text,
              value: memberValue?.text ?? null,
            });
          }
        } else if (child.type === 'property_identifier') {
          // Bare enum member without assignment
          members.push({
            name: child.text,
            value: null,
          });
        }
      }
    }

    model.enums.push({ name, members, exported, line: node.startPosition.row + 1 });
    if (exported) {
      model.exports.push({ name, kind: 'enum', line: node.startPosition.row + 1 });
    }
  }

  private extractConstants(node: Parser.SyntaxNode, model: FileSemanticModel, exported: boolean): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child || child.type !== 'variable_declarator') continue;

      const nameNode = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      const typeNode = child.childForFieldName('type') ?? this.findChild(child, 'type_annotation');

      if (nameNode) {
        // Check if value is a function expression/arrow function
        if (
          valueNode &&
          (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression' || valueNode.type === 'function')
        ) {
          // Extract as function instead of constant
          const params = this.extractParameters(valueNode);
          const returnType = this.extractReturnType(valueNode);
          const isAsync = valueNode.children.some((c) => c.type === 'async');

          model.functions.push({
            name: nameNode.text,
            parameters: params,
            returnType,
            exported,
            isAsync,
            line: node.startPosition.row + 1,
          });
        } else {
          model.constants.push({
            name: nameNode.text,
            type: typeNode ? typeNode.text.replace(/^:\s*/, '') : null,
            value: valueNode?.text ?? null,
            exported,
            line: node.startPosition.row + 1,
          });
        }

        if (exported) {
          model.exports.push({
            name: nameNode.text,
            kind: 'variable',
            line: node.startPosition.row + 1,
          });
        }
      }
    }
  }

  private findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === type) return child;
    }
    return null;
  }

  private getDeclarationName(node: Parser.SyntaxNode): string | null {
    const nameNode = node.childForFieldName('name');
    if (nameNode) return nameNode.text;

    // For variable declarations, look inside the first declarator
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'variable_declarator') {
          const name = child.childForFieldName('name');
          return name?.text ?? null;
        }
      }
    }

    return null;
  }

  private getExportKind(nodeType: string): ExportDeclaration['kind'] {
    switch (nodeType) {
      case 'function_declaration':
        return 'function';
      case 'class_declaration':
        return 'class';
      case 'interface_declaration':
        return 'interface';
      case 'type_alias_declaration':
        return 'type';
      case 'enum_declaration':
        return 'enum';
      case 'lexical_declaration':
      case 'variable_declaration':
        return 'variable';
      default:
        return 'unknown';
    }
  }
}
