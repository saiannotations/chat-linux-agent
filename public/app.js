/* Chat Linux Agent — frontend. No build step, plain JS. */

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const statusEl = $("status");
const inputEl = $("input");
const sendBtn = $("sendBtn");

let sessionId = localStorage.getItem("cla-session");
if (!sessionId) {
  sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) .replace(/[^a-z0-9-]/gi, "").slice(0, 36) || String(Date.now());
  localStorage.setItem("cla-session", sessionId);
}
let history = JSON.parse(localStorage.getItem("cla-history") || "[]");
let authPassword = sessionStorage.getItem("cla-pw") || "";

function saveHistory() {
  try {
    localStorage.setItem("cla-history", JSON.stringify(history.slice(-40)));
  } catch { /* storage full — ignore */ }
}

/* ---------- tiny markdown renderer (safe: escapes HTML first) ---------- */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineMd(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s;
}
function md(src) {
  const parts = [];
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0, m;
  const texts = [];
  while ((m = re.exec(src))) {
    texts.push(src.slice(last, m.index));
    parts.push({ code: m[2], lang: m[1] });
    last = m.index + m[0].length;
  }
  texts.push(src.slice(last));
  let html = "";
  texts.forEach((t, i) => {
    html += blockMd(t);
    if (parts[i]) html += `<pre><code>${esc(parts[i].code)}</code></pre>`;
  });
  return html;
}
function blockMd(t) {
  const lines = t.split("\n");
  let html = "", inList = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (h) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`;
    } else if (li) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineMd(li[1])}</li>`;
    } else if (line.trim() === "") {
      if (inList) { html += "</ul>"; inList = false; }
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${inlineMd(line)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

/* ---------- message rendering ---------- */
function addUser(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollDown();
}

let currentAgentDiv = null;
function ensureAgentDiv() {
  if (!currentAgentDiv) {
    currentAgentDiv = document.createElement("div");
    currentAgentDiv.className = "msg agent";
    messagesEl.appendChild(currentAgentDiv);
  }
  return currentAgentDiv;
}
function setAgentText(markdownText) {
  const div = ensureAgentDiv();
  div.innerHTML = md(markdownText);
  scrollDown();
}
function addToolCard(name, args) {
  const div = ensureAgentDiv();
  const details = document.createElement("details");
  details.className = "tool-card";
  details.open = false;
  const summary = document.createElement("summary");
  summary.textContent = "⚙️ " + name;
  const body = document.createElement("div");
  body.className = "tool-body";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(args, null, 2);
  body.appendChild(pre);
  details.appendChild(summary);
  details.appendChild(body);
  div.appendChild(details);
  scrollDown();
  return { details, body };
}
function setToolResult(card, name, output) {
  const pre = document.createElement("pre");
  pre.textContent = output;
  card.body.appendChild(pre);
  card.details.open = false;
  scrollDown();
}
function addShotThumb(url, image) {
  const div = ensureAgentDiv();
  const a = document.createElement("a");
  a.className = "shot-thumb";
  a.href = "#";
  a.onclick = (e) => { e.preventDefault(); showBrowserPanel(); };
  const img = document.createElement("img");
  img.src = image;
  img.alt = "Browser screenshot";
  const cap = document.createElement("span");
  cap.textContent = "📸 " + url;
  a.appendChild(img);
  a.appendChild(cap);
  div.appendChild(a);
  scrollDown();
}
function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ---------- browser view panel ---------- */
function showBrowserPanel() {
  $("browserPanel").classList.remove("hidden");
}
function setScreenshot(url, image) {
  $("shotEmpty").hidden = true;
  const link = $("shotLink");
  link.hidden = false;
  link.href = url;
  $("shotImg").src = image;
  const urlDiv = $("shotUrl");
  urlDiv.hidden = false;
  urlDiv.textContent = url;
  $("shotMeta").textContent = new Date().toLocaleTimeString();
  showBrowserPanel();
}
$("browserToggle").onclick = () => $("browserPanel").classList.toggle("hidden");

/* ---------- session ---------- */
$("newChat").onclick = () => {
  if (!confirm("Start a new chat? This gives you a fresh Linux sandbox.")) return;
  sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).replace(/[^a-z0-9-]/gi, "").slice(0, 36) || String(Date.now());
  localStorage.setItem("cla-session", sessionId);
  history = [];
  saveHistory();
  messagesEl.innerHTML = "";
  currentAgentDiv = null;
  addAgentGreeting();
};
function addAgentGreeting() {
  currentAgentDiv = null;
  setAgentText("👋 Hi! I'm an AI with my own **Linux server** and a **cloud browser**.\n\nTry me:\n- `set up a quick python web app and show it to me`\n- `take a screenshot of github.com`\n- `write a bash script that backs up /workspace and run it`");
  currentAgentDiv = null;
}

/* ---------- SSE chat ---------- */
function setStatus(text) {
  if (!text) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  statusEl.innerHTML = `<span class="dots">${esc(text)}</span>`;
}

async function sendMessage(text) {
  addUser(text);
  history.push({ role: "user", content: text });
  saveHistory();
  inputEl.value = "";
  sendBtn.disabled = true;
  currentAgentDiv = null;
  setStatus("Thinking");

  const headers = { "Content-Type": "application/json" };
  if (authPassword) headers["Authorization"] = "Bearer " + authPassword;

  let res;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId, messages: history.slice(-30) }),
    });
  } catch (e) {
    setStatus("");
    setAgentText("⚠️ Couldn't reach the server. Is the worker deployed and running?");
    currentAgentDiv = null;
    sendBtn.disabled = false;
    return;
  }

  if (res.status === 401) {
    setStatus("");
    const pw = prompt("This agent is password-protected. Enter the app password:");
    if (pw) {
      authPassword = pw;
      sessionStorage.setItem("cla-pw", pw);
      currentAgentDiv = null;
      messagesEl.lastChild && messagesEl.lastChild.classList.contains("user") && messagesEl.lastChild.remove();
      history.pop();
      saveHistory();
      return sendMessage(text);
    }
    setAgentText("🔒 Locked. Set the app password to continue.");
    currentAgentDiv = null;
    sendBtn.disabled = false;
    return;
  }

  if (!res.ok || !res.body) {
    setStatus("");
    setAgentText(`⚠️ Server error (${res.status}). Try again.`);
    currentAgentDiv = null;
    sendBtn.disabled = false;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finalText = "";
  let pendingCard = null;

  const handleEvent = (event, data) => {
    if (event === "status") setStatus(data.text || "");
    else if (event === "tool") { pendingCard = addToolCard(data.name, data.args); setStatus("Running " + data.name + "…"); }
    else if (event === "result") { if (pendingCard) { setToolResult(pendingCard, data.name, data.output); pendingCard = null; } }
    else if (event === "shot") { setScreenshot(data.url, data.image); addShotThumb(data.url, data.image); }
    else if (event === "text") { finalText = data.markdown || ""; setAgentText(finalText); setStatus(""); }
    else if (event === "error") { setStatus(""); ensureAgentDiv().insertAdjacentHTML("beforeend", `<p>⚠️ ${esc(data.message || "Unknown error")}</p>`); }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const em = raw.match(/^event:\s*(\S+)\s*\ndata:\s*([\s\S]*)$/);
        if (em) {
          try { handleEvent(em[1], JSON.parse(em[2])); } catch { /* partial — ignore */ }
        }
      }
    }
  } catch (e) {
    ensureAgentDiv().insertAdjacentHTML("beforeend", "<p>⚠️ Connection dropped.</p>");
  }

  if (finalText) {
    history.push({ role: "assistant", content: finalText });
    saveHistory();
  }
  currentAgentDiv = null;
  setStatus("");
  sendBtn.disabled = false;
  scrollDown();
}

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || sendBtn.disabled) return;
  sendMessage(text);
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

/* ---------- boot ---------- */
(async function boot() {
  try {
    const res = await fetch("/api/health");
    if (res.ok) {
      const h = await res.json();
      $("providerBadge").textContent = "🧠 " + (h.provider === "anthropic" ? "Anthropic" : "Workers AI") + (h.auth ? " · 🔒" : "");
    }
  } catch { $("providerBadge").textContent = "offline"; }

  // restore history view
  for (const m of history) {
    if (m.role === "user") addUser(m.content);
    else { currentAgentDiv = null; setAgentText(m.content); currentAgentDiv = null; }
  }
  if (!history.length) addAgentGreeting();
  scrollDown();
})();
