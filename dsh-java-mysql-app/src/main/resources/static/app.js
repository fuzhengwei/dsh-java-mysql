const state = {
  connectionId: null,
  connections: [],
  tables: [],
  selectedTable: '',
  conversations: [],
  activeConversationId: null
};
const $ = selector => document.querySelector(selector);

function toast(message, error = false) {
  const item = document.createElement('div');
  item.textContent = message;
  if (error) item.classList.add('error');
  $('#toast').appendChild(item);
  setTimeout(() => item.remove(), 4000);
}

function setStreamStatus(text, visible = true) {
  $('#streamStatus').classList.toggle('hidden', !visible);
  $('#streamStatusText').innerHTML = `<span class="status-spinner"></span>${escapeHtml(text)}`;
}

function setBusy(busy) {
  $('#sendMessage').disabled = busy;
  $('#chatInput').disabled = busy;
  if (!busy) setStreamStatus('', false);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  if (!response.ok) throw new Error(body?.message || body?.error || `请求失败 (${response.status})`);
  return body;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function formatValue(value) {
  if (value == null) return '<span class="muted">NULL</span>';
  if (typeof value === 'object') return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
  return escapeHtml(String(value));
}

function tableHtml(columns, rows) {
  if (!columns?.length) return '<span class="muted">无结果</span>';
  const head = `<thead><tr>${columns.map(value => `<th>${escapeHtml(value)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows.map(row => `<tr>${columns.map(name => `<td>${formatValue(row[name])}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}

function renderConnections() {
  const select = $('#connectionSelect');
  select.innerHTML = '<option value="">未选择连接</option>';
  state.connections.forEach(connection => {
    const option = document.createElement('option');
    option.value = connection.id;
    option.textContent = `${connection.name} · ${connection.host}:${connection.port}`;
    if (connection.id === state.connectionId) option.selected = true;
    select.appendChild(option);
  });
}

function loadConversations() {
  try {
    state.conversations = JSON.parse(localStorage.getItem('dsh.mysql.conversations') || '[]');
  } catch {
    state.conversations = [];
  }
  state.activeConversationId = localStorage.getItem('dsh.mysql.activeConversation') || state.conversations[0]?.id || null;
  renderConversations();
  renderChatMessages();
}

function saveConversations() {
  localStorage.setItem('dsh.mysql.conversations', JSON.stringify(state.conversations));
  localStorage.setItem('dsh.mysql.activeConversation', state.activeConversationId || '');
}

function renderConversations() {
  const container = $('#conversationList');
  container.innerHTML = '';
  state.conversations.forEach(conversation => {
    const button = document.createElement('button');
    button.className = 'item' + (conversation.id === state.activeConversationId ? ' active' : '');
    button.innerHTML = `<b class="title">${escapeHtml(conversation.title)}</b><span class="meta">${conversation.messages.length} 条消息</span>`;
    button.onclick = () => selectConversation(conversation.id);
    container.appendChild(button);
  });
}

function selectConversation(id) {
  state.activeConversationId = id;
  saveConversations();
  renderConversations();
  renderChatMessages();
}

function newConversation() {
  const conversation = { id: crypto.randomUUID(), title: '新对话', messages: [] };
  state.conversations.unshift(conversation);
  saveConversations();
  selectConversation(conversation.id);
  return conversation;
}

function renderChatMessages() {
  const container = $('#chatMessages');
  container.innerHTML = '';
  const conversation = state.conversations.find(item => item.id === state.activeConversationId);
  if (!conversation?.messages.length) {
    container.innerHTML = `<div class="chat-hero">
      <h2>有什么可以帮你？</h2>
      <p>用自然语言查询、分析你的 MySQL 数据库 · 全程只读，安全无忧</p>
      <div class="hero-chips">
        <button class="chip">列出所有表和行数</button>
        <button class="chip">当前有哪些慢查询隐患？</button>
        <button class="chip">分析数据库性能状态</button>
        <button class="chip">帮我审计这条 SQL：SELECT * FROM user</button>
      </div>
    </div>`;
    container.querySelectorAll('.chip').forEach(chip => {
      chip.onclick = () => { $('#chatInput').value = chip.textContent; $('#chatInput').focus(); };
    });
    return;
  }
  conversation.messages.forEach(message => container.appendChild(messageNode(message)));
  container.scrollTop = container.scrollHeight;
}

function renderStreamingMessage(pending) {
  const container = $('#chatMessages');
  let node = container.querySelector(`[data-message-id="${pending.id}"]`);
  if (!node) {
    node = messageNode(pending);
    node.dataset.messageId = pending.id;
    container.appendChild(node);
  }
  const text = node.querySelector('.markdown');
  if (text) text.innerHTML = markdownToHtml(pending.content || '');
  node.querySelector('.steps-wrap')?.remove();
  // 思考/工具步骤始终渲染在正文之前，符合「过程在前、结论在后」的阅读顺序
  node.insertBefore(stepsNode(pending), text);
  container.scrollTop = container.scrollHeight;
}

function messageNode(message) {
  if (message.role === 'operation') return operationNode(message);
  const node = document.createElement('div');
  node.className = `message ${message.role}`;
  if (message.role === 'user') {
    node.textContent = message.content;
    return node;
  }
  // 先渲染思考过程与工具步骤，再渲染最终回答
  const text = document.createElement('div');
  text.className = 'markdown';
  text.innerHTML = markdownToHtml(message.content);
  node.appendChild(stepsNode(message));
  node.appendChild(text);
  if (!message.streaming) {
    extractSql(message.content).forEach(sql => node.appendChild(sqlActions(sql)));
  }
  return node;
}

function operationNode(message) {
  const node = document.createElement('div');
  node.className = 'message operation';
  const title = document.createElement('div');
  title.className = 'operation-title';
  title.innerHTML = `<span>${escapeHtml(message.title || '操作结果')}</span><span class="badge ${message.status || 'success'}">${message.status === 'error' ? '失败' : '成功'}</span>`;
  node.appendChild(title);
  if (message.sql) {
    const pre = document.createElement('pre');
    pre.textContent = message.sql;
    node.appendChild(pre);
  }
  if (message.message) {
    const detail = document.createElement('div');
    detail.textContent = message.message;
    node.appendChild(detail);
  }
  if (message.rows?.length) {
    const result = document.createElement('div');
    result.innerHTML = tableHtml(message.columns, message.rows);
    node.appendChild(result);
  }
  if (message.sql) node.appendChild(sqlActions(message.sql));
  return node;
}

function sqlActions(sql) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const run = document.createElement('button');
  run.className = 'ghost small';
  run.textContent = '执行 SQL';
  run.onclick = () => runAssistantSql(sql);
  const explain = document.createElement('button');
  explain.className = 'ghost small';
  explain.textContent = 'EXPLAIN';
  explain.onclick = () => runAssistantSql(sql, true);
  actions.append(explain, run);
  return actions;
}

const TOOL_META = {
  mysql_list_connections: ['🗄', '列出数据库连接'],
  mysql_read_query: ['🔍', '只读查询'],
  mysql_explain_query: ['📊', '执行计划'],
  mysql_performance_snapshot: ['📈', '性能快照'],
  mysql_sql_review: ['🛡', 'SQL 审计'],
};
function toolMeta(toolName) {
  const short = String(toolName || 'tool').replace(/^plugin__.+__/, '');
  const [ico, label] = TOOL_META[short] || ['⚙️', short];
  return { ico, label, short };
}
function parseArgs(args) {
  if (args == null) return null;
  if (typeof args === 'string') {
    try { return JSON.parse(args); } catch { return args; }
  }
  return args;
}
function stepBrief(step) {
  const args = parseArgs(step.args);
  if (args && typeof args === 'object') {
    if (args.sql) return String(args.sql).replace(/\s+/g, ' ').trim().slice(0, 90);
    if (args.connectionId) return `连接 ${String(args.connectionId).slice(0, 8)}…`;
    return JSON.stringify(args).slice(0, 90);
  }
  return args ? String(args).slice(0, 90) : '';
}
function truncate(text, max = 2000) {
  const str = String(text);
  return str.length > max ? `${str.slice(0, max)}\n…（共 ${str.length} 字符，已截断）` : str;
}

function stripThinkBlocks(content) {
  // 部分模型会把 <think> 推理标签混进正文，渲染前剥掉，避免页面出现裸露标签。
  return String(content || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
}

function extractSql(content) {
  return [...stripThinkBlocks(content).matchAll(/```(?:sql)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim()).filter(Boolean);
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function markdownToHtml(content) {
  const segments = stripThinkBlocks(content).split(/```(?:sql)?\n?([\s\S]*?)```/g);
  let html = '';
  for (let index = 0; index < segments.length; index++) {
    if (index % 2 === 1) {
      const code = segments[index].trim();
      html += `<div class="code-wrap"><button class="copy-btn" data-code="${escapeHtml(code)}">复制</button><pre><code>${escapeHtml(code)}</code></pre></div>`;
      continue;
    }
    const block = segments[index].replace(/\r\n/g, '\n').trim();
    if (!block) continue;
    html += block.split(/\n{2,}/).map(paragraph => {
      const lines = paragraph.split('\n');
      if (lines.length >= 2 && lines.every(line => line.trim().startsWith('|')) && /^\|[\s:|-]+\|$/.test(lines[1].trim())) {
        const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
        const head = cells(lines[0]);
        const rows = lines.slice(2).map(cells);
        return `<table><thead><tr>${head.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      }
      if (lines.every(line => line.trim().startsWith('- ') || line.trim().startsWith('* '))) {
        return `<ul>${lines.map(line => `<li>${inlineMarkdown(line.replace(/^\s*[-*]\s*/, ''))}</li>`).join('')}</ul>`;
      }
      if (/^#{1,6}\s+/.test(lines[0])) {
        const level = Math.min(6, lines[0].match(/^#+/)[0].length);
        return `<h${level}>${inlineMarkdown(lines[0].replace(/^#{1,6}\s+/, ''))}</h${level}>${lines.slice(1).map(line => `<p>${inlineMarkdown(line)}</p>`).join('')}`;
      }
      return `<p>${lines.map(line => inlineMarkdown(line)).join('<br>')}</p>`;
    }).join('');
  }
  return html;
}

function stepsNode(message) {
  const wrapper = document.createElement('div');
  wrapper.className = 'steps-wrap';
  if (message.reasoning) {
    const reasoning = document.createElement('details');
    reasoning.className = 'step-row reasoning-block';
    reasoning.innerHTML = `<summary><span class="chev">▶</span><span class="step-ico">💭</span><span class="step-name">思考过程</span><span class="step-brief">${escapeHtml(message.reasoning.replace(/\s+/g, ' ').slice(0, 60))}</span></summary><div class="step-detail"><pre>${escapeHtml(truncate(message.reasoning, 4000))}</pre></div>`;
    wrapper.appendChild(reasoning);
  }
  if (message.steps?.length) {
    const container = document.createElement('div');
    container.className = 'steps';
    message.steps.forEach(step => {
      const meta = toolMeta(step.toolName);
      const done = step.status === 'result';
      const row = document.createElement('details');
      row.className = 'step-row';
      const args = parseArgs(step.args);
      const argsText = args == null ? '' : (typeof args === 'string' ? args : JSON.stringify(args, null, 2));
      const resultText = step.result == null ? '' : (typeof step.result === 'string' ? step.result : JSON.stringify(step.result, null, 2));
      row.innerHTML = `<summary>
        <span class="chev">▶</span><span class="step-ico">${meta.ico}</span>
        <span class="step-name">${escapeHtml(meta.label)}</span>
        <span class="step-brief" title="${escapeHtml(stepBrief(step))}">${escapeHtml(stepBrief(step))}</span>
        <span class="step-state ${done ? 'ok' : 'run'}">${done ? '✓ 完成' : '… 执行中'}</span>
      </summary>
      <div class="step-detail">
        ${argsText ? `<pre>${escapeHtml(truncate(argsText))}</pre>` : ''}
        ${resultText ? `<pre>${escapeHtml(truncate(resultText))}</pre>` : ''}
      </div>`;
      container.appendChild(row);
    });
    wrapper.appendChild(container);
  }
  return wrapper;
}

async function sendMessage() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!state.connectionId) {
    toast('请先选择数据库连接', true);
    return;
  }
  if (!state.activeConversationId) newConversation();
  const conversation = state.conversations.find(item => item.id === state.activeConversationId);
  if (conversation.title === '新对话') conversation.title = text.slice(0, 30);
  conversation.messages.push({ role: 'user', content: text });
  const pending = { id: crypto.randomUUID(), role: 'assistant', content: '', reasoning: '', steps: [], streaming: true };
  conversation.messages.push(pending);
  input.value = '';
  saveConversations();
  renderConversations();
  renderChatMessages();
  setBusy(true);
  setStreamStatus('AI 正在思考');
  try {
    await streamAssistant(conversation.id, text, pending);
    setStreamStatus('已完成');
    setTimeout(() => setBusy(false), 450);
  } catch (error) {
    pending.content = error.message;
    setStreamStatus('执行失败');
    setTimeout(() => setBusy(false), 900);
  }
  saveConversations();
  renderChatMessages();
}

async function streamAssistant(agentId, message, pending) {
  const response = await fetch(`/api/mysql/${state.connectionId}/ai/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, message, table: state.selectedTable || '' })
  });
  if (!response.ok || !response.body) throw new Error(`请求失败 (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data = '';
  const render = () => renderStreamingMessage(pending);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(line => {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += `${line.slice(5).trim()}\n`;
      else if (!line && data) {
        try {
          const payload = JSON.parse(data);
          if (event === 'chunk') pending.content += payload.content || '';
          if (event === 'chunk' && pending.content) setStreamStatus('正在回复');
          if (event === 'reasoning') pending.reasoning += payload.content || '';
          if (event === 'reasoning' && !pending.steps?.length) setStreamStatus('AI 正在思考');
          if (event === 'step_break') setStreamStatus(`正在执行 ${payload.toolName || '工具'}`);
          if (event === 'tool_result') setStreamStatus('正在整理结果');
          if (event === 'step_break') {
            const exists = payload.callId && pending.steps.some(item => item.callId === payload.callId);
            if (!exists) pending.steps.push({ ...payload, status: 'running' });
          }
          if (event === 'tool_result') {
            const step = [...pending.steps].reverse().find(item => item.callId === payload.callId)
              || [...pending.steps].reverse().find(item => item.status === 'running');
            if (step) Object.assign(step, payload, { status: 'result' });
            else pending.steps.push({ ...payload, status: 'result' });
          }
          if (event === 'finish' || event === 'done') {
            pending.steps.forEach(item => { if (item.status === 'running') item.status = 'result'; });
          }
          if (event === 'error') pending.content += `\n\n**错误：** ${payload.message || '未知错误'}`;
          render();
        } catch {
        }
        event = 'message';
        data = '';
      }
    });
  }
}

async function runAssistantSql(sql, explain = false) {
  try {
    const query = await request(`/api/mysql/${state.connectionId}/${explain ? 'explain' : 'query'}`, {
      method: 'POST',
      body: JSON.stringify({ sql, allowWrite: false })
    });
    appendOperation({
      title: explain ? 'EXPLAIN 执行结果' : 'SQL 执行结果',
      status: 'success',
      sql,
      message: `${query.readOnly ? '只读' : '写操作'} · 耗时 ${query.elapsedMs}ms · ${query.rows?.length || query.affectedRows} 行`,
      columns: query.columns,
      rows: query.rows
    });
    renderResult(query);
    loadPerformance().catch(() => {});
  } catch (error) {
    appendOperation({ title: explain ? 'EXPLAIN 失败' : 'SQL 执行失败', status: 'error', sql, message: error.message });
    toast(error.message, true);
  }
}

function appendOperation(operation) {
  if (!state.activeConversationId) newConversation();
  const conversation = state.conversations.find(item => item.id === state.activeConversationId);
  conversation.messages.push({ role: 'operation', ...operation });
  saveConversations();
  renderChatMessages();
}

async function loadConnections() {
  state.connections = await request('/api/connections');
  const saved = localStorage.getItem('dsh.mysql.connection');
  if (!state.connectionId || !state.connections.some(item => item.id === state.connectionId)) {
    const next = state.connections.find(item => item.id === saved)?.id || state.connections[0]?.id || null;
    await selectConnection(next);
  } else {
    renderConnections();
  }
}

async function selectConnection(id) {
  state.connectionId = id;
  state.selectedTable = '';
  localStorage.setItem('dsh.mysql.connection', id || '');
  renderConnections();
  const selected = state.connections.find(item => item.id === id);
  $('#currentName').textContent = selected?.name || '未选择连接';
  $('#currentDetail').textContent = selected ? `${selected.username}@${selected.host}:${selected.port}/${selected.database}` : '';
  $('#statusDot').className = `dot ${id ? 'online' : 'offline'}`;
  if (!id) return;
  await loadOverview();
  await loadTables();
  loadPerformance().catch(error => toast(error.message, true));
}

async function loadOverview() {
  const overview = await request(`/api/mysql/${state.connectionId}/overview`);
  $('#connectionCard').innerHTML = `<div class="kv">
    <span>数据库</span><span>${escapeHtml(overview.database)}</span>
    <span>产品</span><span>${escapeHtml(overview.product)}</span>
    <span>版本</span><span>${escapeHtml(overview.version)}</span>
    <span>URL</span><span title="${escapeHtml(overview.url)}">${escapeHtml(overview.url)}</span>
  </div>`;
  $('#currentDetail').textContent = `${$('#currentDetail').textContent.split(' · ')[0]} · ${overview.product} ${overview.version?.split(' ')?.[0] || ''}`;
}

async function loadTables() {
  state.tables = await request(`/api/mysql/${state.connectionId}/tables`);
  const container = $('#tableList');
  container.classList.remove('hidden');
  container.innerHTML = state.tables.length
    ? state.tables.map(item => `<div class="row-item" data-name="${escapeHtml(item.name)}"><span>${escapeHtml(item.name)}</span><span class="muted">${escapeHtml(item.type)}</span></div>`).join('')
    : '<span class="muted">无表</span>';
  container.querySelectorAll('.row-item').forEach(row => {
    row.onclick = () => loadTableDetail(row.dataset.name);
  });
}

async function loadTableDetail(name) {
  state.selectedTable = name;
  [...$('#tableList').querySelectorAll('.row-item')].forEach(row => row.classList.toggle('active', row.dataset.name === name));
  const detail = await request(`/api/mysql/${state.connectionId}/tables/${encodeURIComponent(name)}`);
  const container = $('#tableDetail');
  container.classList.remove('hidden');
  container.innerHTML = `<div style="margin-bottom:8px"><b>${escapeHtml(name)}</b></div>${tableHtml(['Field', 'Type', 'Key'], detail.columns.slice(0, 10))}`;
}

async function loadPerformance() {
  const data = await request(`/api/mysql/${state.connectionId}/performance`);
  const map = Object.fromEntries(data.status.map(row => [row.Variable_name, row.Value]));
  const names = ['Threads_connected', 'Threads_running', 'Slow_queries', 'Questions'];
  $('#metrics').innerHTML = names.map(name => `<div class="metric"><small>${name}</small><b>${formatNumber(map[name])}</b></div>`).join('');
  $('#processes').innerHTML = tableHtml(data.processes[0] ? Object.keys(data.processes[0]) : ['Info'], data.processes);
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('zh-CN') : value || '0';
}

function renderResult(query) {
  $('#result').innerHTML = query.columns?.length
    ? tableHtml(query.columns, query.rows)
    : `<p class="muted">✅ 执行成功，影响 ${query.affectedRows} 行，耗时 ${query.elapsedMs}ms</p>`;
}

async function executeSql(explain = false) {
  const sql = $('#sql').value.trim();
  if (!sql) return;
  const allowWrite = !explain && $('#allowWrite').checked;
  if (allowWrite && !confirm('即将执行写操作，确认继续？')) return;
  $('#result').innerHTML = '<span class="muted">执行中...</span>';
  try {
    const query = await request(`/api/mysql/${state.connectionId}/${explain ? 'explain' : 'query'}`, {
      method: 'POST',
      body: JSON.stringify({ sql, allowWrite })
    });
    renderResult(query);
    appendOperation({
      title: explain ? 'EXPLAIN 执行结果' : 'SQL 执行结果',
      status: 'success',
      sql,
      message: `${query.readOnly ? '只读' : '写操作'} · 耗时 ${query.elapsedMs}ms · ${query.rows?.length || query.affectedRows} 行`,
      columns: query.columns,
      rows: query.rows
    });
    loadPerformance().catch(() => {});
  } catch (error) {
    $('#result').innerHTML = `<span class="muted">${escapeHtml(error.message)}</span>`;
    toast(error.message, true);
  }
}

async function saveConnection(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await request('/api/connections', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
    $('#connectionModal').classList.add('hidden');
    event.target.reset();
    state.connectionId = null;
    await loadConnections();
    toast('连接已保存');
  } catch (error) {
    toast(error.message, true);
  }
}

$('#addConnection').onclick = () => $('#connectionModal').classList.remove('hidden');
$('#cancelModal').onclick = () => $('#connectionModal').classList.add('hidden');
$('#connectionForm').onsubmit = saveConnection;
$('#newConversation').onclick = newConversation;
$('#sendMessage').onclick = sendMessage;
$('#chatInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { sendMessage(); return; }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
});
$('#chatInput').addEventListener('input', () => {
  const el = $('#chatInput');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
});
$('#connectionSelect').onchange = event => selectConnection(event.target.value || null);
$('#runSql').onclick = () => executeSql(false);
$('#explain').onclick = () => executeSql(true);
$('#refreshResource').onclick = async () => {
  if (!state.connectionId) return;
  await loadOverview();
  await loadTables();
  await loadPerformance();
  toast('资源已刷新');
};
$('#refreshTables').onclick = () => loadTables().then(() => toast('表已刷新')).catch(error => toast(error.message, true));
$('#refreshPerformance').onclick = () => loadPerformance().then(() => toast('监控已刷新')).catch(error => toast(error.message, true));
$('#deleteConnection').onclick = async () => {
  if (!state.connectionId || !confirm('确定删除当前连接配置？')) return;
  await request(`/api/connections/${state.connectionId}`, { method: 'DELETE' });
  await selectConnection(null);
  await loadConnections();
};
document.addEventListener('click', event => {
  const btn = event.target.closest('.copy-btn');
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.code || '').then(() => {
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  });
});

loadConversations();
if (!state.conversations.length) newConversation();
loadConnections().catch(error => toast(error.message, true));
