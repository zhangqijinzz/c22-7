import type { RawStorageSnapshot, StorageSourceName, WorkspaceDocument } from '../models/ruleModel';

const DATABASE_NAME = 'ruleweave-db';
const STORE_NAME = 'workspace';
const DOCUMENT_KEY = 'ruleweave.workspace.v1';
const ACTIVE_RECORD_KEY = 'active';
const BACKUP_KEY_PREFIX = 'recovery-backup:';

export type StorageReadState =
  | { source: StorageSourceName; status: 'absent' }
  | { source: StorageSourceName; status: 'readable'; value: unknown }
  | { source: StorageSourceName; status: 'unreadable'; message: string; rawText?: string };

export class ProjectStorageService {
  async readSources(): Promise<StorageReadState[]> {
    return [await this.readIndexedDbSource(), this.readLocalStorageSource()];
  }

  async write(document: WorkspaceDocument, options: { skipSources?: readonly StorageSourceName[] } = {}): Promise<void> {
    const skipSources = new Set(options.skipSources ?? []);
    if (!skipSources.has('indexedDb')) {
      try {
        await this.writeIndexedDb(document);
        if (!skipSources.has('localStorage')) {
          try {
            globalThis.localStorage?.setItem(DOCUMENT_KEY, JSON.stringify(document));
          } catch {
            // IndexedDB has committed, so a local fallback quota error is non-fatal.
          }
        }
        return;
      } catch (indexedDbError) {
        if (skipSources.has('localStorage')) {
          throw new Error(`无法保存规则项目：${indexedDbError instanceof Error ? indexedDbError.message : '浏览器存储不可用'}`);
        }
        try {
          globalThis.localStorage?.setItem(DOCUMENT_KEY, JSON.stringify(document));
          return;
        } catch {
          throw new Error(`无法保存规则项目：${indexedDbError instanceof Error ? indexedDbError.message : '浏览器存储不可用'}`);
        }
      }
    }
    try {
      globalThis.localStorage?.setItem(DOCUMENT_KEY, JSON.stringify(document));
    } catch (localError) {
      throw new Error(`无法保存规则项目：${localError instanceof Error ? localError.message : '浏览器存储不可用'}`);
    }
  }

  async preserveRawSources(snapshots: RawStorageSnapshot[]): Promise<{ target: StorageSourceName; source: StorageSourceName }[]> {
    if (!snapshots.length) return [];
    const createdAt = new Date().toISOString();
    const backupId = `${createdAt}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)}`;
    const attempts = await Promise.allSettled([
      this.preserveRawSourcesInIndexedDb(snapshots, backupId, createdAt),
      this.preserveRawSourcesInLocalStorage(snapshots, backupId, createdAt),
    ]);
    const saved: { target: StorageSourceName; source: StorageSourceName }[] = [];
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled') saved.push(...attempt.value);
    }
    if (!saved.length) throw new Error('无法先备份原始数据，为避免覆盖已停止保存');
    return saved;
  }

  private async preserveRawSourcesInIndexedDb(
    snapshots: RawStorageSnapshot[],
    backupId: string,
    createdAt: string,
  ): Promise<{ target: StorageSourceName; source: StorageSourceName }[]> {
    const database = await this.openDatabase();
    await Promise.all(snapshots.map((snapshot) => new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({
        id: backupId,
        createdAt,
        originalSource: snapshot.source,
        value: snapshot.value,
      }, `${BACKUP_KEY_PREFIX}${snapshot.source}:${backupId}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('备份到 IndexedDB 失败'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 备份已中止'));
    })));
    return snapshots.map((snapshot) => ({ target: 'indexedDb', source: snapshot.source }));
  }

  private preserveRawSourcesInLocalStorage(
    snapshots: RawStorageSnapshot[],
    backupId: string,
    createdAt: string,
  ): { target: StorageSourceName; source: StorageSourceName }[] {
    return snapshots.flatMap((snapshot) => {
      try {
        globalThis.localStorage?.setItem(
          `${DOCUMENT_KEY}.backup.${snapshot.source}.${backupId}`,
          JSON.stringify({ createdAt, originalSource: snapshot.source, value: snapshot.value }),
        );
        return [{ target: 'localStorage' as const, source: snapshot.source }];
      } catch {
        return [];
      }
    });
  }

  private async readIndexedDbSource(): Promise<StorageReadState> {
    try {
      const value = await this.readIndexedDb();
      return value === null || value === undefined
        ? { source: 'indexedDb', status: 'absent' }
        : { source: 'indexedDb', status: 'readable', value };
    } catch (error) {
      return { source: 'indexedDb', status: 'unreadable', message: error instanceof Error ? error.message : 'IndexedDB 无法读取' };
    }
  }

  private readLocalStorageSource(): StorageReadState {
    try {
      const serialized = globalThis.localStorage?.getItem(DOCUMENT_KEY);
      if (serialized === null || serialized === undefined) return { source: 'localStorage', status: 'absent' };
      try {
        return { source: 'localStorage', status: 'readable', value: JSON.parse(serialized) as unknown };
      } catch (error) {
        return { source: 'localStorage', status: 'unreadable', rawText: serialized, message: error instanceof Error ? error.message : '本地缓存无法解析' };
      }
    } catch (error) {
      return { source: 'localStorage', status: 'unreadable', message: error instanceof Error ? error.message : '本地缓存无法读取' };
    }
  }

  private async readIndexedDb(): Promise<unknown | null> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(ACTIVE_RECORD_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error('读取 IndexedDB 失败'));
    });
  }

  private async writeIndexedDb(document: WorkspaceDocument): Promise<void> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(document, ACTIVE_RECORD_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('写入 IndexedDB 失败'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 写入已中止'));
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) return Promise.reject(new Error('当前环境不支持 IndexedDB'));
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'));
    });
  }
}
