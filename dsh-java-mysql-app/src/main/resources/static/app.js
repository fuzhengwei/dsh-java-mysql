const state = {
  connectionId: null,
  connections: [],
  tables: [],
  selectedTable: '',
  selectedTableColumns: [],
  tableColumns: {},
  sqlHistory: [],
  sqlSuggestions: [],
  sqlSuggestionIndex: -1,
  performanceTimer: null,
  performanceUpdatedAt: 0,
  conversations: [],
  activeConversationId: null,
  activeStream: null,
  chatFollowBottom: true,
  chatLastScrollTop: 0,
  tablePage: 1,
  lastQuery: null
};
const $ = selector => document.querySelector(selector);
const STREAM_PAGE_SIZE = 50;

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

let confirmResolver = null;

function confirmDialog(title, message) {
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#confirmModal').classList.remove('hidden');
  return new Promise(resolve => { confirmResolver = resolve; });
}

function closeConfirm(result) {
  $('#confirmModal').classList.add('hidden');
  confirmResolver?.(result);
  confirmResolver = null;
}

function stopStream() {
  state.activeStream?.abort();
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
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>${columns.map(value => `<th>${escapeHtml(value)}</th>`).join('')}</tr></thead>`;
  const body = document.createElement('tbody');
  rows.forEach(row => {
    const tr = document.createElement('tr');
    columns.forEach((_, index) => tr.appendChild(formatCellValue(row, columns, index)));
    body.appendChild(tr);
  });
  table.appendChild(body);
  return table.outerHTML;
}

function formatCellValue(row, columns, index) {
  const value = Array.isArray(row) ? row[index] : row?.[columns[index]];
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const td = document.createElement('td');
  td.textContent = value == null ? 'NULL' : text;
  if (value == null) td.classList.add('null');
  if (typeof value === 'number' || /^-?\d+(?:\.\d+)?$/.test(text)) td.classList.add('numeric');
  if (text.length > 80) {
    td.title = '点击查看完整内容';
    td.onclick = () => openCellModal(value);
  }
  return td;
}

function openCellModal(value) {
  $('#cellModalTitle').textContent = '单元格内容';
  $('#cellModalBody').textContent = value == null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  $('#cellModal').classList.remove('hidden');
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
  $('#editConnection').disabled = !state.connectionId;
  $('#deleteConnection').disabled = !state.connectionId;
}

function loadConversations() {
  try {
    state.conversations = JSON.parse(localStorage.getItem('dsh.mysql.conversations') || '[]');
  } catch {
  state.conversations = [];
  }
  state.conversations = state.conversations.slice(0, 60).map(conversation => ({
    ...conversation,
    messages: (conversation.messages || []).slice(-100)
  }));
  state.activeConversationId = localStorage.getItem('dsh.mysql.activeConversation') || state.conversations[0]?.id || null;
  renderConversations();
  renderChatMessages();
}

function saveConversations() {
  state.conversations.forEach(conversation => {
    conversation.messages = (conversation.messages || []).slice(-100);
    conversation.messages.forEach(message => {
      if (message.role === 'operation' && message.rows?.length > 20) message.rows = message.rows.slice(0, 20);
      if (message.reasoning) message.reasoning = truncate(message.reasoning, 6000);
      message.steps?.forEach(step => {
        if (step.result != null && typeof step.result !== 'string') step.result = truncate(JSON.stringify(step.result), 3000);
        else if (typeof step.result === 'string') step.result = truncate(step.result, 3000);
      });
    });
  });
  try {
    localStorage.setItem('dsh.mysql.conversations', JSON.stringify(state.conversations));
    localStorage.setItem('dsh.mysql.activeConversation', state.activeConversationId || '');
  } catch {
    toast('本地存储已满，建议删除旧对话或清理大结果', true);
  }
}

function renderConversations() {
  const container = $('#conversationList');
  container.innerHTML = '';
  const keyword = $('#conversationSearch').value.trim().toLowerCase();
  const connectionMatches = conversation => !state.connectionId || conversation.connectionId === state.connectionId;
  const matches = state.conversations.filter(conversation => connectionMatches(conversation) && (!keyword || conversation.title.toLowerCase().includes(keyword)
    || conversation.messages.some(message => String(message.content || message.message || '').toLowerCase().includes(keyword))));
  if (!matches.length) {
    container.innerHTML = '<span class="muted">没有匹配的对话</span>';
    return;
  }
  matches.forEach(conversation => {
    const item = document.createElement('div');
    item.className = 'item' + (conversation.id === state.activeConversationId ? ' active' : '');
    const connection = state.connections.find(item => item.id === conversation.connectionId);
    item.innerHTML = `<button class="item-main" type="button">
        <b class="title">${escapeHtml(conversation.title)}</b>
        <span class="meta">${conversation.messages.length} 条 · ${relativeTime(conversation.updatedAt)}${connection ? ` · ${escapeHtml(connection.name)}` : ''}</span>
      </button>
      <span class="item-actions" aria-label="对话操作">
        <button class="item-action" type="button" data-action="rename" title="重命名" aria-label="重命名">重命名</button>
        <button class="item-action danger" type="button" data-action="delete" title="删除" aria-label="删除">删除</button>
      </span>`;
    item.querySelector('.item-main').onclick = () => selectConversation(conversation.id);
    item.querySelectorAll('[data-action]').forEach(actionButton => {
      actionButton.onclick = () => {
        if (actionButton.dataset.action === 'rename') renameConversation(conversation.id);
        if (actionButton.dataset.action === 'delete') deleteConversation(conversation.id);
      };
    });
    container.appendChild(item);
  });
}

function relativeTime(value) {
  if (!value) return '';
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} 天前`;
  return new Date(value).toLocaleDateString('zh-CN');
}

