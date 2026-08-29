const featureContent = {
  voice: `
    <h2>语音问诊</h2><div class="task-meta"><span>录音已结束 · 08:32</span><span>转写待确认 2</span></div>
    <div class="task-card"><header><h3>结构化问诊</h3><span class="status-pill">可生成</span></header>
      <p>已提取 14 项临床事实；“夜间低血糖次数”和“近期体重变化”需要确认。</p>
      <div class="task-actions"><button class="primary">查看转写</button><button>继续录音</button><button class="link evidence-link">查看来源</button></div>
    </div>
    <div class="task-card"><header><h3>必须澄清</h3><span class="status-pill warning">2 项</span></header><ul><li>最近一周是否出现出汗、心悸或意识模糊？</li><li>是否正在使用胰岛素，具体剂量与时间？</li></ul></div>`,
  summary: `
    <h2>病情概况</h2><div class="task-meta"><span>刚刚更新 · 数据截至 10:26</span><span>概况 Agent v0.3</span></div>
    <div class="summary-hero">42 岁女性，2 周口渴、多饮、夜尿增多，近 1 周空腹血糖偏高。既往有妊娠期糖尿病史；夜间疑似低血糖尚待澄清。</div>
    <div class="metric-row"><div><b>4</b><small>关键事实</small></div><div><b>2</b><small>需澄清</small></div><div><b>1</b><small>数据变化</small></div></div>
    <div class="task-card"><header><h3>关键变化</h3><span class="status-pill">已更新</span></header><p>今日 HbA1c 7.6%，较 3 个月前 6.8% 上升；空腹血糖 8.9 mmol/L。</p><div class="task-actions"><button class="primary">加入病历</button><button>编辑概况</button><button class="link evidence-link">查看 4 条证据</button></div></div>
    <div class="task-card"><header><h3>信息缺口</h3><span class="status-pill warning">需确认</span></header><ul><li>当前降糖方案与实际用量</li><li>低血糖症状、发生时间与自测值</li></ul></div>`,
  record: `
    <h2>病历生成</h2><div class="task-meta"><span>生成于 10:26:42</span><span>模板 endocrine-v1</span></div>
    <div class="task-card"><header><h3>段落状态</h3><span class="status-pill">5 / 7 已生成</span></header><p>主诉、现病史、体格检查和辅助检查已生成；既往史与处理意见需要补充。</p><div class="task-actions"><button class="primary">定位待确认段落</button><button>重新生成未编辑段</button></div></div>
    <div class="task-card"><header><h3>提交前检查</h3><span class="status-pill critical">被阻断</span></header><ul><li>红色风险“夜间低血糖”未处置</li><li>用药史必填项未完成</li></ul></div>`,
  differential: `
    <h2>鉴别诊断</h2><div class="task-meta"><span>数据截至 10:26</span><span>上下文有效</span></div>
    <div class="task-card"><header><h3>不能漏诊 · 糖尿病急性并发症</h3><span class="status-pill critical">需核实</span></header><p>当前无酮体与血气结果；如出现恶心、腹痛或呼吸深快需立即评估。</p><div class="task-actions"><button class="primary">加入待排</button><button>暂不考虑</button><button class="link evidence-link">依据与缺口</button></div></div>
    <div class="task-card"><header><h3>较可能 · 2 型糖尿病</h3><span class="status-pill">较可能</span></header><p>典型症状，空腹血糖和 HbA1c 均升高，既往妊娠期糖尿病史。</p><div class="task-actions"><button class="primary">设为初步诊断</button><button>反馈问题</button><button class="link evidence-link">查看证据</button></div></div>
    <div class="task-card"><header><h3>其他可能 · 甲状腺功能亢进症</h3><span class="status-pill warning">信息不足</span></header><p>口渴与体重变化可能相关，但心悸、手颤与甲功信息尚缺。</p></div>`,
  diagnosis: `
    <h2>诊断管理</h2><div class="task-meta"><span>诊断集 v3</span><span>未模拟写回</span></div>
    <div class="task-card"><header><h3>主要诊断</h3><span class="status-pill">医生已确认</span></header><p><strong>2 型糖尿病（初步）</strong><br><span class="source">E11.900 · 来源：医生从鉴别诊断采纳</span></p><div class="task-actions"><button>编辑编码</button><button>查看变更</button></div></div>
    <div class="task-card"><header><h3>待排诊断</h3><span class="status-pill warning">1 项</span></header><p>甲状腺功能亢进症 · 待补充甲状腺功能检查</p><div class="task-actions"><button class="primary">补充依据</button><button>排除并留因</button></div></div>`,
  risk: `
    <h2>风险管理</h2><div class="task-meta"><span>规则引擎正常 · Agent 正常</span><span>3 项待处理</span></div>
    <div class="task-card"><header><h3>夜间低血糖待处置</h3><span class="status-pill critical">红色 · 新发现</span></header><p>语音转写提及夜间出汗、心悸；当前胰岛素剂量和自测血糖未确认。</p><div class="task-actions"><button class="primary risk-open">记录处置</button><button>确认已阅</button><button class="link evidence-link">查看依据</button></div></div>
    <div class="task-card"><header><h3>青霉素过敏</h3><span class="status-pill warning">黄色 · 已阅</span></header><p>既往过敏记录；如进入药物建议需执行过敏冲突校验。</p></div>
    <div class="task-card"><header><h3>肾功能数据超过 90 天</h3><span class="status-pill warning">黄色 · 待处理</span></header><p>可能影响降糖药物选择，建议确认是否需要复查。</p></div>`,
  comorbidity: `
    <h2>共病管理</h2><div class="task-meta"><span>生成于 10:26:55</span><span>1 项需关注</span></div>
    <div class="task-card"><header><h3>超重 / 肥胖相关风险</h3><span class="status-pill warning">与本次相关</span></header><p>BMI 27.4 kg/m²，可能影响代谢控制。近 3 个月体重趋势缺失。</p><div class="task-actions"><button class="primary">加入问诊问题</button><button>复制到处理意见</button><button class="link evidence-link">查看依据</button></div></div>
    <div class="task-card"><header><h3>既往妊娠期糖尿病</h3><span class="status-pill">已确认</span></header><p>与当前糖代谢异常相关；来源为 2018 年产科出院记录。</p></div>`
};

