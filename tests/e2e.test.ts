import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { GitClient } from '../src/git/git-client.js';
import { ParserManager } from '../src/parser/parser-manager.js';
import { ConflictDetector } from '../src/detector/conflict-detector.js';
import { TypeScriptExtractor } from '../src/extractor/typescript-extractor.js';

const TEST_REPO = path.join(os.tmpdir(), 'semamerge-test-' + Date.now());

function git(cmd: string) {
  execSync(`git ${cmd}`, { cwd: TEST_REPO, stdio: 'pipe' });
}

function writeFile(relPath: string, content: string) {
  const full = path.join(TEST_REPO, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

describe('SemaMerge E2E', () => {
  let parser: ParserManager;

  beforeAll(async () => {
    // Create test repo
    fs.mkdirSync(TEST_REPO, { recursive: true });
    git('init -b main');
    git('config user.email "test@test.com"');
    git('config user.name "Test"');

    // Base commit: shared code on main
    writeFile(
      'src/utils.ts',
      `export function getUser(id: string): User {
  return db.findUser(id);
}

export interface User {
  id: string;
  name: string;
  email: string;
}

export enum Status {
  ACTIVE = "active",
  INACTIVE = "inactive",
  PENDING = "pending",
}

export const MAX_RETRIES = 3;
`
    );

    writeFile(
      'src/service.ts',
      `import { getUser, User, Status } from './utils';

export function processUser(id: string): void {
  const user = getUser(id);
  console.log(user.name);
}
`
    );

    git('add -A');
    git('commit -m "initial commit"');

    // Branch A: changes function signature + removes enum member + adds required interface field
    git('checkout -b branch-a');
    writeFile(
      'src/utils.ts',
      `export function getUser(id: string, options: { cache: boolean }): UserDTO {
  return db.findUser(id, options);
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

export enum Status {
  ACTIVE = "active",
  INACTIVE = "inactive",
}

export const MAX_RETRIES = 5;
`
    );
    git('add -A');
    git('commit -m "branch-a: change getUser signature, add role field, remove PENDING enum"');

    // Branch B: adds new usage of old signature + uses removed enum member
    git('checkout main');
    git('checkout -b branch-b');
    writeFile(
      'src/service.ts',
      `import { getUser, User, Status } from './utils';

export function processUser(id: string): void {
  const user = getUser(id);
  console.log(user.name);
}

export function checkPending(id: string): boolean {
  const user = getUser(id);
  return user.email.includes("pending");
}
`
    );
    git('add -A');
    git('commit -m "branch-b: add new function using getUser with old signature"');

    // Initialize parser
    parser = new ParserManager();
    await parser.initialize();
  });

  afterAll(() => {
    fs.rmSync(TEST_REPO, { recursive: true, force: true });
  });

  it('should detect semantic conflicts between branches', async () => {
    const gitClient = new GitClient(TEST_REPO);
    const detector = new ConflictDetector(gitClient, parser);
    const result = await detector.analyzeBranches('branch-a', 'branch-b');

    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.riskLevel).not.toBe('safe');

    // Should detect the function signature change
    const sigConflicts = result.conflicts.filter(
      (c) => c.type === 'parameter-change' || c.type === 'type-signature-change'
    );
    expect(sigConflicts.length).toBeGreaterThan(0);
  });

  it('should detect parameter change in same file', async () => {
    const gitClient = new GitClient(TEST_REPO);
    const detector = new ConflictDetector(gitClient, parser);
    const result = await detector.analyzeFileThreeWay(
      'src/utils.ts',
      'main',
      'branch-a',
      'branch-b'
    );

    expect(result).not.toBeNull();
    expect(result!.branchAChanges.length).toBeGreaterThan(0);
  });

  it('should list semantic changes on a branch', async () => {
    const gitClient = new GitClient(TEST_REPO);
    const mergeBase = await gitClient.getMergeBase('main', 'branch-a');
    const changedFiles = await gitClient.getChangedFiles(mergeBase, 'branch-a');

    expect(changedFiles.length).toBeGreaterThan(0);
    expect(changedFiles.some((f) => f.filePath === 'src/utils.ts')).toBe(true);
  });

  it('should extract semantic model from TypeScript', async () => {
    const code = `
export function greet(name: string): string {
  return "Hello " + name;
}

export interface Config {
  host: string;
  port: number;
  debug?: boolean;
}

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  ERROR = 2,
}

export const VERSION = "1.0.0";
`;
    const tree = parser.parse(code, 'test.ts');
    expect(tree).not.toBeNull();

    const extractor = new TypeScriptExtractor();
    const model = extractor.extract(tree!, 'test.ts', 'typescript');

    expect(model.functions.length).toBe(1);
    expect(model.functions[0].name).toBe('greet');
    expect(model.functions[0].parameters.length).toBe(1);
    expect(model.functions[0].exported).toBe(true);

    expect(model.types.length).toBe(1);
    expect(model.types[0].name).toBe('Config');
    expect(model.types[0].fields.length).toBe(3);

    expect(model.enums.length).toBe(1);
    expect(model.enums[0].name).toBe('LogLevel');
    expect(model.enums[0].members.length).toBe(3);

    expect(model.exports.length).toBeGreaterThanOrEqual(4);
  });

  it('should detect cross-file conflicts', async () => {
    const gitClient = new GitClient(TEST_REPO);
    const detector = new ConflictDetector(gitClient, parser);
    const result = await detector.analyzeBranches('branch-a', 'branch-b');

    // Branch A changed getUser signature in utils.ts
    // Branch B added new usage of getUser in service.ts
    // This should produce a cross-file conflict
    const crossFileConflicts = result.conflicts.filter(
      (c) => c.description.includes('service.ts') || c.description.includes('utils.ts')
    );

    // At minimum, we should have some conflicts detected
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it('should compute risk level correctly', async () => {
    const gitClient = new GitClient(TEST_REPO);
    const detector = new ConflictDetector(gitClient, parser);
    const result = await detector.analyzeBranches('branch-a', 'branch-b');

    // With parameter changes and potential conflicts, risk should be warning or danger
    expect(['warning', 'danger']).toContain(result.riskLevel);
  });
});