function renameConversation(id) {
  const conversation = state.conversations.find(item => item.id === id);
  const title = prompt('重命名对话', conversation?.title || '');
  if (!title) return;
  conversation.title = title.slice(0, 60);
  conversation.updatedAt = new Date().toISOString();
  saveConversations();
  renderConversations();
}

async function deleteConversation(id) {
  if (!await confirmDialog('删除对话', '删除后无法恢复，是否继续？')) return;
  state.conversations = state.conversations.filter(item => item.id !== id);
  if (state.activeConversationId === id) state.activeConversationId = state.conversations[0]?.id || null;
  if (!state.activeConversationId) newConversation();
  saveConversations();
  renderConversations();
  renderChatMessages();
}

function selectConversation(id) {
  const conversation = state.conversations.find(item => item.id === id);
  if (conversation && state.connectionId && conversation.connectionId && conversation.connectionId !== state.connectionId) {
    toast('该对话属于另一个数据库连接', true);
    return;
  }
  state.activeConversationId = id;
  state.chatFollowBottom = true;
  saveConversations();
  renderConversations();
  renderChatMessages();
}

function newConversation() {
  const conversation = { id: crypto.randomUUID(), title: '新对话', messages: [], connectionId: state.connectionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.conversations.unshift(conversation);
  saveConversations();
  selectConversation(conversation.id);
  return conversation;
}

function ensureConnectionConversation() {
  const active = state.conversations.find(item => item.id === state.activeConversationId);
  if (active && !active.connectionId && !active.messages.length) {
    active.connectionId = state.connectionId;
    active.updatedAt = new Date().toISOString();
    saveConversations();
    return active;
  }
  if (active && (!state.connectionId || active.connectionId === state.connectionId)) return active;
  const matching = state.conversations.find(item => item.connectionId === state.connectionId);
  if (matching) {
    state.activeConversationId = matching.id;
  } else {
    newConversation();
  }
  renderConversations();
  renderChatMessages();
  return state.conversations.find(item => item.id === state.activeConversationId);
}

function renderChatMessages() {
  const container = $('#chatMessages');
  const followBottom = state.chatFollowBottom;
  const previousScrollTop = container.scrollTop;
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
  container.scrollTop = followBottom ? container.scrollHeight : previousScrollTop;
  state.chatLastScrollTop = container.scrollTop;
  updateBackToBottom();
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
  if (text) text.innerHTML = markdownToHtml(pending.content || '') + (pending.streaming ? '<span class="stream-cursor">▍</span>' : '');
  node.querySelector('.steps-wrap')?.remove();
  // 思考/工具步骤始终渲染在正文之前，符合「过程在前、结论在后」的阅读顺序
  node.insertBefore(stepsNode(pending), text);
  autoscrollChat();
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

function autoscrollChat(force = false) {
  const container = $('#chatMessages');
  if (force) state.chatFollowBottom = true;
  if (state.chatFollowBottom) {
    container.scrollTop = container.scrollHeight;
    state.chatLastScrollTop = container.scrollTop;
  }
  updateBackToBottom();
}

function updateBackToBottom() {
  const container = $('#chatMessages');
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
  $('#backToBottom').classList.toggle('hidden', distance < 60);
}

function handleChatScroll() {
  const container = $('#chatMessages');
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (distance <= 4) state.chatFollowBottom = true;
  else if (container.scrollTop < state.chatLastScrollTop) state.chatFollowBottom = false;
  state.chatLastScrollTop = container.scrollTop;
  updateBackToBottom();
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
    const code = document.createElement('code');
    code.innerHTML = highlightedSql(message.sql);
    pre.appendChild(code);
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
  const source = stripThinkBlocks(content);
  if (!source) return '';
  const raw = marked.parse(source, { async: false, breaks: true, gfm: true });
  const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ['data-code'] });
  const template = document.createElement('template');
  template.innerHTML = clean;
  template.content.querySelectorAll('pre code').forEach(code => {
    const pre = code.parentElement;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const button = document.createElement('button');
    button.className = 'copy-btn';
    button.textContent = '复制';
    button.dataset.code = code.textContent;
    pre.replaceWith(wrap);
    wrap.append(button, pre);
    const language = [...code.classList].find(item => item.startsWith('language-'))?.slice(9);
    if (language === 'sql') code.innerHTML = highlightedSql(code.textContent);
    else if (window.hljs) hljs.highlightElement(code);
  });
  return template.innerHTML;
}

