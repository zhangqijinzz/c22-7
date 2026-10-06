import type { RuleField } from '../../models/ruleModel';
import type { WorkspaceState } from '../../viewmodels/workspaceViewModel';
import type { SamplesViewModel } from './samplesViewModel';

interface SamplesViewProps { state: WorkspaceState; viewModel: SamplesViewModel }

export function SamplesView({ state, viewModel }: SamplesViewProps) {
  const project = state.project;
  const evaluation = state.sampleEvaluation;
  const fields = project?.fields ?? [];
  const rules = project?.rules ?? [];
  return (
    <section className="module-page">
      <div className="page-heading"><div><span className="eyebrow">模块 03 / 输入推演</span><h1>样例试验区</h1><p>输入一组具体值，观察所有命中规则及最终采用的结果。</p></div><button className="button button-primary" disabled={!fields.length || !rules.length} onClick={() => viewModel.evaluate()}>运行样例 <span>↗</span></button></div>
      {!fields.length && <div className="inline-issue">定义字段后即可输入样例。</div>}
      <div className="sample-layout">
        <section className="sample-input-card card-surface">
          <header className="panel-heading"><div><span className="eyebrow">INPUT VALUES</span><h2>测试输入</h2></div><span className="count-chip">{fields.length} 个字段</span></header>
          <div className="sample-fields">{fields.map((field) => <SampleField key={field.id} field={field} value={project?.sampleInputs[field.id]} onChange={(value) => viewModel.setValue(field.id, value)} />)}</div>
          <div className="sample-tip"><span>i</span><p>样例输入会随项目保存。输入超出字段范围时会指出具体字段。</p></div>
        </section>

        <section className="sample-output-card card-surface">
          <header className="panel-heading"><div><span className="eyebrow">MATCH TRACE</span><h2>命中路径</h2></div><span className={evaluation?.valid ? 'state-pill state-good' : 'state-pill state-neutral'}><i />{evaluation?.valid ? '已求值' : '等待输入'}</span></header>
          {evaluation && !evaluation.valid ? <div className="sample-errors"><strong>输入需要补全</strong>{evaluation.errors.map((error) => <p key={error}>! {error}</p>)}</div> : evaluation?.matchedRules.length ? <>
            <div className="winner-result"><div className="winner-label"><span>最终结果</span><b>优先级 {evaluation.winner?.priority}</b></div><strong>{evaluation.winner?.result || '此规则尚未填写结果'}</strong><span className="winner-rule">由 {evaluation.winner?.name} 命中</span></div>
            <div className="trace-heading"><span>匹配顺序</span><span>{evaluation.matchedRules.length} 条规则命中</span></div>
            <ol className="match-trace">{evaluation.matchedRules.map((rule, index) => <li className={index === 0 ? 'trace-winner' : ''} key={rule.id}><span className="trace-dot">{index === 0 ? '✓' : index + 1}</span><div><strong>{rule.name}</strong><span>{rule.result || '未填写结果'}</span></div><b>P{rule.priority}</b></li>)}</ol>
          </> : <div className="no-match-state"><div>∅</div><strong>没有规则命中</strong><p>这组输入落在当前规则集合未覆盖的区域。</p></div>}
          {evaluation?.valid && evaluation.matchedRules.length > 1 && <div className="trace-note">多条规则同时命中。优先级最高者作为最终结果，同优先级按列表顺序决胜。</div>}
        </section>
      </div>
    </section>
  );
}

interface SampleFieldProps { field: RuleField; value: string | number | boolean | undefined; onChange: (value: string | number | boolean | '') => void }

function SampleField({ field, value, onChange }: SampleFieldProps) {
  return <label className="sample-field"><span>{field.name}<small>{field.type === 'number' ? `${field.min}–${field.max}` : field.type === 'enum' ? '枚举值' : '是 / 否'}</small></span>
    {field.type === 'number' ? <input type="number" min={field.min} max={field.max} value={typeof value === 'number' ? value : ''} onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))} /> : field.type === 'enum' ? <select value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option>{(field.enumValues ?? []).map((item) => <option key={item} value={item}>{item}</option>)}</select> : <select value={typeof value === 'boolean' ? String(value) : ''} onChange={(event) => onChange(event.target.value === '' ? '' : event.target.value === 'true')}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>}
  </label>;
}