const agentContent = document.querySelector('#agentContent');
const featureButtons = [...document.querySelectorAll('[data-feature]')];

function selectFeature(name) {
  featureButtons.forEach(button => button.classList.toggle('active', button.dataset.feature === name));
  agentContent.innerHTML = featureContent[name] || featureContent.summary;
  agentContent.scrollTop = 0;
  bindContentActions();
}

function openDrawer(kind = 'evidence') {
  const drawer = document.querySelector('#evidenceDrawer');
  const backdrop = document.querySelector('#drawerBackdrop');
  const title = document.querySelector('#drawerTitle');
  const content = document.querySelector('#drawerContent');
  const isRisk = kind === 'risk';
  title.textContent = isRisk ? '红色风险 · 处置闭环' : '证据与来源';
  content.innerHTML = isRisk ? `
    <div class="drawer-section"><h3>夜间低血糖待处置</h3><p><strong>等级：</strong>红色 / critical</p><p><strong>处理时限：</strong>本次提交前</p><p><strong>当前状态：</strong>新发现，尚未确认已阅</p></div>
    <div class="drawer-section"><h3>依据</h3><div class="source-row"><span>语音转写</span><div>“有时半夜会出汗、心慌”<br><small>10:21:36 · 置信度 0.91</small></div></div><div class="source-row"><span>用药信息</span><div>胰岛素种类与剂量尚未确认</div></div></div>
    <div class="drawer-section"><h3>处置记录</h3><p>记录操作不自动生成医嘱；医生确认后更新风险状态。</p><textarea rows="4" style="width:100%;resize:vertical" placeholder="填写已核实信息和处置结果"></textarea><div class="risk-action-grid"><button>确认已阅</button><button>标记处置中</button><button>标记已解决</button><button>误报 / 有因忽略</button></div></div>` : `
    <div class="drawer-section"><h3>临床结论</h3><p>今日 HbA1c 7.6%，较 3 个月前上升 0.8 个百分点。</p></div>
    <div class="drawer-section"><h3>来源明细</h3><div class="source-row"><span>来源系统</span><div>LIS · 糖化血红蛋白</div></div><div class="source-row"><span>报告时间</span><div>2026-08-28 09:56:21</div></div><div class="source-row"><span>结果</span><div>7.6% ↑ · 参考范围 4.0–6.0%</div></div><div class="source-row"><span>历史对比</span><div>2026-05-21 · 6.8%</div></div><div class="source-row"><span>引用 ID</span><div>lab-result/mock-20260828-017-hba1c</div></div></div>
    <div class="drawer-section"><h3>使用说明</h3><p>该数据为模拟数据。Agent 仅生成建议；最终解释与处置由医生确认。</p></div>`;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  backdrop.hidden = false;
}

function closeDrawer() {
  const drawer = document.querySelector('#evidenceDrawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  document.querySelector('#drawerBackdrop').hidden = true;
}

function bindContentActions() {
  document.querySelectorAll('.evidence-link').forEach(button => button.addEventListener('click', () => openDrawer('evidence')));
  document.querySelectorAll('.risk-open').forEach(button => button.addEventListener('click', () => openDrawer('risk')));
}

featureButtons.forEach(button => button.addEventListener('click', () => selectFeature(button.dataset.feature)));
document.querySelector('#railToggle').addEventListener('click', event => {
  const rail = document.querySelector('.patient-rail');
  rail.classList.toggle('collapsed');
  const expanded = !rail.classList.contains('collapsed');
  event.currentTarget.textContent = expanded ? '‹' : '›';
  event.currentTarget.setAttribute('aria-expanded', String(expanded));
});
document.querySelector('#agentCollapse').addEventListener('click', event => {
  const workspace = document.querySelector('.agent-workspace');
  workspace.classList.toggle('collapsed');
  const expanded = !workspace.classList.contains('collapsed');
  event.currentTarget.textContent = expanded ? '›' : '‹';
});
document.querySelector('#riskStrip').addEventListener('click', () => { selectFeature('risk'); openDrawer('risk'); });
document.querySelector('#footerRisk').addEventListener('click', () => { selectFeature('risk'); openDrawer('risk'); });
document.querySelector('.evidence-trigger').addEventListener('click', () => openDrawer('evidence'));
document.querySelector('#drawerClose').addEventListener('click', closeDrawer);
document.querySelector('#drawerBackdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDrawer();
  if ((event.ctrlKey || event.metaKey) && event.key === '/') document.querySelector('#agentCollapse').click();
});

const previewParams = new URLSearchParams(window.location.search);
if (previewParams.get('compact') === '1') document.body.classList.add('compact-capture');
selectFeature(previewParams.get('feature') || 'summary');
if (previewParams.get('state') === 'risk') openDrawer('risk');