function highlightedSql(value) {
  if (!window.hljs) return escapeHtml(value);
  try {
    return hljs.highlight(String(value), { language: 'sql' }).value;
  } catch {
    return escapeHtml(value);
  }
}

let sqlHighlightFrame = null;

function renderSqlHighlight() {
  if (sqlHighlightFrame) cancelAnimationFrame(sqlHighlightFrame);
  sqlHighlightFrame = requestAnimationFrame(() => {
    sqlHighlightFrame = null;
    const code = $('#sqlHighlight code');
    code.className = 'hljs language-sql';
    code.innerHTML = highlightedSql($('#sql').value);
    syncSqlHighlightScroll();
  });
}

function syncSqlHighlightScroll() {
  const textarea = $('#sql');
  const highlight = $('#sqlHighlight');
  highlight.scrollTop = textarea.scrollTop;
  highlight.scrollLeft = textarea.scrollLeft;
}

function legacyMarkdownToHtml(content) {
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
  conversation.connectionId = state.connectionId;
  conversation.updatedAt = new Date().toISOString();
  conversation.messages.push({ role: 'user', content: text });
  const pending = { id: crypto.randomUUID(), role: 'assistant', content: '', reasoning: '', steps: [], streaming: true };
  conversation.messages.push(pending);
  input.value = '';
  state.chatFollowBottom = true;
  saveConversations();
  renderConversations();
  renderChatMessages();
  setBusy(true);
  setStreamStatus('AI 正在思考');
  try {
    await streamAssistant(conversation.id, text, pending);
    setStreamStatus('已完成');
  } catch (error) {
    pending.content = error.name === 'AbortError' ? '**已停止生成。**' : error.message;
    setStreamStatus('执行失败');
  } finally {
    pending.streaming = false;
    state.activeStream = null;
    setBusy(false);
  }
  saveConversations();
  renderChatMessages();
}

