/**
 * Minimal, dependency-free agent sidebar.
 *
 * It is served by the local API (`GET /v1/agent/ui`) and talks to the same
 * JSON/SSE endpoints as any other client. No build step, no external assets.
 */
export function agentUiHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenCorpCheck Agent Sidebar</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f5; --card:#fff; --ink:#1c1c1a; --muted:#6b6b66; --line:#e3e3df; --accent:#0f6b4f; --accent-2:#e8f3ee; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161614; --card:#1f1f1c; --ink:#f1f1ec; --muted:#a5a59d; --line:#333330; --accent:#5fd0a8; --accent-2:#193129; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width: 860px; margin: 0 auto; padding: 20px 16px 120px; }
  header { display:flex; align-items:baseline; gap:10px; margin-bottom:16px; }
  header h1 { font-size:18px; margin:0; letter-spacing:-0.01em; }
  header .status { font-size:12px; color:var(--muted); }
  .msg { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin:10px 0; white-space:pre-wrap; word-break:break-word; }
  .msg.user { background:var(--accent-2); border-color:transparent; }
  .msg .role { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:4px; }
  .thought { color:var(--muted); font-style:italic; }
  .tool { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:8px; padding:8px 10px; margin:6px 0; font-size:13px; }
  .tool .name { font-weight:600; }
  .tool .meta { color:var(--muted); font-size:12px; }
  .tool pre { margin:6px 0 0; padding:8px; background:var(--bg); border-radius:6px; overflow:auto; max-height:220px; font-size:12px; }
  .notice { font-size:12px; color:var(--muted); margin:6px 0; }
  .error { color:#b00020; }
  footer { position:fixed; left:0; right:0; bottom:0; background:var(--bg); border-top:1px solid var(--line); padding:12px 16px; }
  .composer { max-width:860px; margin:0 auto; display:flex; gap:8px; align-items:flex-end; }
  textarea { flex:1; resize:none; min-height:44px; max-height:180px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--ink); font:inherit; }
  button { border:0; border-radius:10px; padding:10px 16px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button.secondary { background:transparent; color:var(--muted); border:1px solid var(--line); }
  button:disabled { opacity:.5; cursor:not-allowed; }
</style>
</head>
<body>
<main>
  <header>
    <h1>OpenCorpCheck · Agent Sidebar</h1>
    <span class="status" id="status">未连接</span>
  </header>
  <div id="messages"></div>
</main>
<footer>
  <div class="composer">
    <textarea id="input" rows="2" placeholder="问公司问题，例如：Google 有没有投资 Anthropic？"></textarea>
    <button id="send">发送</button>
    <button id="cancel" class="secondary" disabled>停止</button>
  </div>
</footer>
<script>
(() => {
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const cancel = document.getElementById('cancel');
  const status = document.getElementById('status');
  let sessionId = null;
  let busy = false;
  let assistantEl = null;
  let assistantText = '';
  const tools = new Map();

  function setBusy(value) {
    busy = value;
    send.disabled = value;
    cancel.disabled = !value;
    status.textContent = value ? '思考中…' : sessionId ? '已连接' : '未连接';
  }

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    const label = document.createElement('div');
    label.className = 'role';
    label.textContent = role === 'user' ? '你' : 'Agent';
    const body = document.createElement('div');
    body.textContent = text;
    el.append(label, body);
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return body;
  }

  function addTool(event) {
    let el = tools.get(event.callId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tool';
      el.innerHTML = '<div class="name"></div><div class="meta"></div><pre hidden></pre>';
      messages.appendChild(el);
      tools.set(event.callId, el);
    }
    const nameEl = el.querySelector('.name');
    if (event.title || event.tool) {
      nameEl.textContent = event.title || event.tool;
    } else if (!nameEl.textContent) {
      nameEl.textContent = event.callId;
    }
    const meta = [event.kind, event.status].filter(Boolean).join(' · ');
    el.querySelector('.meta').textContent = meta;
    const pre = el.querySelector('pre');
    const payload = event.output !== undefined ? event.output : event.input;
    if (payload !== undefined && payload !== null) {
      pre.hidden = false;
      pre.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    }
    return el;
  }

  async function createSession() {
    const response = await fetch('/v1/agent/sessions', { method: 'POST' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || '创建会话失败');
    sessionId = body.data.sessionId;
    status.textContent = '已连接';
    return sessionId;
  }

  async function sendPrompt(text) {
    setBusy(true);
    assistantEl = null;
    assistantText = '';
    addMessage('user', text);
    try {
      if (!sessionId) await createSession();
      const response = await fetch('/v1/agent/sessions/' + encodeURIComponent(sessionId) + '/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error?.message || ('HTTP ' + response.status));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\\n\\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          handleFrame(frame);
        }
      }
    } catch (error) {
      const el = document.createElement('div');
      el.className = 'msg error';
      el.textContent = '错误：' + (error instanceof Error ? error.message : String(error));
      messages.appendChild(el);
    } finally {
      setBusy(false);
    }
  }

  function handleFrame(frame) {
    let name = 'message';
    let data = '';
    for (const line of frame.split('\\n')) {
      if (line.startsWith('event: ')) name = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!data) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }

    if (event.type === 'assistant.delta') {
      if (!assistantEl) assistantEl = addMessage('agent', '');
      assistantText += event.text;
      assistantEl.textContent = assistantText;
      messages.scrollTop = messages.scrollHeight;
    } else if (event.type === 'thought.delta') {
      let thought = document.querySelector('.msg.thought.current');
      if (!thought) {
        thought = document.createElement('div');
        thought.className = 'msg thought current';
        messages.appendChild(thought);
      }
      thought.textContent += event.text;
    } else if (event.type === 'tool.called') {
      assistantEl = null;
      addTool(event);
    } else if (event.type === 'tool.updated') {
      addTool(event);
    } else if (event.type === 'plan') {
      const el = document.createElement('div');
      el.className = 'notice';
      el.textContent = '计划：' + event.entries.map((entry) => entry.content).join(' / ');
      messages.appendChild(el);
    } else if (event.type === 'permission.requested') {
      const el = document.createElement('div');
      el.className = 'notice';
      el.textContent = '权限：' + (event.title || event.callId) + ' → ' + event.option;
      messages.appendChild(el);
    } else if (event.type === 'run.failed') {
      const el = document.createElement('div');
      el.className = 'msg error';
      el.textContent = '运行失败：' + event.error;
      messages.appendChild(el);
    } else if (event.type === 'notice') {
      const el = document.createElement('div');
      el.className = 'notice';
      el.textContent = event.title + (event.description ? ' — ' + event.description : '');
      messages.appendChild(el);
    } else if (event.type === 'run.completed') {
      document.querySelectorAll('.msg.thought.current').forEach((el) => el.classList.remove('current'));
      status.textContent = '已完成';
    }
    messages.scrollTop = messages.scrollHeight;
  }

  send.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    sendPrompt(text);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send.click();
    }
  });
  cancel.addEventListener('click', async () => {
    if (!sessionId) return;
    await fetch('/v1/agent/sessions/' + encodeURIComponent(sessionId) + '/cancel', { method: 'POST' });
    status.textContent = '已请求停止';
  });
})();
</script>
</body>
</html>`;
}
