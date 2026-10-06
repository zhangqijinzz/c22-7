import { describe, expect, it } from 'vitest';
import type { WorkspaceDocument } from '../models/ruleModel';
import { RuleRepository } from '../repositories/ruleRepository';
import { ProjectStorageService } from '../services/projectStorageService';

class FakeStorage extends ProjectStorageService {
  primary: unknown = null;
  fallback: unknown = null;
  written: WorkspaceDocument[] = [];
  override async read() { return this.primary; }
  override readFallback() { return this.fallback; }
  override async write(document: WorkspaceDocument) { this.written.push(structuredClone(document)); }
}

const field = { id: 'amount', name: '金额', type: 'number', min: 0, max: 100 };
const rule = { id: 'rule-a', name: '大额', priority: 1, result: '审核', conditions: { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 50 }] } };
const version = { id: 'version-a', name: '快照', savedAt: 10, frozen: false, fields: [field], rules: [rule], sampleInputs: { amount: 1 } };

function projectShape(overrides: Record<string, unknown> = {}) {
  return { id: 'project-a', title: '策略 A', fields: [field], rules: [rule], sampleInputs: { amount: 1 }, versions: [version], updatedAt: 100, ...overrides };
}

function workspaceShape(projects: unknown[], activeProjectId = 'project-a') {
  return { schemaVersion: 1, projects, activeProjectId };
}

describe('RuleRepository', () => {
  it('reports empty when nothing is stored', async () => {
    const outcome = await new RuleRepository(new FakeStorage()).load();
    expect(outcome.status).toBe('empty');
  });

  it('loads a fully valid document without repairs', async () => {
    const storage = new FakeStorage();
    storage.primary = workspaceShape([projectShape()]);
    const outcome = await new RuleRepository(storage).load();
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') return;
    expect(outcome.repairs).toEqual([]);
    expect(outcome.workspace.projects[0].rules).toHaveLength(1);
    expect(outcome.workspace.projects[0].versions).toHaveLength(1);
  });

  it('skips only the corrupt version record and keeps the rest of the project', async () => {
    const storage = new FakeStorage();
    storage.primary = workspaceShape([projectShape({ versions: [{ id: 'broken', name: '缺字段' }, version] })]);
    const outcome = await new RuleRepository(storage).load();
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') return;
    expect(outcome.workspace.projects[0].versions.map((item) => item.id)).toEqual(['version-a']);
    expect(outcome.workspace.projects[0].rules).toHaveLength(1);
    expect(outcome.repairs.some((repair) => repair.includes('版本记录'))).toBe(true);
  });

  it('skips corrupt fields and rules individually instead of dropping the project', async () => {
    const storage = new FakeStorage();
    storage.primary = workspaceShape([projectShape({ fields: [field, { id: 'bad' }], rules: [rule, { id: 'bad', priority: 'high' }] })]);
    const outcome = await new RuleRepository(storage).load();
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') return;
    expect(outcome.workspace.projects[0].fields).toHaveLength(1);
    expect(outcome.workspace.projects[0].rules).toHaveLength(1);
    expect(outcome.repairs.some((repair) => repair.includes('1 个无法识别的字段'))).toBe(true);
    expect(outcome.repairs.some((repair) => repair.includes('1 条无法识别的规则'))).toBe(true);
  });

  it('keeps sibling projects when one project is unrecognizable and falls back from a dead active project', async () => {
    const storage = new FakeStorage();
    storage.primary = workspaceShape([{ nope: true }, projectShape({ id: 'project-b', title: '策略 B' })], 'project-gone');
    const outcome = await new RuleRepository(storage).load();
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') return;
    expect(outcome.workspace.projects.map((project) => project.id)).toEqual(['project-b']);
    expect(outcome.workspace.activeProjectId).toBe('project-b');
    expect(outcome.repairs.some((repair) => repair.includes('无法识别的项目'))).toBe(true);
    expect(outcome.repairs.some((repair) => repair.includes('原活动项目已不可用'))).toBe(true);
  });

  it('clears a freeze pointer whose version record was dropped', async () => {
    const storage = new FakeStorage();
    storage.primary = workspaceShape([projectShape({ versions: [{ id: 'broken' }], frozenVersionId: 'broken' })]);
    const outcome = await new RuleRepository(storage).load();
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') return;
    expect(outcome.workspace.projects[0].frozenVersionId).toBeUndefined();
    expect(outcome.repairs.some((repair) => repair.includes('解除冻结'))).toBe(true);
  });

  it('reports unreadable when stored content cannot be recognized at all', async () => {
    const storage = new FakeStorage();
    storage.primary = workspaceShape('not-an-array' as unknown as unknown[], 'project-a');
    const outcome = await new RuleRepository(storage).load();
    expect(outcome.status).toBe('unreadable');
    expect(storage.written).toHaveLength(0);
  });

  it('reports unreadable when every project record is broken', async () => {
    const storage = new FakeStorage();
    storage.primary = workspaceShape([{ nope: true }]);
    const outcome = await new RuleRepository(storage).load();
    expect(outcome.status).toBe('unreadable');
  });

  it('recovers from the local fallback copy when the primary store is corrupt', async () => {
    const storage = new FakeStorage();
    storage.primary = { schemaVersion: 1, projects: 'corrupted-by-hand' };
    storage.fallback = workspaceShape([projectShape()]);
    const outcome = await new RuleRepository(storage).load();
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') return;
    expect(outcome.workspace.projects[0].id).toBe('project-a');
  });
});