async function streamAssistant(agentId, message, pending) {
  const controller = new AbortController();
  state.activeStream = controller;
  const response = await fetch(`/api/mysql/${state.connectionId}/ai/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, message, table: state.selectedTable || '' }),
    signal: controller.signal
  });
  if (!response.ok || !response.body) throw new Error(`请求失败 (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data = '';
  let renderQueued = false;
  const render = () => {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      renderStreamingMessage(pending);
    }, 50);
  };
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
            pending.streaming = false;
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
  const persisted = { role: 'operation', ...operation };
  if (persisted.rows?.length > STREAM_PAGE_SIZE) persisted.rows = persisted.rows.slice(0, STREAM_PAGE_SIZE);
  conversation.messages.push(persisted);
  conversation.updatedAt = new Date().toISOString();
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
  state.selectedTableColumns = [];
  state.tableColumns = {};
  state.sqlHistory = id ? JSON.parse(localStorage.getItem(`dsh.mysql.sqlHistory.${id}`) || '[]') : [];
  $('#tableSearch').value = '';
  localStorage.setItem('dsh.mysql.connection', id || '');
  renderConnections();
  ensureConnectionConversation();
  const selected = state.connections.find(item => item.id === id);
  $('#currentName').textContent = selected?.name || '未选择连接';
  $('#currentDetail').textContent = selected ? `${selected.username}@${selected.host}:${selected.port}/${selected.database}` : '';
  $('#statusDot').className = `dot ${id ? 'online' : 'offline'}`;
  renderConversations();
  renderSqlHistory();
  if (!id) return;
  state.performanceUpdatedAt = 0;
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
  renderTables();
}

function renderTables() {
  const keyword = $('#tableSearch').value.trim().toLowerCase();
  const tables = state.tables.filter(item => !keyword || item.name.toLowerCase().includes(keyword));
  const container = $('#tableList');
  container.classList.remove('hidden');
  container.innerHTML = tables.length
    ? tables.map(item => `<div class="row-item" data-name="${escapeHtml(item.name)}"><span>${escapeHtml(item.name)}</span><span class="muted">${escapeHtml(item.type)}</span></div>`).join('')
    : '<span class="muted">无表</span>';
  container.querySelectorAll('.row-item').forEach(row => {
    row.onclick = () => loadTableDetail(row.dataset.name);
  });
}

async function loadTableDetail(name) {
  state.selectedTable = name;
  state.selectedTableColumns = detail.columns.map(column => column.Field);
  state.tableColumns[name] = state.selectedTableColumns;
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
  state.performanceUpdatedAt = Date.now();
}

function setPerformanceAutoRefresh(enabled) {
  localStorage.setItem('dsh.mysql.autoRefresh', enabled ? '1' : '');
  $('#autoRefresh').checked = enabled;
  clearInterval(state.performanceTimer);
  state.performanceTimer = null;
  if (!enabled) return;
  state.performanceTimer = setInterval(() => {
    if (!state.connectionId || $('#workspace').classList.contains('resource-hidden')) return;
    loadPerformance().catch(() => {});
  }, 15000);
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('zh-CN') : value || '0';
}

function renderResult(query) {
  state.lastQuery = query;
  state.tablePage = 1;
  if (!query.columns?.length) {
    $('#result').innerHTML = `<p class="muted">✅ 执行成功，影响 ${query.affectedRows} 行，耗时 ${query.elapsedMs}ms</p>`;
    return;
  }
  renderQueryPage();
}

