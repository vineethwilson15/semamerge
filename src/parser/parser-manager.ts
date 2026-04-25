import Parser from 'web-tree-sitter';
import { SupportedLanguage, getLanguageForFile } from '../types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ParserManager {
  private parser: Parser | null = null;
  private languages: Map<SupportedLanguage, Parser.Language> = new Map();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await Parser.init();
    this.parser = new Parser();

    // Load language grammars — look for .wasm files in multiple possible locations
    await this.loadLanguage('typescript', 'tree-sitter-typescript.wasm');
    await this.loadLanguage('javascript', 'tree-sitter-javascript.wasm');
    await this.loadLanguage('python', 'tree-sitter-python.wasm');

    this.initialized = true;
  }

  private async loadLanguage(lang: SupportedLanguage, wasmFile: string): Promise<void> {
    const searchPaths = [
      path.join(__dirname, '..', '..', 'node_modules', 'tree-sitter-wasms', 'out', wasmFile),
      path.join(__dirname, '..', '..', 'parsers', wasmFile),
      path.join(__dirname, '..', '..', 'node_modules', 'web-tree-sitter', wasmFile),
      path.join(__dirname, '..', '..', wasmFile),
    ];

    for (const searchPath of searchPaths) {
      try {
        if (fs.existsSync(searchPath)) {
          const language = await Parser.Language.load(searchPath);
          this.languages.set(lang, language);
          return;
        }
      } catch {
        // try next path
      }
    }

    // Language not available — that's OK, we just won't parse those files
    console.error(`Warning: Could not load ${lang} grammar (${wasmFile}). Skipping.`);
  }

  parse(sourceCode: string, filePath: string): Parser.Tree | null {
    if (!this.parser) {
      throw new Error('ParserManager not initialized. Call initialize() first.');
    }

    const lang = getLanguageForFile(filePath);
    if (!lang) return null;

    // JavaScript files use the javascript grammar; TS/TSX use typescript
    const language = this.languages.get(lang);
    if (!language) return null;

    this.parser.setLanguage(language);
    return this.parser.parse(sourceCode);
  }

  supportsLanguage(filePath: string): boolean {
    const lang = getLanguageForFile(filePath);
    if (!lang) return false;
    return this.languages.has(lang);
  }

  getLanguage(filePath: string): SupportedLanguage | null {
    return getLanguageForFile(filePath);
  }
}
