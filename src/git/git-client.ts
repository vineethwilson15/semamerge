import { simpleGit, SimpleGit } from 'simple-git';
import { FileChange } from '../types.js';

export class GitClient {
  private git: SimpleGit;
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  /**
   * Get file content from a specific git ref (branch, commit, tag) without checkout.
   */
  async getFileContent(ref: string, filePath: string): Promise<string | null> {
    try {
      const content = await this.git.show([`${ref}:${filePath}`]);
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Get list of files changed between two refs.
   */
  async getChangedFiles(refA: string, refB: string): Promise<FileChange[]> {
    const diff = await this.git.diff(['--name-status', '--no-renames', refA, refB]);
    return this.parseDiffOutput(diff);
  }

  /**
   * Get list of files changed between a base and a ref (what changed on a branch).
   */
  async getChangedFilesSinceBase(base: string, ref: string): Promise<FileChange[]> {
    const mergeBase = await this.getMergeBase(base, ref);
    return this.getChangedFiles(mergeBase, ref);
  }

  /**
   * Find the merge base (common ancestor) of two branches.
   */
  async getMergeBase(branchA: string, branchB: string): Promise<string> {
    const result = await this.git.raw(['merge-base', branchA, branchB]);
    return result.trim();
  }

  /**
   * List all local branches.
   */
  async getBranches(): Promise<string[]> {
    const result = await this.git.branchLocal();
    return result.all;
  }

  /**
   * Check if a branch exists.
   */
  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git.raw(['rev-parse', '--verify', branch]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all files that were changed on both branches relative to their common ancestor.
   * Returns files changed on branchA and branchB separately.
   */
  async getThreeWayChangedFiles(
    branchA: string,
    branchB: string,
    baseBranch?: string
  ): Promise<{
    base: string;
    branchAChanges: FileChange[];
    branchBChanges: FileChange[];
    overlappingFiles: string[];
  }> {
    const base = baseBranch
      ? await this.getMergeBase(baseBranch, branchA)
      : await this.getMergeBase(branchA, branchB);

    const [branchAChanges, branchBChanges] = await Promise.all([
      this.getChangedFiles(base, branchA),
      this.getChangedFiles(base, branchB),
    ]);

    const filesA = new Set(branchAChanges.map((f) => f.filePath));
    const filesB = new Set(branchBChanges.map((f) => f.filePath));
    const overlappingFiles = [...filesA].filter((f) => filesB.has(f));

    return { base, branchAChanges, branchBChanges, overlappingFiles };
  }

  private parseDiffOutput(output: string): FileChange[] {
    if (!output.trim()) return [];

    return output
      .trim()
      .split('\n')
      .map((line) => {
        const [status, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t');
        let changeStatus: FileChange['status'];

        switch (status?.charAt(0)) {
          case 'A':
            changeStatus = 'added';
            break;
          case 'D':
            changeStatus = 'deleted';
            break;
          case 'R':
            changeStatus = 'renamed';
            break;
          case 'M':
          default:
            changeStatus = 'modified';
            break;
        }

        return { filePath, status: changeStatus };
      })
      .filter((f) => f.filePath);
  }
}
