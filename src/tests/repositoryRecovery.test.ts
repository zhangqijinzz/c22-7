import { describe, expect, it } from 'vitest';
import type { RawStorageSnapshot, RuleProject, RuleVersion, WorkspaceDocument } from '../models/ruleModel';
import { RuleRepository } from '../repositories/ruleRepository';
import type { StorageReadState } from '../services/projectStorageService';

class RecoveryStorage {
  sources: StorageReadState[];
  documents: WorkspaceDocument[] = [];
  backups: RawStorageSnapshot[][] = [];
  writeOptions: { skipSources?: readonly string[] }[] = [];

  constructor(sources: StorageReadState[]) {
    this.sources = sources;
  }

  async readSources() { return this.sources; }
  async preserveRawSources(snapshots: RawStorageSnapshot[]) {
    this.backups.push(structuredClone(snapshots));
    return snapshots.map((snapshot) => ({ target: 'localStorage' as const, source: snapshot.source }));
  }
  async write(document: WorkspaceDocument, options: { skipSources?: readonly string[] } = {}) {
    this.writeOptions.push(options);
    this.documents.push(structuredClone(document));
  }
}

function project(id: string, overrides: Partial<RuleProject> = {}): RuleProject {
  return {
    id,
    title: `项目 ${id}`,
    fields: [{ id: `${id}-field`, name: '金额', type: 'number', min: 0, max: 100 }],
    rules: [{
      id: `${id}-rule`, name: '大额', priority: 10, result: '通过',
      conditions: { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: `${id}-field`, operator: 'gt', value: 50 }] },
    }],
    sampleInputs: { [`${id}-field`]: 60 },
    versions: [],
    updatedAt: 1000,
    ...overrides,
  };
}

function workspace(projects: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 1, projects, activeProjectId: 'good', ...extra };
}

describe('RuleRepository recovery', () => {
  it('recovers valid projects and only skips the locally damaged project', async () => {
    const storage = new RecoveryStorage([{
      source: 'indexedDb',
      status: 'readable',
      value: workspace([project('good'), null, 'invalid']),
    }]);
    const repository = new RuleRepository(storage);
    const loaded = await repository.load();

    expect(loaded?.fatal).toBe(false);
    if (!loaded || loaded.fatal) throw new Error('expected recovered workspace');
    expect(loaded.document.projects.map((item) => item.id)).toEqual(['good']);
    expect(loaded.issues.some((issue) => issue.scope === 'project' && issue.message.includes('只跳过'))).toBe(true);
  });

  it('keeps a project when one version is damaged and migrates a partial version record', async () => {
    const validVersion = project('version-source').versions;
    const partialVersion: Record<string, unknown> = {
      id: 'partial-version', name: '旧版本', savedAt: 123,
      fields: [{ id: 'f1', name: '金额', type: 'number' }],
      rules: [{
        id: 'r1', name: '规则',
        conditions: { kind: 'group', operator: '&&', conditions: [{ kind: 'predicate', fieldId: 'f1', operator: 'greater_than', value: 10 }] },
      }],
      sampleInputs: { f1: 11 },
    };
    const storage = new RecoveryStorage([{
      source: 'indexedDb',
      status: 'readable',
      value: workspace([project('good', { versions: [partialVersion as unknown as RuleVersion, ...validVersion] })]),
    }]);
    const loaded = await new RuleRepository(storage).load();

    expect(loaded?.fatal).toBe(false);
    if (!loaded || loaded.fatal) throw new Error('expected recovered workspace');
    const recoveredProject = loaded.document.projects[0];
    expect(recoveredProject.rules).toHaveLength(1);
    expect(recoveredProject.versions.map((version) => version.id)).toEqual(['partial-version']);
    expect(recoveredProject.versions[0].frozen).toBe(false);
    expect(recoveredProject.versions[0].rules[0].conditions.conditions[0]).toMatchObject({ operator: 'gt' });
    expect(loaded.issues.some((issue) => issue.scope === 'version' && issue.message.includes('frozen'))).toBe(true);
  });

  it('does not overwrite an unreadable storage source when saving recovered data', async () => {
    const storage = new RecoveryStorage([
      { source: 'indexedDb', status: 'readable', value: workspace([project('good')]) },
      { source: 'localStorage', status: 'unreadable', rawText: '{broken', message: 'Unexpected token' },
    ]);
    const repository = new RuleRepository(storage);
    const loaded = await repository.load();
    if (!loaded || loaded.fatal) throw new Error('expected recovered workspace');

    expect(loaded.skipWriteSources).toEqual(['localStorage']);
    await repository.save(loaded.document);
    expect(storage.backups[0].map((snapshot) => snapshot.source)).toEqual(['indexedDb', 'localStorage']);
    expect(storage.writeOptions[0].skipSources).toEqual(['localStorage']);
  });

  it('accepts legacy data and backs up raw sources before the first normalized save', async () => {
    const raw = workspace([project('good')], { schemaVersion: undefined });
    const storage = new RecoveryStorage([{ source: 'indexedDb', status: 'readable', value: raw }]);
    const repository = new RuleRepository(storage);
    const loaded = await repository.load();
    if (!loaded || loaded.fatal) throw new Error('expected legacy recovery');

    expect(loaded.legacy).toBe(true);
    await repository.save(loaded.document);
    expect(storage.backups).toHaveLength(1);
    expect(storage.backups[0][0].value).toEqual(raw);
    expect(storage.documents).toHaveLength(1);
  });

  it('returns a fatal result for completely unreadable storage and never supplies a demo workspace', async () => {
    const storage = new RecoveryStorage([{
      source: 'localStorage', status: 'unreadable', rawText: '{broken', message: 'Unexpected token',
    }]);
    const loaded = await new RuleRepository(storage).load();

    expect(loaded?.fatal).toBe(true);
    if (!loaded || !loaded.fatal) throw new Error('expected fatal recovery');
    expect(loaded.message).toContain('Unexpected token');
    expect(storage.documents).toHaveLength(0);
  });
});
