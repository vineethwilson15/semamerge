# SemaMerge

[![npm version](https://img.shields.io/npm/v/semamerge.svg)](https://www.npmjs.com/package/semamerge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP (Model Context Protocol) server that detects **semantic merge conflicts** between Git branches using AST-level analysis.

When two branches change code in ways that Git merges cleanly but are functionally incompatible, SemaMerge catches it before the merge breaks your app.

## What It Detects

| Conflict Type | Example |
|---|---|
| **Type signature change** | Branch A changes `getUser()` return type, Branch B calls `getUser().address` |
| **Removed/renamed export** | Branch A removes `export function validate()`, Branch B adds `import { validate }` |
| **Parameter change** | Branch A adds required param to function, Branch B calls with old signature |
| **Interface/contract break** | Branch A adds required field to interface, Branch B implements without it |
| **Enum/constant change** | Branch A removes `Status.PENDING`, Branch B uses `Status.PENDING` |
| **Import path change** | Branch A moves file, Branch B imports from old path |

## Installation

```bash
npx semamerge
```

Or install globally:

```bash
npm install -g semamerge
```

Or clone and build from source:

```bash
git clone https://github.com/YOUR_USERNAME/semamerge.git
cd semamerge
npm install
npm run build
```

## MCP Tools

### `check_merge_safety`
Quick pre-merge check. Returns a risk score (safe/warning/danger).

```json
{
  "repoPath": "/path/to/repo",
  "sourceBranch": "feature-x",
  "targetBranch": "main"
}
```

### `analyze_branches`
Deep analysis with per-file breakdown of all semantic conflicts.

```json
{
  "repoPath": "/path/to/repo",
  "branchA": "feature-x",
  "branchB": "feature-y",
  "baseBranch": "main"
}
```

### `list_semantic_changes`
Lists all semantic changes on a branch (functions, exports, types, etc.).

```json
{
  "repoPath": "/path/to/repo",
  "branch": "feature-x",
  "baseBranch": "main"
}
```

### `analyze_file_pair`
Deep-dive into a specific file's semantic diff between two branches.

```json
{
  "repoPath": "/path/to/repo",
  "filePath": "src/utils.ts",
  "branchA": "feature-x",
  "branchB": "main"
}
```

## Configuration

### VS Code (Copilot)

Add to your VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "semamerge": {
        "command": "node",
        "args": ["/path/to/semamerge/dist/index.js"]
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "semamerge": {
      "command": "node",
      "args": ["/path/to/semamerge/dist/index.js"]
    }
  }
}
```

## Supported Languages

- TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`)
- Python support planned

## How It Works

1. **Git layer** — Reads file content from branches without checkout using `git show`
2. **AST parsing** — Parses source code with tree-sitter (WASM) into syntax trees
3. **Semantic extraction** — Walks ASTs to extract function signatures, types, exports, imports, enums
4. **Three-way comparison** — Computes semantic diffs from common ancestor to each branch
5. **Conflict detection** — Cross-references changes to find incompatibilities

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode
npm test         # Run tests
```

## License

MIT
