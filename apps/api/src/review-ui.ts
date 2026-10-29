/**
 * Server-rendered review console. Deliberately dependency-free: one HTML page
 * with inline CSS/JS that talks to the JSON endpoints. It binds data with
 * `textContent` (never `innerHTML`) because queue payloads can contain
 * untrusted web text.
 */
export function reviewUiHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCorpCheck · Review queue</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f5; --panel: #ffffff; --text: #1b1b19; --muted: #6b6b63;
    --border: #dedcd5; --accent: #1f6f4a; --danger: #a3342f; --chip: #ecebe5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161614; --panel: #1f1f1c; --text: #ecebe5; --muted: #a4a39a;
      --border: #34342f; --accent: #7fce9f; --danger: #ef8a84; --chip: #2b2b27;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  header {
    padding: 20px 24px 12px; display: flex; flex-wrap: wrap; gap: 12px;
    align-items: baseline; justify-content: space-between;
  }
  h1 { font-size: 18px; margin: 0; font-weight: 650; }
  .hint { color: var(--muted); font-size: 12px; }
  main { padding: 0 24px 40px; max-width: 1100px; }
  .bar {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    padding: 12px; background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; margin-bottom: 12px; position: sticky; top: 8px; z-index: 2;
  }
  select, input[type="text"], button {
    font: inherit; color: inherit; background: var(--panel);
    border: 1px solid var(--border); border-radius: 7px; padding: 6px 9px;
  }
  button { cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #08140d; font-weight: 600; }
  button.reject { color: var(--danger); border-color: var(--danger); background: transparent; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 12px; color: var(--muted); font-weight: 600; background: var(--chip); position: sticky; top: 68px; }
  tr:last-child td { border-bottom: 0; }
  td.check { width: 28px; }
  .kind { display: inline-block; padding: 1px 7px; border-radius: 999px; background: var(--chip); font-size: 12px; }
  .status { color: var(--muted); font-size: 12px; }
  .payload { max-width: 420px; overflow-wrap: anywhere; }
  .quote { color: var(--muted); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
  .empty { padding: 40px 10px; text-align: center; color: var(--muted); }
  .toast { position: fixed; right: 18px; bottom: 18px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; box-shadow: 0 8px 30px rgba(0,0,0,.12); display: none; max-width: 420px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <div>
    <h1>Review queue</h1>
    <div class="hint">Approve/reject agent proposals and inferred relations. Only pending items transition; accepted relations become <code>verified</code>.</div>
  </div>
  <div class="hint"><a href="/openapi.json">OpenAPI</a> · <a href="/v1/health">health</a></div>
</header>
<main>
  <div class="bar">
    <label class="hint">status
      <select id="status">
        <option value="pending" selected>pending</option>
        <option value="accepted">accepted</option>
        <option value="rejected">rejected</option>
        <option value="">all</option>
      </select>
    </label>
    <label class="hint">kind
      <select id="kind">
        <option value="">all</option>
        <option value="relation">relation</option>
        <option value="fact">fact</option>
      </select>
    </label>
    <label class="hint">limit
      <select id="limit">
        <option>50</option><option selected>200</option>
      </select>
    </label>
    <button id="refresh">Refresh</button>
    <span style="flex:1"></span>
    <label class="hint">reviewer <input id="reviewer" type="text" size="10" placeholder="your name"></label>
    <button class="primary" id="approve" disabled>Approve selected</button>
    <button class="reject" id="reject" disabled>Reject selected</button>
  </div>
  <table>
    <thead>
      <tr>
        <th class="check"><input type="checkbox" id="all" title="select all"></th>
        <th>kind</th><th>payload</th><th>evidence</th><th>created</th><th>status</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty" hidden>No items for this filter.</div>
</main>
<div class="toast" id="toast"></div>
<script>
(function () {
  var state = { items: [], selected: new Set() };
  var rows = document.getElementById("rows");
  var empty = document.getElementById("empty");
  var toast = document.getElementById("toast");
  var approve = document.getElementById("approve");
  var reject = document.getElementById("reject");
  var all = document.getElementById("all");

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function showToast(message, error) {
    toast.textContent = message;
    toast.style.display = "block";
    toast.style.borderColor = error ? "var(--danger)" : "var(--border)";
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { toast.style.display = "none"; }, 5000);
  }

  function summarize(value) {
    try { return JSON.stringify(value); }
    catch (_) { return String(value); }
  }

  function syncButtons() {
    var count = state.selected.size;
    approve.disabled = count === 0;
    reject.disabled = count === 0;
    approve.textContent = count ? "Approve " + count : "Approve selected";
    reject.textContent = count ? "Reject " + count : "Reject selected";
  }

  function render() {
    rows.textContent = "";
    state.selected.clear();
    syncButtons();
    all.checked = false;
    empty.hidden = state.items.length > 0;

    state.items.forEach(function (item) {
      var tr = document.createElement("tr");

      var check = el("td", null, "check");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.addEventListener("change", function () {
        if (box.checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
        syncButtons();
      });
      check.appendChild(box);
      tr.appendChild(check);

      var kind = el("td");
      kind.appendChild(el("span", item.kind, "kind"));
      tr.appendChild(kind);

      var payload = el("td", null, "payload");
      payload.appendChild(el("div", summarize(item.payload)));
      tr.appendChild(payload);

      var evidence = el("td", null, "payload");
      var ev = item.evidence || {};
      evidence.appendChild(el("div", ev.sourceUrl || ev.url || "—"));
      if (ev.quote) evidence.appendChild(el("div", "“" + ev.quote + "”", "quote"));
      tr.appendChild(evidence);

      tr.appendChild(el("td", (item.createdAt || "").slice(0, 19), "status"));
      tr.appendChild(el("td", item.status, "status"));
      rows.appendChild(tr);
    });
  }

  async function load() {
    var status = document.getElementById("status").value;
    var kind = document.getElementById("kind").value;
    var limit = document.getElementById("limit").value;
    var url = new URL("/v1/review/queue", location.origin);
    if (status) url.searchParams.set("status", status);
    if (kind) url.searchParams.set("kind", kind);
    url.searchParams.set("limit", limit);
    try {
      var response = await fetch(url);
      var body = await response.json();
      if (!response.ok) throw new Error(body.error ? body.error.message : response.status);
      state.items = body.data.items;
      render();
      showToast("Loaded " + state.items.length + " items");
    } catch (error) {
      showToast("Load failed: " + (error.message || error), true);
    }
  }

  async function decide(decision) {
    if (state.selected.size === 0) return;
    if (decision === "rejected" && !confirm("Reject " + state.selected.size + " item(s)?")) return;
    var reviewer = document.getElementById("reviewer").value.trim();
    try {
      var response = await fetch("/v1/review/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: decision,
          ids: Array.from(state.selected),
          reviewer: reviewer || undefined,
        }),
      });
      var body = await response.json();
      if (!response.ok) throw new Error(body.error ? body.error.message : response.status);
      showToast(decision + ": updated " + body.data.updated + ", skipped " + body.data.skipped);
      load();
    } catch (error) {
      showToast("Decision failed: " + (error.message || error), true);
    }
  }

  document.getElementById("refresh").addEventListener("click", load);
  document.getElementById("status").addEventListener("change", load);
  document.getElementById("kind").addEventListener("change", load);
  document.getElementById("limit").addEventListener("change", load);
  approve.addEventListener("click", function () { decide("accepted"); });
  reject.addEventListener("click", function () { decide("rejected"); });
  all.addEventListener("change", function () {
    state.selected.clear();
    if (all.checked) state.items.forEach(function (item) { state.selected.add(item.id); });
    Array.prototype.forEach.call(rows.querySelectorAll("input[type=checkbox]"), function (box) {
      box.checked = all.checked;
    });
    syncButtons();
  });

  load();
})();
</script>
</body>
</html>`;
}
