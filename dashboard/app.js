// Mission Control Dashboard — Preact + HTM frontend
const { h, render, Component } = preact;
const { useState, useEffect, useRef, useCallback } = preactHooks;
const html = htm.bind(h);

// --- API helpers ---
const api = {
  async get(path) {
    const res = await fetch(`/api${path}`, { credentials: 'include' });
    if (res.status === 401) { window.__setAuth?.(false); return null; }
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(`/api${path}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { window.__setAuth?.(false); return null; }
    return res.json();
  }
};

// --- Channel config ---
const CHANNELS = {
  all: { label: 'All', color: 'gray-400', icon: '📬' },
  email: { label: 'Email', color: 'blue-500', icon: '📧' },
  slack: { label: 'Slack', color: 'purple-500', icon: '💬' },
  gchat: { label: 'Chat', color: 'green-600', icon: '🗨' },
  sms: { label: 'SMS', color: 'green-500', icon: '📱' },
  call: { label: 'Calls', color: 'amber-500', icon: '📞' },
  crm: { label: 'CRM', color: 'orange-500', icon: '📋' },
};

// --- Time formatting ---
function timeAgo(ts) {
  const d = Date.now() - new Date(ts).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  return `${days}d`;
}

// ============================================================
// LOGIN SCREEN
// ============================================================
function LoginScreen() {
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function requestLink() {
    setLoading(true);
    await api.post('/auth/request', {});
    setSent(true);
    setLoading(false);
  }

  return html`
    <div class="flex items-center justify-center h-screen bg-surface">
      <div class="text-center p-8 max-w-sm">
        <div class="text-4xl mb-4">🎯</div>
        <h1 class="text-2xl font-bold mb-2">Mission Control</h1>
        <p class="text-gray-400 mb-6 text-sm">GF Development unified inbox</p>
        ${sent
          ? html`<p class="text-green-400 text-sm">Login link sent to your Slack DM. Click it to continue.</p>`
          : html`<button onclick=${requestLink} disabled=${loading}
              class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-medium disabled:opacity-50 w-full">
              ${loading ? 'Sending...' : 'Send Login Link to Slack'}
            </button>`
        }
      </div>
    </div>
  `;
}

// ============================================================
// CHANNEL SIDEBAR (desktop)
// ============================================================
function Sidebar({ channel, setChannel, stats, starred, setStarred }) {
  const channels = ['all', 'email', 'slack', 'gchat', 'sms', 'call', 'crm'];

  return html`
    <div class="w-60 bg-surface-light h-full flex flex-col border-r border-gray-700/50 hidden md:flex">
      <div class="p-4 border-b border-gray-700/50">
        <h1 class="text-lg font-bold">🎯 Mission Control</h1>
        <p class="text-xs text-gray-500 mt-1">
          ${stats ? `${stats.unread} unread` : 'Loading...'}
          ${stats?.lastSync ? ` · synced ${timeAgo(stats.lastSync)}` : ''}
        </p>
      </div>
      <div class="flex-1 overflow-y-auto p-2">
        ${channels.map(ch => {
          const cfg = CHANNELS[ch];
          const count = ch === 'all' ? stats?.unread : stats?.byChannel?.[ch];
          const isActive = channel === ch && !starred;
          return html`
            <button onclick=${() => { setChannel(ch); setStarred(false); }}
              class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm mb-0.5 transition
                ${isActive ? 'bg-surface-lighter text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-surface'}">
              <span>${cfg.icon}</span>
              <span class="flex-1 text-left">${cfg.label}</span>
              ${count > 0 ? html`<span class="bg-blue-600 text-xs px-1.5 py-0.5 rounded-full">${count}</span>` : null}
            </button>
          `;
        })}
        <div class="border-t border-gray-700/50 my-2"></div>
        <button onclick=${() => { setStarred(true); setChannel('all'); }}
          class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm
            ${starred ? 'bg-surface-lighter text-yellow-400' : 'text-gray-400 hover:text-gray-200 hover:bg-surface'}">
          <span>⭐</span>
          <span class="flex-1 text-left">Starred</span>
          ${stats?.starred > 0 ? html`<span class="bg-yellow-600 text-xs px-1.5 py-0.5 rounded-full">${stats.starred}</span>` : null}
        </button>
      </div>
    </div>
  `;
}

// ============================================================
// MESSAGE CARD
// ============================================================
function MessageCard({ item, isSelected, onClick }) {
  const cfg = CHANNELS[item.channel] || CHANNELS.all;

  return html`
    <div onclick=${onClick}
      class="message-card ${isSelected ? 'selected' : ''} flex items-start gap-3 px-4 py-3 cursor-pointer border-b border-gray-800/50">
      ${!item.read ? html`<div class="unread-dot mt-2"></div>` : html`<div class="w-2"></div>`}
      <div class="channel-dot ${item.channel} mt-2"></div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-medium text-sm truncate ${!item.read ? 'text-white' : 'text-gray-300'}">${item.from}</span>
          <span class="text-xs text-gray-500 flex-shrink-0">${timeAgo(item.timestamp)}</span>
        </div>
        ${item.subject ? html`<div class="text-sm text-gray-300 truncate">${item.subject}</div>` : null}
        <div class="text-xs text-gray-500 truncate mt-0.5">${item.preview}</div>
        <div class="flex items-center gap-2 mt-1">
          ${item.deal ? html`<span class="text-xs bg-surface-lighter px-1.5 py-0.5 rounded text-blue-400">${item.deal}</span>` : null}
          ${item.triage?.action === 'noise' ? html`<span class="text-xs text-gray-600">noise</span>` : null}
        </div>
      </div>
      <button onclick=${(e) => { e.stopPropagation(); }}
        class="star-btn text-lg flex-shrink-0 mt-1 ${item.starred ? 'text-yellow-400' : 'text-gray-600 hover:text-gray-400'}">
        ${item.starred ? '★' : '☆'}
      </button>
    </div>
  `;
}

// ============================================================
// MESSAGE FEED
// ============================================================
function MessageFeed({ items, selectedId, onSelect, loading }) {
  if (loading) {
    return html`
      <div class="p-4 space-y-3">
        ${[1,2,3,4,5].map(() => html`
          <div class="flex gap-3 items-start">
            <div class="skeleton w-2 h-2 rounded-full mt-2"></div>
            <div class="flex-1 space-y-2">
              <div class="skeleton h-4 w-32"></div>
              <div class="skeleton h-3 w-48"></div>
              <div class="skeleton h-3 w-64"></div>
            </div>
          </div>
        `)}
      </div>
    `;
  }

  if (!items || items.length === 0) {
    return html`
      <div class="flex items-center justify-center h-full text-gray-500 text-sm">
        No messages
      </div>
    `;
  }

  return html`
    <div class="overflow-y-auto h-full">
      ${items.map(item => html`
        <${MessageCard}
          key=${item.id}
          item=${item}
          isSelected=${item.id === selectedId}
          onClick=${() => onSelect(item)}
        />
      `)}
    </div>
  `;
}

// ============================================================
// DETAIL PANE (thread + reply composer)
// ============================================================
function DetailPane({ item, onBack, onStar }) {
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!item) return;
    setLoading(true);
    setThread(null);
    setReplyText('');
    setSent(false);

    api.get(`/message/${item.channel}/${item.sourceId}`).then((data) => {
      setThread(data);
      setLoading(false);
    }).catch(() => setLoading(false));

    // Mark as read
    api.post(`/read/${item.id}`, {});
  }, [item?.id]);

  async function sendReply() {
    if (!replyText.trim() || sending) return;
    setSending(true);
    const result = await api.post('/reply', {
      channel: item.channel,
      sourceId: item.sourceId,
      body: replyText.trim(),
    });
    setSending(false);
    if (result?.success) {
      setSent(true);
      setReplyText('');
      setTimeout(() => setSent(false), 3000);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      sendReply();
    }
  }

  if (!item) {
    return html`
      <div class="hidden md:flex flex-1 items-center justify-center text-gray-500 text-sm">
        Select a message to view
      </div>
    `;
  }

  const cfg = CHANNELS[item.channel] || CHANNELS.all;

  return html`
    <div class="flex-1 flex flex-col h-full bg-surface">
      <!-- Header -->
      <div class="flex items-center gap-3 p-4 border-b border-gray-700/50">
        <button onclick=${onBack} class="md:hidden text-gray-400 hover:text-white text-lg">←</button>
        <div class="channel-dot ${item.channel}"></div>
        <div class="flex-1 min-w-0">
          <div class="font-medium truncate">${item.from}</div>
          ${item.subject ? html`<div class="text-sm text-gray-400 truncate">${item.subject}</div>` : null}
        </div>
        <button onclick=${() => onStar(item.id)}
          class="star-btn text-xl ${item.starred ? 'text-yellow-400' : 'text-gray-500'}">
          ${item.starred ? '★' : '☆'}
        </button>
      </div>

      <!-- Thread messages -->
      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        ${loading ? html`
          <div class="space-y-3">
            <div class="skeleton h-4 w-24"></div>
            <div class="skeleton h-20 w-full"></div>
          </div>
        ` : thread?.messages?.map((msg, i) => html`
          <div key=${i} class="bg-surface-light rounded-lg p-4">
            <div class="flex items-center gap-2 mb-2">
              <span class="font-medium text-sm">${msg.from || item.from}</span>
              <span class="text-xs text-gray-500">${msg.timestamp ? timeAgo(msg.timestamp) : ''}</span>
            </div>
            <div class="text-sm text-gray-300 whitespace-pre-wrap">${msg.body || ''}</div>
          </div>
        `)}
      </div>

      <!-- Reply composer -->
      ${item.replyable !== false ? html`
        <div class="reply-bar p-3">
          <div class="text-xs text-gray-500 mb-2">
            Replying via ${cfg.label}
            ${sent ? html` · <span class="text-green-400">Sent</span>` : ''}
          </div>
          <div class="flex gap-2">
            <textarea
              value=${replyText}
              onInput=${(e) => setReplyText(e.target.value)}
              onKeyDown=${handleKeyDown}
              placeholder="Type your reply..."
              rows="2"
              class="flex-1 bg-surface text-sm text-gray-200 p-2 rounded-lg border border-gray-600
                focus:border-blue-500 focus:outline-none resize-none placeholder-gray-600"
            ></textarea>
            <button onclick=${sendReply} disabled=${sending || !replyText.trim()}
              class="bg-blue-600 hover:bg-blue-700 disabled:opacity-30 text-white px-4 rounded-lg
                text-sm font-medium self-end h-10">
              ${sending ? '...' : 'Send'}
            </button>
          </div>
        </div>
      ` : null}
    </div>
  `;
}

// ============================================================
// MOBILE BOTTOM NAV
// ============================================================
function MobileNav({ tab, setTab, stats }) {
  const tabs = [
    { id: 'feed', icon: '📬', label: 'Feed', count: stats?.unread },
    { id: 'starred', icon: '⭐', label: 'Starred', count: stats?.starred },
    { id: 'calendar', icon: '📅', label: 'Calendar' },
    { id: 'pipeline', icon: '📊', label: 'Pipeline' },
  ];

  return html`
    <div class="bottom-nav md:hidden flex items-center justify-around py-2">
      ${tabs.map(t => html`
        <button onclick=${() => setTab(t.id)}
          class="flex flex-col items-center gap-0.5 px-3 py-1 text-xs
            ${tab === t.id ? 'text-blue-400' : 'text-gray-500'}">
          <span class="text-lg relative">
            ${t.icon}
            ${t.count > 0 ? html`
              <span class="absolute -top-1 -right-2 bg-blue-600 text-white text-[9px] w-4 h-4
                rounded-full flex items-center justify-center">${t.count > 99 ? '99' : t.count}</span>
            ` : null}
          </span>
          <span>${t.label}</span>
        </button>
      `)}
    </div>
  `;
}

// ============================================================
// SEARCH BAR
// ============================================================
function SearchBar({ value, onChange }) {
  return html`
    <div class="p-2 border-b border-gray-700/50">
      <input type="text" value=${value} onInput=${(e) => onChange(e.target.value)}
        placeholder="Search messages..."
        class="w-full bg-surface text-sm text-gray-200 px-3 py-2 rounded-lg border border-gray-700
          focus:border-blue-500 focus:outline-none placeholder-gray-600"
      />
    </div>
  `;
}

// ============================================================
// SORT CONTROLS
// ============================================================
function SortBar({ sort, setSort }) {
  return html`
    <div class="flex items-center gap-1 p-2 border-b border-gray-700/50 text-xs">
      ${['newest', 'starred', 'unread'].map(s => html`
        <button onclick=${() => setSort(s)}
          class="px-2 py-1 rounded ${sort === s ? 'bg-surface-lighter text-white' : 'text-gray-500 hover:text-gray-300'}">
          ${s}
        </button>
      `)}
    </div>
  `;
}

// ============================================================
// MAIN APP
// ============================================================
function App() {
  const [auth, setAuth] = useState(null); // null = checking, true/false
  const [channel, setChannel] = useState('all');
  const [starred, setStarred] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [mobileView, setMobileView] = useState('feed'); // feed | detail
  const [mobileTab, setMobileTab] = useState('feed');
  const [loading, setLoading] = useState(true);

  window.__setAuth = setAuth;

  // Check auth on mount
  useEffect(() => {
    api.get('/auth/status').then((data) => {
      setAuth(data?.authenticated ?? false);
    }).catch(() => setAuth(false));
  }, []);

  // Fetch feed
  const fetchFeed = useCallback(async () => {
    const params = new URLSearchParams();
    if (channel !== 'all') params.set('channel', channel);
    if (starred || mobileTab === 'starred') params.set('starred', 'true');
    if (search) params.set('search', search);
    params.set('limit', '100');

    const data = await api.get(`/feed?${params}`);
    if (data) {
      let sorted = data.items || [];
      if (sort === 'starred') sorted = [...sorted].sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
      if (sort === 'unread') sorted = [...sorted].sort((a, b) => (a.read ? 1 : 0) - (b.read ? 1 : 0));
      setItems(sorted);
      setLoading(false);
    }
  }, [channel, starred, search, sort, mobileTab]);

  // Fetch stats
  const fetchStats = useCallback(async () => {
    const data = await api.get('/stats');
    if (data) {
      setStats(data);
      // Update page title with unread count
      document.title = data.unread > 0 ? `(${data.unread}) Mission Control` : 'Mission Control';
    }
  }, []);

  // Auto-refresh
  useEffect(() => {
    if (!auth) return;
    fetchFeed();
    fetchStats();
    const interval = setInterval(() => { fetchFeed(); fetchStats(); }, 60000);
    return () => clearInterval(interval);
  }, [auth, fetchFeed, fetchStats]);

  // SSE for real-time updates
  useEffect(() => {
    if (!auth) return;
    let es;
    try {
      es = new EventSource('/api/stream', { withCredentials: true });
      es.addEventListener('new_message', (e) => {
        const item = JSON.parse(e.data);
        setItems(prev => [item, ...prev]);
        fetchStats();
      });
      es.addEventListener('new_items', (e) => {
        const data = JSON.parse(e.data);
        setItems(prev => [...(data.items || []), ...prev]);
        fetchStats();
      });
      es.addEventListener('item_updated', (e) => {
        const update = JSON.parse(e.data);
        setItems(prev => prev.map(i => i.id === update.id ? { ...i, ...update } : i));
        fetchStats();
      });
      es.onerror = () => { setTimeout(() => fetchFeed(), 5000); };
    } catch {}
    return () => es?.close();
  }, [auth]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const idx = items.findIndex(i => i.id === selectedItem?.id);
      if (e.key === 'j' && idx < items.length - 1) { setSelectedItem(items[idx + 1]); }
      if (e.key === 'k' && idx > 0) { setSelectedItem(items[idx - 1]); }
      if (e.key === 's' && selectedItem) { handleStar(selectedItem.id); }
      if (e.key === '/' && !e.metaKey) { e.preventDefault(); document.querySelector('input[type=text]')?.focus(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, selectedItem]);

  // Star handler
  async function handleStar(id) {
    // Optimistic update
    setItems(prev => prev.map(i => i.id === id ? { ...i, starred: !i.starred } : i));
    if (selectedItem?.id === id) setSelectedItem(prev => ({ ...prev, starred: !prev.starred }));
    await api.post(`/star/${id}`, {});
    fetchStats();
  }

  function selectItem(item) {
    setSelectedItem(item);
    setMobileView('detail');
  }

  // --- Auth check ---
  if (auth === null) return html`<div class="flex items-center justify-center h-screen text-gray-500">Loading...</div>`;
  if (!auth) return html`<${LoginScreen} />`;

  // --- Mobile layout ---
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  if (isMobile) {
    return html`
      <div class="flex flex-col h-screen">
        ${mobileView === 'detail' && selectedItem ? html`
          <${DetailPane}
            item=${selectedItem}
            onBack=${() => setMobileView('feed')}
            onStar=${handleStar}
          />
        ` : html`
          <div class="flex-1 flex flex-col overflow-hidden">
            <${SearchBar} value=${search} onChange=${setSearch} />
            <${SortBar} sort=${sort} setSort=${setSort} />
            <div class="flex-1 overflow-hidden">
              <${MessageFeed}
                items=${items}
                selectedId=${selectedItem?.id}
                onSelect=${selectItem}
                loading=${loading}
              />
            </div>
          </div>
        `}
        <${MobileNav} tab=${mobileTab} setTab=${(t) => { setMobileTab(t); setMobileView('feed'); if (t === 'starred') setStarred(true); else setStarred(false); }} stats=${stats} />
      </div>
    `;
  }

  // --- Desktop layout ---
  return html`
    <div class="flex h-screen">
      <${Sidebar}
        channel=${channel}
        setChannel=${setChannel}
        stats=${stats}
        starred=${starred}
        setStarred=${setStarred}
      />
      <div class="flex-1 flex flex-col border-r border-gray-700/50" style="max-width: 420px; min-width: 320px;">
        <${SearchBar} value=${search} onChange=${setSearch} />
        <${SortBar} sort=${sort} setSort=${setSort} />
        <div class="flex-1 overflow-hidden">
          <${MessageFeed}
            items=${items}
            selectedId=${selectedItem?.id}
            onSelect=${selectItem}
            loading=${loading}
          />
        </div>
      </div>
      <${DetailPane}
        item=${selectedItem}
        onBack=${() => setSelectedItem(null)}
        onStar=${handleStar}
      />
    </div>
  `;
}

// --- Mount ---
render(html`<${App} />`, document.getElementById('app'));
