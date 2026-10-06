import type { WorkspaceDocument } from '../models/ruleModel';

const DATABASE_NAME = 'ruleweave-db';
const STORE_NAME = 'workspace';
const DOCUMENT_KEY = 'ruleweave.workspace.v1';

export class ProjectStorageService {
  async read(): Promise<unknown | null> {
    try {
      const stored = await this.readIndexedDb();
      if (stored !== null && stored !== undefined) return stored;
    } catch {
      // The local fallback keeps the workspace usable when browser storage is restricted.
    }
    try {
      const serialized = globalThis.localStorage?.getItem(DOCUMENT_KEY);
      return serialized ? JSON.parse(serialized) as unknown : null;
    } catch {
      return null;
    }
  }

  readFallback(): unknown | null {
    try {
      const serialized = globalThis.localStorage?.getItem(DOCUMENT_KEY);
      return serialized ? JSON.parse(serialized) as unknown : null;
    } catch {
      return null;
    }
  }

  async write(document: WorkspaceDocument): Promise<void> {
    try {
      await this.writeIndexedDb(document);
      try {
        globalThis.localStorage?.setItem(DOCUMENT_KEY, JSON.stringify(document));
      } catch {
        // IndexedDB has committed, so a local fallback quota error is non-fatal.
      }
      return;
    } catch (indexedDbError) {
      try {
        globalThis.localStorage?.setItem(DOCUMENT_KEY, JSON.stringify(document));
        return;
      } catch {
        throw new Error(`无法保存规则项目：${indexedDbError instanceof Error ? indexedDbError.message : '浏览器存储不可用'}`);
      }
    }
  }

  private async readIndexedDb(): Promise<unknown | null> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get('active');
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error('读取 IndexedDB 失败'));
    });
  }

  private async writeIndexedDb(document: WorkspaceDocument): Promise<void> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(document, 'active');
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
