const state = { user: null, partnerName: "", messages: new Map(), hasMore: false, polling: null };

const elements = {
  loginView: document.querySelector("#login-view"), appView: document.querySelector("#app-view"),
  loginForm: document.querySelector("#login-form"), loginButton: document.querySelector("#login-button"),
  loginError: document.querySelector("#login-error"), username: document.querySelector("#username"),
  password: document.querySelector("#password"), passwordToggle: document.querySelector("#password-toggle"),
  coupleNames: document.querySelector("#couple-names"), logoutButton: document.querySelector("#logout-button"),
  status: document.querySelector("#connection-status"), loadMore: document.querySelector("#load-more"),
  emptyState: document.querySelector("#empty-state"), list: document.querySelector("#message-list"),
  composer: document.querySelector("#composer"), input: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"), count: document.querySelector("#character-count"),
  toast: document.querySelector("#toast"),
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  if (response.status === 401 && path !== "/api/login") {
    showLogin();
    throw new Error("登录已失效");
  }
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || "请求失败，请稍后重试");
  return data;
}

function showLogin() {
  clearInterval(state.polling);
  state.polling = null;
  state.messages.clear();
  state.user = null;
  elements.appView.hidden = true;
  elements.loginView.hidden = false;
  elements.password.value = "";
  elements.username.focus();
}

function showApp(session) {
  state.user = session.user;
  state.partnerName = session.partnerName;
  elements.coupleNames.textContent = `${session.user.name} · ${session.partnerName}`;
  elements.loginView.hidden = true;
  elements.appView.hidden = false;
}

function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(date);
}

function renderMessages() {
  const messages = [...state.messages.values()].sort((a, b) => a.seq - b.seq);
  const fragment = document.createDocumentFragment();
  let previousDay = "";

  for (const message of messages) {
    const date = new Date(message.createdAt);
    const day = date.toDateString();
    if (day !== previousDay) {
      const divider = document.createElement("div");
      divider.className = "day-divider";
      divider.textContent = dayLabel(date);
      fragment.append(divider);
      previousDay = day;
    }

    const row = document.createElement("article");
    row.className = `message-row${message.mine ? " mine" : ""}`;
    row.dataset.id = message.id;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const author = document.createElement("span");
    author.textContent = message.mine ? "我" : message.authorName;
    const time = document.createElement("time");
    time.dateTime = message.createdAt;
    time.textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
    meta.append(author, time);

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    const content = document.createElement("p");
    content.className = "message-content";
    content.textContent = message.content;
    bubble.append(content);
    if (message.mine) {
      const remove = document.createElement("button");
      remove.className = "delete-message";
      remove.type = "button";
      remove.textContent = "删除";
      remove.addEventListener("click", () => removeMessage(message));
      bubble.append(remove);
    }
    row.append(meta, bubble);
    fragment.append(row);
  }

  elements.list.replaceChildren(fragment);
  elements.emptyState.hidden = messages.length > 0;
  elements.loadMore.hidden = !state.hasMore;
}

function mergeMessages(messages) {
  for (const message of messages) state.messages.set(message.id, message);
  renderMessages();
}

async function loadInitial() {
  const data = await request("/api/messages");
  state.hasMore = data.hasMore;
  mergeMessages(data.messages);
  requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
}

async function loadOlder() {
  const first = [...state.messages.values()].sort((a, b) => a.seq - b.seq)[0];
  if (!first) return;
  elements.loadMore.disabled = true;
  const oldHeight = document.documentElement.scrollHeight;
  try {
    const data = await request(`/api/messages?before=${first.seq}`);
    state.hasMore = data.hasMore;
    mergeMessages(data.messages);
    requestAnimationFrame(() => window.scrollBy(0, document.documentElement.scrollHeight - oldHeight));
  } catch (error) { showToast(error.message); }
  finally { elements.loadMore.disabled = false; }
}

async function pollMessages() {
  if (document.hidden || !state.user) return;
  const messages = [...state.messages.values()];
  const latest = messages.length ? Math.max(...messages.map((message) => message.seq)) : 0;
  try {
    const data = await request(`/api/messages?after=${latest}`);
    if (data.messages.length) {
      const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 140;
      mergeMessages(data.messages);
      if (nearBottom) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
    }
    setConnection(true);
  } catch { setConnection(false); }
}

function setConnection(connected) {
  elements.status.classList.toggle("offline", !connected);
  elements.status.querySelector("b").textContent = connected ? "已连接" : "连接中断";
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("visible"), 2200);
}

async function removeMessage(message) {
  if (!window.confirm("删除这条密语？")) return;
  try {
    await request(`/api/messages/${encodeURIComponent(message.id)}`, { method: "DELETE" });
    state.messages.delete(message.id);
    renderMessages();
  } catch (error) { showToast(error.message); }
}

function resizeComposer() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 130)}px`;
  const length = elements.input.value.length;
  elements.count.textContent = length > 1700 ? `${length}/2000` : "";
  elements.sendButton.disabled = !elements.input.value.trim();
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.loginError.textContent = "";
  elements.loginButton.disabled = true;
  elements.loginButton.textContent = "正在进入…";
  try {
    await request("/api/login", { method: "POST", body: JSON.stringify({ username: elements.username.value, password: elements.password.value }) });
    const session = await request("/api/session");
    showApp(session);
    await loadInitial();
    state.polling = setInterval(pollMessages, 5000);
  } catch (error) { elements.loginError.textContent = error.message; }
  finally { elements.loginButton.disabled = false; elements.loginButton.textContent = "进入空间"; }
});

elements.passwordToggle.addEventListener("click", () => {
  const visible = elements.password.type === "text";
  elements.password.type = visible ? "password" : "text";
  elements.passwordToggle.textContent = visible ? "显示" : "隐藏";
});

elements.logoutButton.addEventListener("click", async () => {
  try { await request("/api/logout", { method: "POST" }); } catch { /* Local state still logs out. */ }
  showLogin();
});

elements.loadMore.addEventListener("click", loadOlder);
elements.input.addEventListener("input", resizeComposer);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = elements.input.value.trim();
  if (!content) return;
  elements.sendButton.disabled = true;
  try {
    const data = await request("/api/messages", { method: "POST", body: JSON.stringify({ content }) });
    state.messages.set(data.message.id, data.message);
    elements.input.value = "";
    resizeComposer();
    renderMessages();
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
  } catch (error) { showToast(error.message); resizeComposer(); }
});

async function initialize() {
  resizeComposer();
  try {
    const session = await request("/api/session");
    showApp(session);
    await loadInitial();
    state.polling = setInterval(pollMessages, 5000);
  } catch { showLogin(); }
}

initialize();
