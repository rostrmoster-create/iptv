// ── Xtream Codes verifier ──────────────────────────────────────────────────
// Exposes window.Verifier.verify(portal, fetchText) -> Promise<info|null>
// `fetchText` is injected so this file has no dependency on the network layer.
(() => {
  function formatExpiry(raw) {
    if (!raw) return 'Unknown';
    const ts = parseInt(raw, 10);
    if (!Number.isFinite(ts)) return String(raw);
    const d = new Date(ts * 1000);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return String(d.getDate()).padStart(2, '0') + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }

  async function verify(p, fetchText, signal) {
    const url = p.url + '/player_api.php?username=' + encodeURIComponent(p.user) +
                '&password=' + encodeURIComponent(p.pass);
    let text;
    try {
      text = await fetchText(url, { timeoutMs: 9000, signal });
    } catch (_) { return null; }
    let root;
    try { root = JSON.parse(text); } catch (_) { return null; }
    if (!root || typeof root !== 'object') return null;
    const info = (root.user_info && typeof root.user_info === 'object') ? root.user_info : root;
    const auth = info.auth != null ? String(info.auth) : '';
    const status = (info.status || '').toString().toLowerCase();
    const ok = auth === '1' || status === 'active' || ('user_info' in root);
    if (!ok) return null;
    return {
      portal: p,
      name: (info.username || p.user) + '',
      expiry: formatExpiry(info.exp_date),
      maxConns: (info.max_connections != null ? info.max_connections : '1') + '',
      activeConns: (info.active_cons != null ? info.active_cons : '0') + '',
    };
  }

  // Connect to a verified portal and pull its full catalogue counts.
  // Returns { categories, channels, vodCount, seriesCount } or null on failure.
  // `categories` sums live + vod + series categories.
  // `channels` is the live stream count (what most people mean by "channels").
  async function fetchCounts(p, fetchText, signal) {
    const base = p.url + '/player_api.php?username=' + encodeURIComponent(p.user) +
                 '&password=' + encodeURIComponent(p.pass) + '&action=';
    const call = async (action) => {
      try {
        const text = await fetchText(base + action, { timeoutMs: 15000, signal });
        const json = JSON.parse(text);
        return Array.isArray(json) ? json.length : 0;
      } catch (_) { return 0; }
    };
    const actions = [
      'get_live_categories',
      'get_vod_categories',
      'get_series_categories',
      'get_live_streams',
      'get_vod_streams',
      'get_series',
    ];
    const out = [];
    for (const a of actions) {
      if (signal && signal.aborted) return null;
      out.push(await call(a));
    }
    const [liveCats, vodCats, seriesCats, liveStreams, vodStreams, seriesList] = out;
    return {
      categories: liveCats + vodCats + seriesCats,
      channels: liveStreams,
      vodCount: vodStreams,
      seriesCount: seriesList,
    };
  }

  window.Verifier = { verify, fetchCounts, formatExpiry };
})();
