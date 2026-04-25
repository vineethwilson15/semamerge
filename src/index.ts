#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ParserManager } from './parser/parser-manager.js';
import { checkMergeSafety, CheckMergeSafetyInput } from './tools/check-merge-safety.js';
import { analyzeBranches, AnalyzeBranchesInput } from './tools/analyze-branches.js';
import { listSemanticChanges, ListSemanticChangesInput } from './tools/list-semantic-changes.js';
import { analyzeFilePair, AnalyzeFilePairInput } from './tools/analyze-file-pair.js';

const parser = new ParserManager();

const server = new McpServer({
  name: 'semamerge',
  version: '0.1.2',
});

// Tool: check_merge_safety
server.tool(
  'check_merge_safety',
  'Quick pre-merge safety check. Analyzes two branches for semantic conflicts that Git would miss (signature changes, removed exports, parameter mismatches, etc.). Returns a risk score: safe/warning/danger.',
  CheckMergeSafetyInput.shape,
  async (params) => {
    await parser.initialize();
    return checkMergeSafety(params, parser);
  }
);

// Tool: analyze_branches
server.tool(
  'analyze_branches',
  'Deep semantic analysis between two branches. Returns a detailed per-file report of all semantic changes and conflicts, including cross-file dependency issues.',
  AnalyzeBranchesInput.shape,
  async (params) => {
    await parser.initialize();
    return analyzeBranches(params, parser);
  }
);

// Tool: list_semantic_changes
server.tool(
  'list_semantic_changes',
  'Lists all semantic changes on a branch (function additions/removals, export changes, type changes, etc.) relative to a base. Useful for understanding what semantically changed.',
  ListSemanticChangesInput.shape,
  async (params) => {
    await parser.initialize();
    return listSemanticChanges(params, parser);
  }
);

// Tool: analyze_file_pair
server.tool(
  'analyze_file_pair',
  'Deep-dive semantic diff of a single file between two branches. Shows exactly what each branch changed and where conflicts arise.',
  AnalyzeFilePairInput.shape,
  async (params) => {
    await parser.initialize();
    return analyzeFilePair(params, parser);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
