import type { RuleProject } from '../models/ruleModel';
import { analyzeRules } from '../domain/ruleAnalysis';

interface CheckRequest {
  requestId: number;
  project: RuleProject;
}

self.onmessage = (event: MessageEvent<CheckRequest>) => {
  try {
    const analysis = analyzeRules(event.data.project);
    self.postMessage({ requestId: event.data.requestId, analysis });
  } catch (error) {
    self.postMessage({
      requestId: event.data.requestId,
      error: error instanceof Error ? error.message : '规则分析失败',
    });
  }
};
