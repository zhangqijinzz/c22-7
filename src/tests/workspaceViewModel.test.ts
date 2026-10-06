import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument, WorkspaceLoadResult } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async prepareRecoveredSourcesForSave() { return undefined; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class RecoveredRepository {
  document: WorkspaceDocument | null = null;
  backupPrepared = false;

  constructor(private readonly recovered: WorkspaceLoadResult) {}

  async load() { return structuredClone(this.recovered); }
  async prepareRecoveredSourcesForSave() { this.backupPrepared = true; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class FakeChecker {
  calls = 0;
  nextError: Error | null = null;
  cancelled = false;

  run(project: RuleProject): CheckOperation {
    this.calls += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; } };
    }
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => { this.cancelled = true; } };
  }
}

describe('RuleWorkspaceViewModel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('initializes a usable demo, runs checks, persists edits, and recovers the workspace', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    expect(workspace.getSnapshot().project?.rules).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '已修改策略' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已修改策略');

    const restored = new RuleWorkspaceViewModel(repository, checker);
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('已修改策略');
    restored.dispose();
    workspace.dispose();
  });

  it('locks writes until damaged raw data has been explicitly backed up', async () => {
    const project: RuleProject = {
      id: 'damaged-save-source', title: '用户项目',
      fields: [{ id: 'amount', name: '金额', type: 'number', min: 0, max: 100 }],
      rules: [{
        id: 'amount-rule', name: '大额', priority: 10, result: '通过',
        conditions: { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gt', value: 50 }] },
      }],
      sampleInputs: { amount: 60 }, versions: [], updatedAt: 1000,
    };
    const document: WorkspaceDocument = { schemaVersion: 1, projects: [project], activeProjectId: project.id };
    const repository = new RecoveredRepository({
      fatal: false,
      document,
      legacy: true,
      issues: [{ scope: 'version', severity: 'warning', message: '版本记录缺少 frozen 字段' }],
      rawSources: [{ source: 'indexedDb', value: { schemaVersion: undefined } }],
      skipWriteSources: [],
    });
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    expect(workspace.getSnapshot().recoveryLocked).toBe(true);
    expect(workspace.getSnapshot().project?.title).toBe('用户项目');

    workspace.renameProject('不应保存的名称');
    await vi.advanceTimersByTimeAsync(300);
    expect(workspace.getSnapshot().project?.title).toBe('用户项目');
    expect(repository.backupPrepared).toBe(false);
    expect(repository.document).toBeNull();

    await workspace.prepareRecoveryForSave();
    expect(repository.backupPrepared).toBe(true);
    workspace.renameProject('已备份后的名称');
    await vi.advanceTimersByTimeAsync(300);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已备份后的名称');
    workspace.dispose();
  });

  it('shows check errors and recovers on the next successful run', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    checker.nextError = new Error('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toBe('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('marks cancellation and blocks checks for invalid projects', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    const callsBefore = checker.calls;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('error');
    expect(checker.calls).toBe(callsBefore);
    workspace.dispose();
  });

  it('saves versions, freezes and resumes a version, and copies it into a new project', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);

    workspace.freezeCurrent();
    const frozen = workspace.getSnapshot().project;
    expect(frozen?.frozenVersionId).toBe(frozen?.versions[0].id);
    expect(workspace.commitProject({ ...(frozen as RuleProject), title: '不允许修改' })).toBe(false);

    workspace.restoreVersion(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().project?.frozenVersionId).toBeUndefined();
    workspace.copyVersionToProject(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });
});
