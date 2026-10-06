import type { RuleAnalysis, RuleProject } from '../models/ruleModel';
import RuleCheckWorker from './ruleCheck.worker?worker';

export interface CheckOperation {
  promise: Promise<RuleAnalysis>;
  cancel: () => void;
}

export class RuleCheckService {
  private nextRequestId = 1;

  run(project: RuleProject): CheckOperation {
    const worker = new RuleCheckWorker();
    const requestId = this.nextRequestId++;
    let rejectPending: (reason: Error) => void = () => undefined;
    let settled = false;
    const promise = new Promise<RuleAnalysis>((resolve, reject) => {
      rejectPending = reject;
      worker.onmessage = (event: MessageEvent<{ requestId: number; analysis?: RuleAnalysis; error?: string }>) => {
        if (event.data.requestId !== requestId) return;
        settled = true;
        worker.terminate();
        if (event.data.analysis) resolve(event.data.analysis);
        else reject(new Error(event.data.error ?? '规则分析失败'));
      };
      worker.onerror = (event) => {
        settled = true;
        worker.terminate();
        reject(new Error(event.message || '规则检查 Worker 运行失败'));
      };
      worker.postMessage({ requestId, project });
    });
    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        worker.terminate();
        rejectPending(new DOMException('规则检查已取消', 'AbortError'));
      },
    };
  }
}
