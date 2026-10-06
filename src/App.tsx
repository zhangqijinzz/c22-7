import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ModuleId } from './models/ruleModel';
import { FieldsView } from './features/fields/FieldsView';
import { RulesView } from './features/rules/RulesView';
import { SamplesView } from './features/samples/SamplesView';
import { InspectionView } from './features/inspection/InspectionView';
import { createRuleWeaveViewModels } from './viewmodels/createRuleWeaveViewModels';
import './styles.css';

const navigation: { id: ModuleId; label: string; description: string; icon: string; step: string }[] = [
  { id: 'fields', label: '字段定义', description: '输入与合法范围', icon: '▤', step: '01' },
  { id: 'rules', label: '规则工作台', description: '条件与决策结果', icon: '⌘', step: '02' },
  { id: 'samples', label: '样例试验区', description: '单点命中推演', icon: '◉', step: '03' },
  { id: 'inspection', label: '检查与版本', description: '覆盖、冲突与快照', icon: '⌕', step: '04' },
];

export default function App() {
  const [viewModels] = useState(createRuleWeaveViewModels);
  const { workspace, fields, rules, samples, inspection } = viewModels;
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
  const project = state.project;
  const activeNavigation = navigation.find((item) => item.id === state.activeModule) ?? navigation[0];

  useEffect(() => {
    void workspace.start();
    return () => workspace.dispose();
  }, [workspace]);

  const openRule = (ruleId: string) => {
    workspace.navigate('rules');
    workspace.selectRule(ruleId);
    document.querySelector(`[data-rule-id="${ruleId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark"><span /><span /><span /></div><div><strong>RuleWeave</strong><small>RULE SYSTEM STUDIO</small></div></div>
        <div className="project-switcher"><span className="eyebrow">当前项目</span><select aria-label="切换项目" value={project?.id ?? ''} disabled={!state.workspace} onChange={(event) => workspace.switchProject(event.target.value)}>{state.workspace?.projects.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select><span className="project-status"><i />本地工作区</span></div>
        <div className="sidebar-spacer" />
        <div className="project-health"><div className="health-header"><span>项目状态</span><span className={state.validationIssues.length ? 'health-badge health-warn' : state.checkStatus === 'success' ? 'health-badge health-good' : 'health-badge'}>{state.validationIssues.length ? '待修复' : state.checkStatus === 'success' ? '已检查' : '草稿'}</span></div><div className="health-track"><span style={{ width: `${state.validationIssues.length ? 38 : project?.rules.length ? 84 : 16}%` }} /></div><small>{state.validationIssues.length ? '存在定义问题，无法运行检查' : project?.rules.length ? `${project.rules.length} 条规则 · 可继续编辑` : '先定义字段和规则'}</small></div>
        <button className="new-project-button" onClick={() => workspace.createProject()}><span>＋</span> 新建规则项目</button>
        <footer className="sidebar-footer"><span className="avatar-dot">R</span><span><strong>本地规则空间</strong><small>所有数据保存在此浏览器</small></span><span className="local-lock">⌑</span></footer>
      </aside>

      <main className="main-area">
        <header className="topbar"><div className="breadcrumb"><span>规则项目</span><b>/</b><strong>{activeNavigation.label}</strong></div><div className="topbar-right"><span className="save-indicator"><i className={state.persistence === 'saving' ? 'save-dot is-saving' : state.persistence === 'error' ? 'save-dot save-error' : 'save-dot'} />{state.persistence === 'saving' ? '保存中' : state.persistence === 'error' ? '保存失败' : '已保存'}</span><span className="topbar-divider" /><button className="avatar-button" aria-label="用户菜单">RW</button></div></header>
        {project && <div className="content-wrap">
          <div className="project-title-bar"><div className="project-title-copy"><span className="project-kicker">RULE PROJECT / LOCAL</span><input aria-label="项目名称" value={project.title} onChange={(event) => workspace.renameProject(event.target.value)} /><span className="project-subtitle">规则逻辑空间 <span>·</span> 最后修改 {new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(project.updatedAt)}</span></div><div className="title-bar-actions"><span className={`phase-badge phase-${state.phase}`}>{state.phase === 'checking' ? '检查中' : state.phase === 'validating' ? '需要修复' : state.phase === 'error' ? '发生错误' : project.frozenVersionId ? '已冻结' : state.phase === 'ready' ? '检查通过' : '编辑中'}</span><button className="title-more-button" aria-label="创建项目" title="新建项目" onClick={() => workspace.createProject()}>＋</button></div></div>
          {state.notice && <div className={`status-message${state.phase === 'error' ? ' status-message-error' : ''}`} role="status"><span>{state.phase === 'error' ? '!' : '↳'}</span>{state.notice}{state.saveError && <small>{state.saveError}</small>}</div>}
          <div className="module-tabs" role="tablist" aria-label="规则项目功能模块">
            {navigation.map((item, index) => <button id={`module-tab-${item.id}`} key={item.id} role="tab" aria-selected={state.activeModule === item.id} aria-controls="module-panel" tabIndex={state.activeModule === item.id ? 0 : -1} className={`module-tab${state.activeModule === item.id ? ' module-tab-active' : ''}`} onClick={() => workspace.navigate(item.id)} onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const direction = event.key === 'ArrowRight' ? 1 : -1;
              const nextIndex = (index + direction + navigation.length) % navigation.length;
              workspace.navigate(navigation[nextIndex].id);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
            }}><span className="module-tab-icon">{item.icon}</span><span>{item.label}</span><small>{item.step}</small></button>)}
          </div>
          <div id="module-panel" className="module-tab-panel" role="tabpanel" aria-labelledby={`module-tab-${state.activeModule}`}>
            {state.activeModule === 'fields' && <FieldsView state={state} viewModel={fields} />}
            {state.activeModule === 'rules' && <RulesView state={state} viewModel={rules} />}
            {state.activeModule === 'samples' && <SamplesView state={state} viewModel={samples} />}
            {state.activeModule === 'inspection' && <InspectionView state={state} viewModel={inspection} onOpenRule={openRule} />}
          </div>
        </div>}
        {!project && <div className="startup-state"><div className="spinner" /><strong>正在加载 RuleWeave</strong><span>读取本地项目与版本快照</span></div>}
      </main>
    </div>
  );
}
