import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import { RuleRepository, type WorkspaceLoadOutcome } from '../repositories/ruleRepository';
import { ProjectStorageService } from '../services/projectStorageService';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  outcome?: WorkspaceLoadOutcome;
  savedCount = 0;
  async load(): Promise<WorkspaceLoadOutcome> {
    if (this.outcome) return this.outcome;
    return this.document
      ? { status: 'loaded', workspace: structuredClone(this.document), repairs: [] }
      : { status: 'empty' };
  }
  async save(document: WorkspaceDocument) { this.savedCount += 1; this.document = structuredClone(document); }
}

class FakeStorage extends ProjectStorageService {
  stored: unknown = null;
  written: WorkspaceDocument[] = [];
  override async read() { return this.stored; }
  override readFallback() { return null; }
  override async write(document: WorkspaceDocument) { this.written.push(structuredClone(document)); }
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

  it('recovers intact entries around a corrupt version record and never overwrites the stored data', async () => {
    const storage = new FakeStorage();
    storage.stored = {
      schemaVersion: 1,
      activeProjectId: 'project-a',
      projects: [
        {
          id: 'project-a', title: '策略 A', updatedAt: 100,
          fields: [{ id: 'amount', name: '金额', type: 'number', min: 0, max: 100 }],
          rules: [{ id: 'rule-a', name: '大额', priority: 1, result: '审核', conditions: { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 50 }] } }],
          sampleInputs: { amount: 80 },
          versions: [
            { id: 'version-broken', name: '缺字段的快照' },
            { id: 'version-ok', name: '完好快照', savedAt: 90, frozen: true, fields: [{ id: 'amount', name: '金额', type: 'number', min: 0, max: 100 }], rules: [], sampleInputs: {} },
          ],
        },
        { id: 'project-b', title: '策略 B', updatedAt: 200, fields: [], rules: [], sampleInputs: {}, versions: [] },
      ],
    };
    const workspace = new RuleWorkspaceViewModel(new RuleRepository(storage), new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(500);
    await workspace.flushSave();

    const state = workspace.getSnapshot();
    expect(state.workspace?.projects.map((project) => project.id)).toEqual(['project-a', 'project-b']);
    expect(state.project?.versions.map((version) => version.id)).toEqual(['version-ok']);
    expect(state.restoreNotices.some((item) => item.includes('无法识别') && item.includes('版本记录'))).toBe(true);
    expect(storage.written).toHaveLength(0);
    workspace.dispose();
  });

  it('reports unreadable local data and blocks all saves instead of seeding the demo project', async () => {
    const storage = new FakeStorage();
    storage.stored = { schemaVersion: 1, projects: 'corrupted-by-hand', activeProjectId: 'project-a' };
    const workspace = new RuleWorkspaceViewModel(new RuleRepository(storage), new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(500);
    await workspace.flushSave();

    const state = workspace.getSnapshot();
    expect(state.phase).toBe('error');
    expect(state.project).toBeNull();
    expect(state.workspace).toBeNull();
    expect(state.notice).toContain('不会被覆盖');
    expect(storage.written).toHaveLength(0);
    workspace.dispose();
  });

  it('does not save when the repository reports unreadable data', async () => {
    const repository = new MemoryRepository();
    repository.outcome = { status: 'unreadable', reason: '存储内容不是可识别的规则工作区' };
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(500);
    await workspace.flushSave();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(repository.savedCount).toBe(0);
    workspace.dispose();
  });

  it('restores a repaired workspace with a skip summary and schedules no save', async () => {
    const repository = new MemoryRepository();
    const document: WorkspaceDocument = {
      schemaVersion: 1,
      activeProjectId: 'project-a',
      projects: [{ id: 'project-a', title: '策略 A', fields: [], rules: [], sampleInputs: {}, versions: [], updatedAt: 1 }],
    };
    repository.outcome = { status: 'loaded', workspace: document, repairs: ['项目「策略 A」：已跳过 2 条无法识别的规则'] };
    const workspace = new RuleWorkspaceViewModel(repository, new FakeChecker());
    await workspace.start();
    await vi.advanceTimersByTimeAsync(500);
    await workspace.flushSave();
    expect(workspace.getSnapshot().restoreNotices).toEqual(['项目「策略 A」：已跳过 2 条无法识别的规则']);
    expect(workspace.getSnapshot().notice).toContain('部分无法识别的内容已跳过');
    expect(workspace.getSnapshot().persistence).toBe('saved');
    expect(repository.savedCount).toBe(0);
    workspace.dispose();
  });
});