function renderQueryPage() {
  const query = state.lastQuery;
  const pageSize = STREAM_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(query.rows.length / pageSize));
  state.tablePage = Math.min(state.tablePage, totalPages);
  const start = (state.tablePage - 1) * pageSize;
  const rows = query.rows.slice(start, start + pageSize);
  const stats = `第 ${start + 1}–${start + rows.length} 行 · 共 ${query.rows.length} 行 · ${query.elapsedMs}ms · <button class="ghost tiny" id="exportCsv">导出 CSV</button>`;
  const pager = totalPages > 1 ? `
    <div class="table-pager">
      <button class="ghost tiny" data-page="${state.tablePage - 1}" ${state.tablePage === 1 ? 'disabled' : ''}>上一页</button>
      <span>${state.tablePage} / ${totalPages}</span>
      <button class="ghost tiny" data-page="${state.tablePage + 1}" ${state.tablePage === totalPages ? 'disabled' : ''}>下一页</button>
    </div>` : '';
  $('#result').innerHTML = `<div class="result-meta">${stats}</div>${tableHtml(query.columns, rows)}${pager}`;
  $('#result').querySelectorAll('[data-page]').forEach(button => {
    button.onclick = () => { state.tablePage = Number(button.dataset.page); renderQueryPage(); };
  });
  $('#exportCsv').onclick = exportQueryCsv;
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function exportQueryCsv() {
  const query = state.lastQuery;
  if (!query?.columns?.length) return;
  const lines = [
    query.columns.map(csvCell).join(','),
    ...query.rows.map(row => query.columns.map((_, index) => csvCell(Array.isArray(row) ? row[index] : row?.[query.columns[index]])).join(','))
  ];
  const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `query-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function executeSql(explain = false) {
  const sql = $('#sql').value.trim();
  if (!sql) return;
  const allowWrite = !explain && $('#allowWrite').checked;
  if (allowWrite && !await confirmDialog('执行写操作', '即将执行写操作，确认继续？')) return;
  $('#result').innerHTML = '<span class="muted">执行中...</span>';
  try {
    const query = await request(`/api/mysql/${state.connectionId}/${explain ? 'explain' : 'query'}`, {
      method: 'POST',
      body: JSON.stringify({ sql, allowWrite })
    });
    renderResult(query);
    addSqlHistory(sql);
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

function addSqlHistory(sql) {
  state.sqlHistory = state.sqlHistory.filter(item => item.sql !== sql);
  state.sqlHistory.unshift({ sql, connectionId: state.connectionId, createdAt: new Date().toISOString() });
  state.sqlHistory = state.sqlHistory.filter(item => item.connectionId === state.connectionId).slice(0, 30);
  localStorage.setItem(`dsh.mysql.sqlHistory.${state.connectionId}`, JSON.stringify(state.sqlHistory));
  renderSqlHistory();
}

function renderSqlHistory() {
  const container = $('#sqlHistory');
  if (!state.sqlHistory.length) {
    container.innerHTML = '<span class="muted">暂无执行历史</span>';
    return;
  }
  container.innerHTML = state.sqlHistory.map((item, index) => `
    <button class="history-item" data-history="${index}">
      <span>${escapeHtml(item.sql.replace(/\s+/g, ' ').slice(0, 120))}</span>
      <small>${new Date(item.createdAt).toLocaleTimeString('zh-CN')}</small>
    </button>`).join('');
  container.querySelectorAll('[data-history]').forEach(button => {
    button.onclick = () => {
      setSqlValue(state.sqlHistory[Number(button.dataset.history)].sql);
      container.classList.add('hidden');
      $('#sql').focus();
    };
  });
}

function sqlSuggestionItems() {
  const sql = $('#sql').value;
  const caret = $('#sql').selectionStart || 0;
  const before = sql.slice(0, caret);
  const dotMatch = before.match(/([A-Za-z_][\w$]*)\.$/);
  if (dotMatch) {
    const tableName = Object.keys(state.tableColumns).find(name => name.toLowerCase() === dotMatch[1].toLowerCase());
    return (state.tableColumns[tableName] || []).map(column => ({ text: column, type: '列' }));
  }
  const wordMatch = before.match(/([A-Za-z_][\w$]*)$/);
  if (!wordMatch) return [];
  const prefix = wordMatch[1].toLowerCase();
  if (prefix.length < 1) return [];
  const keywords = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'GROUP BY', 'ORDER BY', 'LIMIT', 'SHOW TABLES', 'DESCRIBE', 'EXPLAIN'];
  const items = [
    ...state.tables.map(table => ({ text: table.name, type: '表' })),
    ...state.selectedTableColumns.map(column => ({ text: column, type: '列' })),
    ...keywords.map(keyword => ({ text: keyword, type: 'SQL' }))
  ];
  return items.filter(item => item.text.toLowerCase().startsWith(prefix)).slice(0, 8);
}

function renderSqlSuggestions() {
  const container = $('#sqlSuggestions');
  state.sqlSuggestions = sqlSuggestionItems();
  state.sqlSuggestionIndex = state.sqlSuggestions.length ? 0 : -1;
  if (!state.sqlSuggestions.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.innerHTML = state.sqlSuggestions.map((item, index) => `
    <button class="suggestion${index === state.sqlSuggestionIndex ? ' active' : ''}" data-suggestion="${index}">
      <span>${escapeHtml(item.text)}</span><small>${item.type}</small>
    </button>`).join('');
  container.classList.remove('hidden');
  container.querySelectorAll('[data-suggestion]').forEach(button => {
    button.onmousedown = event => {
      event.preventDefault();
      applySqlSuggestion(Number(button.dataset.suggestion));
    };
  });
}

function setSqlValue(value) {
  $('#sql').value = value;
  renderSqlHighlight();
}

function applySqlSuggestion(index) {
  const suggestion = state.sqlSuggestions[index];
  const textarea = $('#sql');
  if (!suggestion) return hideSqlSuggestions();
  const caret = textarea.selectionStart || 0;
  const before = textarea.value.slice(0, caret);
  const wordMatch = before.match(/([A-Za-z_][\w$]*)$/);
  const start = wordMatch ? caret - wordMatch[1].length : caret;
  textarea.value = textarea.value.slice(0, start) + suggestion.text + textarea.value.slice(caret);
  const nextCaret = start + suggestion.text.length;
  textarea.setSelectionRange(nextCaret, nextCaret);
  hideSqlSuggestions();
  renderSqlHighlight();
  textarea.focus();
}

function hideSqlSuggestions() {
  state.sqlSuggestions = [];
  state.sqlSuggestionIndex = -1;
  $('#sqlSuggestions').classList.add('hidden');
}

async function saveConnection(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const connectionId = event.target.dataset.connectionId;
  const payload = Object.fromEntries(form);
  const editing = Boolean(connectionId);
  try {
    await request(editing ? `/api/connections/${connectionId}` : '/api/connections', {
      method: editing ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    $('#connectionModal').classList.add('hidden');
    event.target.reset();
    delete event.target.dataset.connectionId;
    state.connectionId = null;
    await loadConnections();
    toast(editing ? '连接已更新' : '连接已保存');
  } catch (error) {
    toast(error.message, true);
  }
}

function openConnectionModal(connection = null) {
  const form = $('#connectionForm');
  form.reset();
  if (connection) {
    form.dataset.connectionId = connection.id;
    $('#connectionModalTitle').textContent = '编辑 MySQL 连接';
    form.elements.name.value = connection.name;
    form.elements.host.value = connection.host;
    form.elements.port.value = connection.port;
    form.elements.database.value = connection.database;
    form.elements.username.value = connection.username;
  } else {
    delete form.dataset.connectionId;
    $('#connectionModalTitle').textContent = '添加 MySQL 连接';
  }
  $('#connectionModal').classList.remove('hidden');
  form.elements.name.focus();
}

$('#addConnection').onclick = () => openConnectionModal();
$('#editConnection').onclick = () => {
  const connection = state.connections.find(item => item.id === state.connectionId);
  if (connection) openConnectionModal(connection);
};
$('#cancelModal').onclick = () => {
  $('#connectionModal').classList.add('hidden');
  delete $('#connectionForm').dataset.connectionId;
};
$('#connectionForm').onsubmit = saveConnection;
$('#newConversation').onclick = newConversation;
$('#conversationSearch').oninput = renderConversations;
$('#stopStream').onclick = stopStream;
$('#backToBottom').onclick = () => autoscrollChat(true);
$('#chatMessages').addEventListener('scroll', handleChatScroll);
$('#tableSearch').oninput = renderTables;
$('#toggleTheme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme === 'dark';
  root.dataset.theme = dark ? 'light' : 'dark';
  localStorage.setItem('dsh.mysql.theme', root.dataset.theme);
  $('#toggleTheme').textContent = dark ? '🌙' : '☀️';
};
$('#toggleResource').onclick = () => {
  const hidden = $('#workspace').classList.toggle('resource-hidden');
  $('#toggleResource').textContent = hidden ? '⇤' : '⇥';
};
$('#cellModalClose').onclick = () => $('#cellModal').classList.add('hidden');
$('#cellModalCopy').onclick = () => navigator.clipboard.writeText($('#cellModalBody').textContent);
$('#confirmCancel').onclick = () => closeConfirm(false);
$('#confirmOk').onclick = () => closeConfirm(true);
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
$('#autoRefresh').onchange = event => setPerformanceAutoRefresh(event.target.checked);
$('#toggleHistory').onclick = () => {
  $('#sqlHistory').classList.toggle('hidden');
  renderSqlHistory();
};
$('#sql').addEventListener('input', renderSqlSuggestions);
$('#sql').addEventListener('click', hideSqlSuggestions);
$('#sql').addEventListener('blur', () => setTimeout(hideSqlSuggestions, 120));
$('#sql').addEventListener('keydown', event => {
  if (!state.sqlSuggestions.length) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) executeSql(false);
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    state.sqlSuggestionIndex = (state.sqlSuggestionIndex + (event.key === 'ArrowDown' ? 1 : state.sqlSuggestions.length - 1)) % state.sqlSuggestions.length;
    renderSqlSuggestions();
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    applySqlSuggestion(state.sqlSuggestionIndex);
  } else if (event.key === 'Escape') hideSqlSuggestions();
});
$('#runSql').onclick = () => executeSql(false);
$('#explain').onclick = () => executeSql(true);
$('#refreshResource').onclick = async () => {
  if (!state.connectionId) return;
  const tab = document.querySelector('[data-resource-tab].active')?.dataset.resourceTab;
  if (tab === 'monitor') await loadPerformance();
  else {
    await loadOverview();
    await loadTables();
  }
  toast('资源已刷新');
};
$('#refreshTables').onclick = () => loadTables().then(() => toast('表已刷新')).catch(error => toast(error.message, true));
$('#refreshPerformance').onclick = () => loadPerformance().then(() => toast('监控已刷新')).catch(error => toast(error.message, true));
$('#deleteConnection').onclick = async () => {
  if (!state.connectionId || !await confirmDialog('删除连接', '确定删除当前连接配置？')) return;
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
document.querySelectorAll('[data-resource-tab]').forEach(button => {
  button.onclick = () => {
    document.querySelectorAll('[data-resource-tab]').forEach(item => item.classList.toggle('active', item === button));
    document.querySelectorAll('[data-tab]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.tab !== button.dataset.resourceTab));
    if (button.dataset.resourceTab === 'monitor') loadPerformance().catch(() => {});
  };
});
document.querySelector('[data-resource-tab="tables"]').click();
loadConnections().catch(error => toast(error.message, true));
$('#autoRefresh').checked = localStorage.getItem('dsh.mysql.autoRefresh') === '1';
setPerformanceAutoRefresh($('#autoRefresh').checked);
state.sqlHistory = JSON.parse(localStorage.getItem(`dsh.mysql.sqlHistory.${state.connectionId}`) || '[]');
renderSqlHistory();
document.documentElement.dataset.theme = localStorage.getItem('dsh.mysql.theme') || 'light';
$('#toggleTheme').textContent = document.documentElement.dataset.theme === 'dark' ? '☀️' : '🌙';
