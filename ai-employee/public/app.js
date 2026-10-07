const statusEl = document.querySelector('#status');
const messagesEl = document.querySelector('#messages');
const form = document.querySelector('#chat-form');
const input = document.querySelector('#message');
const sendButton = form.querySelector('button');
const reindexButton = document.querySelector('#reindex');
const incidentsEl = document.querySelector('#incidents');
const memoryEl = document.querySelector('#memory');
const history = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function addMessage(role, content, sources = []) {
  const article = document.createElement('article');
  article.className = role;
  const sourceHtml = sources.length
    ? `<div class="sources"><strong>Retrieved evidence</strong><br>${sources.map(item => `${escapeHtml(item.source)}:${item.startLine}-${item.endLine}`).join('<br>')}</div>`
    : '';
  article.innerHTML = `<div class="label">${role === 'user' ? 'You' : 'AI employee'}</div><p>${escapeHtml(content)}</p>${sourceHtml}`;
  messagesEl.append(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return article;
}

async function refreshStatus() {
  const response = await fetch('/api/status');
  const data = await response.json();
  const ollama = data.ollama.available ? 'Connected' : 'Not running';
  const modelReady = data.ollama.models?.some(name => name === data.configuredModel || name.startsWith(`${data.configuredModel}:`));
  statusEl.innerHTML = `
    <dt>Ollama</dt><dd>${ollama}</dd>
    <dt>Model</dt><dd>${escapeHtml(data.configuredModel)}${modelReady ? '' : ' (missing)'}</dd>
    <dt>Documents</dt><dd>${data.index.documents}</dd>
    <dt>Chunks</dt><dd>${data.index.chunks}</dd>
    <dt>Embeddings</dt><dd>${escapeHtml(data.index.embeddingModel || 'lexical only')}</dd>
    <dt>Incidents</dt><dd>${data.incidents.open} open (${data.incidents.major} major)</dd>`;
}

async function refreshIncidents() {
  const response = await fetch('/api/incidents?limit=8');
  const data = await response.json();
  incidentsEl.innerHTML = data.incidents.length
    ? data.incidents.map(item => `<article class="incident ${escapeHtml(item.severity)}"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.severity)} · ${escapeHtml(item.lastSeenAt)}</small><div class="row-actions"><button data-incident="${escapeHtml(item.id)}" data-status="acknowledged">Acknowledge</button><button data-incident="${escapeHtml(item.id)}" data-status="resolved">Resolve</button></div></article>`).join('')
    : '<p>No incidents recorded.</p>';
}

async function refreshMemory() {
  const response = await fetch('/api/memory?status=pending');
  const data = await response.json();
  memoryEl.innerHTML = data.entries.length
    ? data.entries.slice(0, 8).map(item => `<article><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source)}</small><div class="row-actions"><button data-memory="${escapeHtml(item.id)}" data-decision="approved">Approve</button><button data-memory="${escapeHtml(item.id)}" data-decision="rejected">Reject</button></div></article>`).join('')
    : '<p>No pending memory.</p>';
}

incidentsEl.addEventListener('click', async event => {
  const button = event.target.closest('button[data-incident]');
  if (!button) return;
  await fetch(`/api/incidents/${encodeURIComponent(button.dataset.incident)}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: button.dataset.status }) });
  await Promise.all([refreshIncidents(), refreshStatus()]);
});

memoryEl.addEventListener('click', async event => {
  const button = event.target.closest('button[data-memory]');
  if (!button) return;
  await fetch(`/api/memory/${encodeURIComponent(button.dataset.memory)}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: button.dataset.decision }) });
  await refreshMemory();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  addMessage('user', message);
  input.value = '';
  sendButton.disabled = true;
  const pending = addMessage('assistant', 'Thinking locally...');
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, history }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    pending.remove();
    addMessage('assistant', data.answer, data.sources);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: data.answer });
  } catch (error) {
    pending.querySelector('p').textContent = `Unable to answer: ${error.message}`;
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
});

reindexButton.addEventListener('click', async () => {
  reindexButton.disabled = true;
  reindexButton.textContent = 'Indexing...';
  try {
    const response = await fetch('/api/reindex', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Indexing failed');
    addMessage('assistant', `Knowledge index rebuilt: ${data.documents} documents, ${data.chunks} chunks.`);
    await refreshStatus();
  } catch (error) {
    addMessage('assistant', `Indexing failed: ${error.message}`);
  } finally {
    reindexButton.disabled = false;
    reindexButton.textContent = 'Rebuild knowledge index';
  }
});

Promise.all([refreshStatus(), refreshIncidents(), refreshMemory()]).catch(error => { statusEl.innerHTML = `<dt>Status</dt><dd>${escapeHtml(error.message)}</dd>`; });
