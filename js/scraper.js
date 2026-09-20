// ── Reddit scraper + portal extractor + UI orchestration ──────────────────
// Depends on window.PasteSh (pasteSh.js) and window.Verifier (verifier.js).
(() => {
  const $ = (id) => document.getElementById(id);
  const $status = $('status');
  const $log = null;
  const $cards = $('cards');

  const setStatus = (msg, cls = '') => {
    $status.textContent = msg;
    $status.className = 'status ' + cls;
  };
  const log = (..._parts) => { /* activity log removed */ };
  const esc = (s) => String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cssEscape = (s) => (window.CSS && CSS.escape)
    ? CSS.escape(s)
    : String(s).replace(/["\\]/g, '\\$&');

  // ── settings ─────────────────────────────────────────────────────────────
  const BATCH = 5;                        // how many to add per click
  const VERIFY_PARALLEL = 4;
  const PASTES_PER_POST = 4;
  const MAX_PAGES_PER_RUN = 5;            // safety cap per click on reddit pagination

  // ── persistent state across button clicks ────────────────────────────────
  const candidatesMap = new Map();   // key -> {url, user, pass}
  const triedSet = new Set();        // candidate keys that were attempted
  const verifiedMap = new Map();     // key -> verified info
  let redditAfter = null;            // current pagination cursor
  let redditExhausted = false;
  let cancelled = false;

  // ── Reddit OAuth2 (ported from PlayTorrio Native Android) ──────────────
  // Reddit killed unauthenticated .json access in mid-2026. We now use
  // OAuth2 "installed_client" grants with open-source Reddit app client IDs
  // for anonymous bearer tokens (100 posts/page). Falls back to RSS.
  const CATALOG_SUBS = ['IPTV_ZONENEW', 'FreeIPTV', 'iptvguru', 'IPTVfree'];
  const OAUTH_UA = 'PlayTorrio/1.3.6 (by /u/PlayTorrioApp)';
  const OAUTH_CLIENT_IDS = [
    'ohXpoqrZYub1kg',  // Slide for Reddit
    'NOe2iKrPPzwscA',  // RedReader
    'JrPdG8Z6dkWNxA',  // Stealth
  ];
  let oauthToken = null;
  let oauthTokenExpiry = 0;
  let oauthClientIdx = 0;

  // Serial queue + abort controller for channel-count fetches so we never
  // have multiple count jobs spamming proxies in parallel.
  let countsCtrl = new AbortController();
  let countsChain = Promise.resolve();
  function queueCounts(task) {
    countsChain = countsChain.then(() => task(countsCtrl.signal)).catch(() => {});
    return countsChain;
  }
  function cancelCounts() {
    countsCtrl.abort();
    countsCtrl = new AbortController();
    countsChain = Promise.resolve();
  }

  const portalKey = (p) => p.url + '|' + p.user + '|' + p.pass;

  // ── localStorage persistence ─────────────────────────────────────────────
  // Verified portals survive page reloads. Stored as a plain JSON array of
  // the same `verified` shape we render from (portal + name + expiry + conns).
  const STORAGE_KEY = 'iptv.savedPortals.v1';
  const SEEN_PASTES_KEY = 'iptv.seenPastes.v1';
  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function persistVerified() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...verifiedMap.values()]));
    } catch (e) {
      log('save failed:', e.message || e);
    }
  }

  // Track every paste URL we've ever fetched so we never re-scrape one.
  // Persisted so a fresh page load still skips known pastes.
  const seenPastes = new Set();
  (function loadSeenPastes() {
    try {
      const raw = localStorage.getItem(SEEN_PASTES_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) arr.forEach(u => seenPastes.add(u));
    } catch (_) {}
  })();
  function persistSeenPastes() {
    try {
      // Cap at 5000 entries to keep storage bounded; oldest first out.
      const arr = [...seenPastes];
      const trimmed = arr.length > 5000 ? arr.slice(arr.length - 5000) : arr;
      localStorage.setItem(SEEN_PASTES_KEY, JSON.stringify(trimmed));
    } catch (_) {}
  }
  // Normalise paste URLs so trivial variants collapse to one key.
  function pasteKey(u) {
    let s = String(u).trim();
    // Keep paste.sh fragments (they're decryption keys), strip others.
    if (!s.includes('paste.sh/')) {
      const h = s.indexOf('#');
      if (h >= 0) s = s.slice(0, h);
    }
    return s.replace(/\/+$/, '').toLowerCase();
  }

  const td = new TextDecoder('utf-8', { fatal: false });
  const b64ToBytes = window.PasteSh.b64ToBytes;
  const short = (u) => u.split('?')[0].replace(/^https?:\/\//, '');

  // ── CORS-bypassed fetch (race + per-proxy circuit breaker) ────────────
  // Public proxies are flaky. We race a few in parallel; first non-empty
  // 2xx wins. Per-proxy fail counters trigger a cooldown so a dead proxy
  // doesn't get hammered every wave (Console pollution + wasted budget).
  //
  // Special case: if the proxy returns 502/503/504 it usually means the
  // *upstream* (the IPTV portal) is unreachable — re-trying through other
  // proxies will hit the same brick wall. We early-abort the whole call.
  // Custom Cloudflare Worker proxy (primary) — set your deployed URL here.
  // Falls back to public CORS proxies if the worker is unreachable.
  const WORKER_PROXY_URL = 'https://iptv-proxy.aymanisthedude1.workers.dev';  // e.g. 'https://iptv-proxy.your-subdomain.workers.dev'
  const PROXIES = [
    // Worker first (when configured)
    ...(WORKER_PROXY_URL ? [{ name: 'worker', build: (u) => WORKER_PROXY_URL + '/?url=' + encodeURIComponent(u) }] : []),
    { name: 'corsfix',    build: (u) => 'https://proxy.corsfix.com/?' + encodeURIComponent(u) },
    { name: 'codetabs',   build: (u) => 'https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u) },
    { name: 'allorigins', build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
    { name: 'corsproxy',  build: (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u) },
    { name: 'corslol',    build: (u) => 'https://api.cors.lol/?url=' + encodeURIComponent(u) },
  ];
  const FAIL_THRESHOLD = 2;       // consecutive fails before cooldown
  const COOLDOWN_MS    = 45_000;  // how long a bad proxy sits out
  const RATE_COOLDOWN_MS = 90_000; // longer cooldown on 429
  for (const p of PROXIES) { p.fails = 0; p.cooldownUntil = 0; }
  function pickProxy(idx) {
    const now = Date.now();
    for (let i = 0; i < PROXIES.length; i++) {
      const p = PROXIES[(idx + i) % PROXIES.length];
      if (p.cooldownUntil <= now) return p;
    }
    return null;
  }
  function noteSuccess(p) { p.fails = 0; p.cooldownUntil = 0; }
  function noteFailure(p, status) {
    p.fails++;
    if (status === 429) {
      p.cooldownUntil = Date.now() + RATE_COOLDOWN_MS;
      p.fails = 0;
    } else if (p.fails >= FAIL_THRESHOLD) {
      p.cooldownUntil = Date.now() + COOLDOWN_MS;
      p.fails = 0;
    }
  }

  const WAVE_MS = 500;       // launch a new attempt every 500ms
  const INITIAL_BURST = 1;   // fire one per healthy proxy at t=0
  const MAX_INFLIGHT = 3;    // small cap → less console spam, less load

  function looksValidBody(text) {
    if (!text) return false;
    if (/^\s*\{[^]*"error"/.test(text) && text.length < 400) return false;
    return true;
  }

  // Resolves with { ok, text, status, deadUpstream }.
  function fetchOneProxy(proxiedUrl, timeoutMs, signal) {
    return new Promise((resolve) => {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      fetch(proxiedUrl, { credentials: 'omit', cache: 'no-store', signal: ctrl.signal })
        .then(async r => {
          clearTimeout(t);
          // 5xx from a CORS proxy almost always means the upstream is
          // dead/unreachable → no point trying other proxies.
          const deadUpstream = r.status >= 502 && r.status <= 504;
          if (!r.ok) return resolve({ ok: false, status: r.status, deadUpstream });
          const text = await r.text();
          if (!looksValidBody(text)) return resolve({ ok: false, status: r.status });
          resolve({ ok: true, text, status: r.status });
        })
        .catch(() => { clearTimeout(t); resolve({ ok: false, status: 0 }); });
    });
  }

  function fetchText(url, { timeoutMs = 12000, signal: extSignal } = {}) {
    return new Promise((resolve, reject) => {
      const masterCtrl = new AbortController();
      let settled = false;
      let inflight = 0;
      let waveIdx = 0;
      let timer = null;
      let deadUpstreamHits = 0;

      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        masterCtrl.abort();
        if (extSignal) extSignal.removeEventListener('abort', onExtAbort);
        fn(val);
      };
      const onExtAbort = () => finish(reject, new Error('aborted'));
      if (extSignal) {
        if (extSignal.aborted) return finish(reject, new Error('aborted'));
        extSignal.addEventListener('abort', onExtAbort, { once: true });
      }

      const launch = () => {
        if (settled) return;
        if (cancelled) return finish(reject, new Error('cancelled'));
        if (inflight >= MAX_INFLIGHT) return;
        const proxy = pickProxy(waveIdx);
        waveIdx++;
        if (!proxy) return; // every proxy on cooldown — wait it out
        inflight++;
        fetchOneProxy(proxy.build(url), timeoutMs, masterCtrl.signal)
          .then(res => {
            if (res.ok) { noteSuccess(proxy); finish(resolve, res.text); return; }
            noteFailure(proxy, res.status);
            // If two different proxies both say "upstream dead", give up.
            if (res.deadUpstream && ++deadUpstreamHits >= 2) {
              finish(reject, new Error('upstream unreachable'));
            }
          })
          .finally(() => { inflight--; });
      };

      const healthy = PROXIES.filter(p => p.cooldownUntil <= Date.now()).length || 1;
      for (let burst = 0; burst < INITIAL_BURST; burst++) {
        for (let i = 0; i < healthy; i++) launch();
      }
      timer = setInterval(launch, WAVE_MS);
    });
  }

  // ── Portal extraction (smart regex, ported from Dart) ────────────────────
  const RE_URL_PARAM = /(https?:\/\/[^?\s"'<]+)\?(?:[^\s"'<]*?&)?(?:username|user)=([^&\s"'<]+)\s*&(?:password|pass)=([^&\s"'<]+)/gi;
  const RE_LABEL = /(?:Portal|Host(?:\s*URL)?|H[ᴏo]s[ᴛt]|Panel|Real|URL|🔗|🌍|🌐)\W*?(https?:\/\/[^<\s"']+)[\s\S]{1,500}?(?:Username|Usu[áa]rio|Usuario|User|Us[ᴇe]r|Us[ᴜu][ᴀa]r[ɪi][ᴏo]|👤)\W*?([^\s|<"'\n]+)[\s\S]{1,200}?(?:Password|Senha|Contrase[ñn]a|Pass|P[ᴀa]ss|S[ᴇe]nh[ᴀa]|🔑)\W*?([^\s|<"'\n]+)/gi;
  const RE_B64_HTTP = /aHR0c[A-Za-z0-9+/=]{10,}/g;
  const PASTE_DOMAINS = ['paste.sh','pastebin.com','justpaste.it','controlc.com','pastes.dev','text.is','rentry.co'];
  const RE_PASTE_URL = new RegExp(
    'https?:\\/\\/(?:' + PASTE_DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|') + ')\\/[A-Za-z0-9#_=\\-]+',
    'gi');
  const JUNK_TOKENS = ['type=m3u','output=ts','password=','username=','password','username'];

  function isJunkCode(text) {
    const markers = ['Array.isArray','prototype.','function(','var ','const ','let ','return!','void ','.message}','window.','document.'];
    let h = 0;
    for (const m of markers) { if (text.includes(m)) h++; if (h >= 2) return true; }
    return false;
  }
  function cleanPortalUrl(raw) {
    let c = raw.replace(/\s+/g, '');
    const q = c.indexOf('?'); if (q >= 0) c = c.slice(0, q);
    if (c.includes('@')) c = 'http://' + c.slice(c.lastIndexOf('@') + 1);
    c = c.replace(/\/(?:get|live|portal|c|index|playlist|player_api|xmltv|index\.php|portal\.php)\.php$/i, '');
    while (c.endsWith('/')) c = c.slice(0, -1);
    if (!/^https?:/i.test(c)) c = 'http://' + c;
    return c;
  }
  function cleanCred(raw) {
    let s = raw;
    while (s.startsWith('=')) s = s.slice(1);
    return (s.split(/[ \n&?]/)[0] || '').trim();
  }
  function finalize(acc, rawUrl, rawUser, rawPass) {
    const url = cleanPortalUrl(rawUrl);
    const user = cleanCred(rawUser);
    const pass = cleanCred(rawPass);
    if (!url || user.length < 3 || pass.length < 3) return;
    if (user.includes('http') || pass.includes('http')) return;
    const lu = user.toLowerCase(), lp = pass.toLowerCase();
    for (const j of JUNK_TOKENS) if (lu.includes(j) || lp.includes(j)) return;
    const key = url + '|' + user + '|' + pass;
    if (!acc.has(key)) acc.set(key, { url, user, pass });
  }
  function extractPortals(rawText) {
    if (!rawText || rawText.length < 15 || isJunkCode(rawText)) return [];
    const cleaned = rawText
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/<(?:p|br|div|li|h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    const acc = new Map();
    for (const m of cleaned.matchAll(RE_URL_PARAM)) finalize(acc, m[1], m[2], m[3]);
    for (const m of cleaned.matchAll(RE_LABEL))     finalize(acc, m[1], m[2], m[3]);
    return [...acc.values()];
  }

  // ── Paste fetcher (handles per-site quirks) ──────────────────────────────
  function lastSegment(url) {
    let s = url; const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h);
    const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q);
    const sl = s.lastIndexOf('/'); return sl >= 0 ? s.slice(sl + 1) : s;
  }
  async function fetchPaste(url) {
    try {
      if (url.includes('paste.sh/') && url.includes('#'))
        return await window.PasteSh.decrypt(url, fetchText);
      if (url.includes('pastebin.com/') && !url.includes('/raw/'))
        return await fetchText('https://pastebin.com/raw/' + lastSegment(url));
      if (url.includes('pastes.dev/'))
        return await fetchText('https://api.pastes.dev/' + lastSegment(url));
      if (url.includes('rentry.co/') && !url.includes('/raw'))
        return await fetchText('https://rentry.co/' + lastSegment(url) + '/raw');
      return await fetchText(url);
    } catch (e) {
      log('  paste failed:', short(url), '→', e.message || e);
      return null;
    }
  }
  function isPasteSite(u) { return PASTE_DOMAINS.some(d => u.includes(d)); }


  // ── Reddit OAuth2 + RSS with multi-subreddit rotation ─────────────────
  // Ported from PlayTorrio Native Android's iptv_network.dart.
  // Reddit killed unauthenticated .json in mid-2026. We use OAuth2
  // "installed_client" grants with open-source client IDs for anonymous
  // bearer tokens (100 posts/page). Falls back to RSS (25 posts/page).

  function decodeXmlEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#32;/g, ' ');
  }

  // ── OAuth2 token management ──────────────────────────────────────────────
  async function getOAuthToken() {
    if (oauthToken && Date.now() < oauthTokenExpiry) return oauthToken;
    // Use worker proxy first (if configured), then CORS proxies.
    const proxies = [
      ...(WORKER_PROXY_URL ? [(u) => WORKER_PROXY_URL + '/?url=' + encodeURIComponent(u)] : []),
      (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
      (u) => 'https://api.cors.lol/?url=' + encodeURIComponent(u),
      (u) => 'https://proxy.corsfix.com/?' + encodeURIComponent(u),
    ];
    const tokenUrl = 'https://www.reddit.com/api/v1/access_token';
    const body = 'grant_type=https%3A%2F%2Foauth.reddit.com%2Fgrants%2Finstalled_client&device_id=DO_NOT_TRACK_THIS_DEVICE';
    for (let i = 0; i < OAUTH_CLIENT_IDS.length; i++) {
      const idx = (oauthClientIdx + i) % OAUTH_CLIENT_IDS.length;
      const clientId = OAUTH_CLIENT_IDS[idx];
      for (const build of proxies) {
        if (cancelled) return null;
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 8000);
          const resp = await fetch(build(tokenUrl), {
            method: 'POST',
            headers: {
              'User-Agent': OAUTH_UA,
              'Authorization': 'Basic ' + btoa(clientId + ':'),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
            credentials: 'omit',
            cache: 'no-store',
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!resp.ok) continue;
          const text = await resp.text();
          if (!text || !text.trim().startsWith('{')) continue;
          const data = JSON.parse(text);
          if (data.access_token) {
            oauthToken = data.access_token;
            oauthTokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
            oauthClientIdx = idx;
            log('OAuth token via client #' + idx);
            return oauthToken;
          }
        } catch (_) {}
      }
    }
    oauthClientIdx = (oauthClientIdx + 1) % OAUTH_CLIENT_IDS.length;
    oauthToken = null;
    oauthTokenExpiry = 0;
    log('OAuth token failed — falling back to RSS');
    return null;
  }

  // ── OAuth2-based subreddit fetch (100 posts/page) ────────────────────────
  async function fetchOAuthPage(sub, after) {
    const token = await getOAuthToken();
    if (!token) return null;
    const base = 'https://oauth.reddit.com/r/' + sub + '/new?limit=100&sort=new&raw_json=1';
    const url = after ? base + '&after=' + encodeURIComponent(after) : base;
    log('OAuth r/' + sub + (after ? ' after=' + after : ''));
    const proxies = [
      ...(WORKER_PROXY_URL ? [(u) => WORKER_PROXY_URL + '/?url=' + encodeURIComponent(u)] : []),
      (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
      (u) => 'https://api.cors.lol/?url=' + encodeURIComponent(u),
      (u) => 'https://proxy.corsfix.com/?' + encodeURIComponent(u),
    ];
    for (const build of proxies) {
      if (cancelled) return null;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        const resp = await fetch(build(url), {
          method: 'GET',
          headers: {
            'User-Agent': OAUTH_UA,
            'Authorization': 'Bearer ' + token,
          },
          credentials: 'omit',
          cache: 'no-store',
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (resp.status === 401 || resp.status === 403) {
          oauthToken = null;
          oauthTokenExpiry = 0;
          return null;
        }
        if (!resp.ok) continue;
        const text = await resp.text();
        if (!text) continue;
        const t = text.trimStart();
        if (!t.startsWith('{') && !t.startsWith('[')) continue;
        const root = JSON.parse(text);
        const data = (root && root.data) || {};
        const posts = data.children || [];
        const nextRaw = data.after;
        const hasMore = nextRaw && String(nextRaw) !== 'null' && nextRaw !== '';
        log('  OAuth OK: ' + posts.length + ' posts');
        return { posts, next: hasMore ? String(nextRaw) : null };
      } catch (_) { continue; }
    }
    return null;
  }

  // ── RSS fallback (25 posts/page) ─────────────────────────────────────────
  async function fetchRssPage(sub, after) {
    const base = 'https://www.reddit.com/r/' + sub + '/new/.rss?limit=25';
    const url = after ? base + '&after=' + encodeURIComponent(after) : base;
    log('RSS r/' + sub + (after ? ' after=' + after : ''));
    let rssBody;
    try {
      rssBody = await fetchText(url, { timeoutMs: 15000 });
    } catch (_) { return null; }
    if (!rssBody || !rssBody.includes('<entry>')) return null;
    const entries = [...rssBody.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    const postIds = [...rssBody.matchAll(/<id>(t3_[^<]+)<\/id>/g)].map(m => m[1]);
    const lastPostId = postIds.length > 0 ? postIds[postIds.length - 1] : null;
    const hasMore = lastPostId && entries.length >= 20;
    log('  RSS OK: ' + entries.length + ' entries');
    // Convert RSS entries to same {data:{title,selftext}} shape as JSON posts.
    const posts = entries.map(entry => {
      const text = entry[1];
      const titleM = /<title[^>]*>([\s\S]*?)<\/title>/.exec(text);
      const contentM = /<content[^>]*>([\s\S]*?)<\/content>/.exec(text);
      const title = decodeXmlEntities(titleM ? titleM[1] : '');
      const rawContent = decodeXmlEntities(contentM ? contentM[1] : '');
      const selftext = rawContent
        .replace(/<(?:p|br|div|li|h\d)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { data: { title, selftext } };
    });
    return { posts, next: hasMore ? lastPostId : null };
  }

  // ── Multi-subreddit fetch: OAuth2 → RSS fallback ─────────────────────────
  // Cursor format: '<subIdx>:<redditAfter>' or null for first page.
  async function fetchSubredditPage(after) {
    let subIdx = 0, cursor = null;
    if (after) {
      const c = after.indexOf(':');
      if (c >= 0) {
        subIdx = parseInt(after.slice(0, c), 10) || 0;
        cursor = after.slice(c + 1) || null;
      } else {
        cursor = after; // legacy single-cursor format
      }
    }
    if (subIdx >= CATALOG_SUBS.length) return { posts: [], next: null };
    const sub = CATALOG_SUBS[subIdx];

    // Try OAuth2 first, then RSS.
    let result = await fetchOAuthPage(sub, cursor);
    if (!result) {
      log('OAuth failed for r/' + sub + ' → RSS fallback');
      result = await fetchRssPage(sub, cursor);
    }

    // Both failed → advance to next subreddit.
    if (!result || result.posts.length === 0) {
      if (subIdx + 1 < CATALOG_SUBS.length) {
        return { posts: [], next: (subIdx + 1) + ':' };
      }
      return { posts: [], next: null };
    }

    // Build composite next cursor.
    let next;
    if (result.next) {
      next = subIdx + ':' + result.next;
    } else if (subIdx + 1 < CATALOG_SUBS.length) {
      next = (subIdx + 1) + ':';
    } else {
      next = null;
    }
    return { posts: result.posts, next };
  }

  // ── Verifier with bounded concurrency. Marks each candidate as tried so a
  // ── later run won't re-attempt it.
  async function verifyUntil(candidates, need, onAlive) {
    let nextIdx = 0, alive = 0, stopped = false;
    const batchCtrl = new AbortController();
    const stopAll = () => { stopped = true; batchCtrl.abort(); };
    async function worker() {
      while (!stopped && !cancelled) {
        if (alive >= need) { stopAll(); return; }
        const idx = nextIdx++;
        if (idx >= candidates.length) return;
        const p = candidates[idx];
        triedSet.add(portalKey(p));
        log('  verify', short(p.url), 'as', p.user);
        const v = await window.Verifier.verify(p, fetchText, batchCtrl.signal);
        if (stopped || cancelled) return;
        if (v && alive < need) {
          alive++;
          onAlive(v);
          if (alive >= need) { stopAll(); return; }
        }
      }
    }
    const workers = [];
    const n = Math.min(VERIFY_PARALLEL, candidates.length);
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
    return alive;
  }

  // ── Card rendering ──────────────────────────────────────────────────────
  function field(label, value) {
    const v = String(value);
    return '<div class="field">' +
      '<div class="field-label">' + esc(label) + '</div>' +
      '<div class="field-value">' +
        '<span class="field-text">' + esc(v) + '</span>' +
        '<button class="copy" type="button" title="Copy" aria-label="Copy ' +
          esc(label) + '" data-copy="' + esc(v) + '">Copy</button>' +
      '</div>' +
      '</div>';
  }

  function countsHtml(v) {
    if (v && v.counts) {
      const c = v.counts;
      return '<div class="counts">' +
        '<div>Categories <b>' + esc(c.categories) + '</b></div>' +
        '<div>Channels <b>' + esc(c.channels) + '</b></div>' +
        '<div>VOD <b>' + esc(c.vodCount) + '</b></div>' +
        '<div>Series <b>' + esc(c.seriesCount) + '</b></div>' +
      '</div>';
    }
    if (v && v.countsLoading) {
      return '<div class="counts loading">Fetching channel count…</div>';
    }
    return '';
  }

  function renderCard(v, num) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.key = portalKey(v.portal);
    card.innerHTML =
      '<div class="card-head">' +
        '<span class="badge">#' + num + '</span>' +
        '<span class="pill">' + esc(v.expiry) + '</span>' +
        '<button class="del-btn" type="button" title="Remove this portal" aria-label="Remove">' +
          window.Icons.close() +
        '</button>' +
      '</div>' +
      field('Portal URL', v.portal.url) +
      field('Username',   v.portal.user) +
      field('Password',   v.portal.pass) +
      '<div class="meta">' +
        '<div>Connections <b>' + esc(v.activeConns + ' / ' + v.maxConns) + '</b></div>' +
      '</div>' +
      '<div class="counts-slot">' + countsHtml(v) + '</div>';
    card.querySelector('button.del-btn').addEventListener('click', () => {
      const k = card.dataset.key;
      if (!confirm('Remove this portal from your saved list?')) return;
      verifiedMap.delete(k);
      persistVerified();
      card.remove();
      renumberCards();
      if (verifiedMap.size === 0) {
        setStatus('All portals removed.', '');
        $('more').disabled = true;
        $('clear').disabled = true;
      } else {
        setStatus(verifiedMap.size + ' saved portal(s).', 'ok');
      }
    });
    card.querySelectorAll('button.copy').forEach(btn => {
      btn.addEventListener('click', async () => {
        const text = btn.getAttribute('data-copy') || '';
        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          // Fallback for non-secure contexts
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (_) {}
          document.body.removeChild(ta);
        }
        const old = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = old;
          btn.classList.remove('copied');
        }, 1100);
      });
    });
    $cards.appendChild(card);
  }

  function renumberCards() {
    [...$cards.querySelectorAll('.card .badge')].forEach((b, i) => {
      b.textContent = '#' + (i + 1);
    });
  }

  // Stream of candidates from one post (no titles or sources surfaced).
  async function extractCandidatesFromPost(pd, pageLabel, idx, total) {
    const title = pd.title || '';
    const body = (title + ' ' + (pd.selftext || '')).trim();
    if (!body) return [];
    setStatus('Searching for working portals… ' +
      verifiedMap.size + ' alive so far');

    const before = candidatesMap.size;
    function pushCandidate(p) {
      const k = portalKey(p);
      if (!candidatesMap.has(k)) candidatesMap.set(k, p);
    }

    extractPortals(body).forEach(pushCandidate);

    const deepLinks = new Set();
    for (const m of body.matchAll(RE_B64_HTTP)) {
      try {
        const dec = td.decode(b64ToBytes(m[0]));
        if (dec.startsWith('http') && isPasteSite(dec)) deepLinks.add(dec);
        else if (!dec.startsWith('http') && dec.includes(':'))
          extractPortals(dec).forEach(pushCandidate);
      } catch (_) {}
    }
    for (const m of body.matchAll(RE_PASTE_URL)) deepLinks.add(m[0]);

    let dl = 0;
    for (const link of deepLinks) {
      if (dl >= PASTES_PER_POST || cancelled) break;
      const key = pasteKey(link);
      if (seenPastes.has(key)) {
        log('  paste: skip (already seen)', short(link));
        continue;
      }
      seenPastes.add(key);
      dl++;
      log('  paste:', short(link));
      const text = await fetchPaste(link);
      if (!text) continue;
      const found = extractPortals(text);
      log('    →', text.length, 'chars,', found.length, 'portals');
      found.forEach(pushCandidate);
    }
    persistSeenPastes();

    // Return only the NEW candidates produced by this post.
    const fresh = [];
    let i = 0;
    for (const [k, p] of candidatesMap) {
      if (i++ < before) continue;
      fresh.push(p);
    }
    return fresh;
  }

  // ── Main flow: harvest `addCount` more verified portals ─────────────────
  // Strategy:
  //   1. Burn through any leftover untried candidates first.
  //   2. Fetch a Reddit page, then for EACH post extract candidates and
  //      immediately try to verify them. The moment we hit the goal we
  //      stop — we never process posts (or even fetch pages) we don't need.
  async function harvest(addCount) {
    cancelled = false;
    const startCount = verifiedMap.size;
    const goal = startCount + addCount;

    function showVerified(v) {
      const k = portalKey(v.portal);
      if (verifiedMap.has(k)) return;
      const wantCounts = !!($('opt-counts') && $('opt-counts').checked);
      if (wantCounts) v.countsLoading = true;
      verifiedMap.set(k, v);
      renderCard(v, verifiedMap.size);
      persistVerified();
      log('ALIVE', short(v.portal.url), v.portal.user, '(exp ' + v.expiry + ')');
      if (wantCounts) queueCounts((sig) => loadCountsFor(v, sig));
    }

    async function loadCountsFor(v, sig) {
      if (sig && sig.aborted) return;
      const k = portalKey(v.portal);
      try {
        const counts = await window.Verifier.fetchCounts(v.portal, fetchText, sig);
        if ((sig && sig.aborted) || !verifiedMap.has(k)) return;
        v.counts = counts;
        delete v.countsLoading;
        verifiedMap.set(k, v);
        persistVerified();
        const card = $cards.querySelector('.card[data-key="' + cssEscape(k) + '"]');
        if (card) {
          const slot = card.querySelector('.counts-slot');
          if (slot) slot.innerHTML = countsHtml(v);
        }
      } catch (_) {
        delete v.countsLoading;
      }
    }
    const goalReached = () => verifiedMap.size >= goal;

    async function verifyFresh(candidates) {
      const todo = candidates.filter(p =>
        !triedSet.has(portalKey(p)) && !verifiedMap.has(portalKey(p)));
      if (todo.length === 0) return;
      setStatus('Please wait… testing ' + todo.length + ' candidate(s) (' +
        verifiedMap.size + '/' + goal + ' alive)');
      await verifyUntil(todo, goal - verifiedMap.size, showVerified);
    }

    let pagesFetched = 0;
    try {
      // (1) Use any leftover candidates from prior runs first.
      const leftover = [...candidatesMap.values()].filter(p =>
        !triedSet.has(portalKey(p)) && !verifiedMap.has(portalKey(p)));
      if (leftover.length > 0 && !goalReached() && !cancelled) {
        await verifyFresh(leftover);
      }

      // (2) Stream Reddit pages post-by-post until goal reached.
      while (!goalReached() && !cancelled && !redditExhausted) {
        if (pagesFetched >= MAX_PAGES_PER_RUN) {
          log('hit per-run page cap (' + MAX_PAGES_PER_RUN + ')');
          break;
        }
        pagesFetched++;
        const pageLabel = 'page ' + pagesFetched;
        setStatus('Searching… (' + verifiedMap.size + '/' + goal + ' alive)');
        let pageResult;
        try {
          pageResult = await fetchSubredditPage(redditAfter);
        } catch (e) {
          log('Reddit fetch error: ' + (e.message || e));
          setStatus('Reddit scraping failed. Try again in a moment.', 'err');
          return;
        }
        const { posts, next } = pageResult;
        log(pageLabel + ': ' + posts.length + ' results (next=' + (next ? 'yes' : 'no') + ')');
        redditAfter = next;
        if (!next) redditExhausted = true;

        for (let i = 0; i < posts.length; i++) {
          if (goalReached() || cancelled) break;
          const pd = posts[i].data || {};
          const fresh = await extractCandidatesFromPost(pd, pageLabel, i, posts.length);
          if (fresh.length === 0) continue;
          await verifyFresh(fresh);
        }
      }

      const got = verifiedMap.size - startCount;
      const untried = candidatesMap.size - triedSet.size;
      const summary = '· ' + untried + ' untried candidate(s) cached';
      if (cancelled) {
        setStatus('Stopped. Got ' + got + ' new portal(s) ' + summary, '');
      } else if (got > 0) {
        setStatus('Got ' + got + ' new portal(s). ' + verifiedMap.size +
          ' total ' + summary, 'ok');
      } else {
        setStatus('No new working portals found ' + summary, 'err');
      }
    } catch (e) {
      setStatus('Error: ' + (e.message || e), 'err');
      log('FATAL', e.message || String(e));
    }
  }

  function setRunning(running) {
    $('go').disabled = running;
    $('more').disabled = running || verifiedMap.size === 0;
    $('stop').disabled = !running;
    $('clear').disabled = running || verifiedMap.size === 0;
    $('export').disabled = running || verifiedMap.size === 0;
  }

  $('go').addEventListener('click', async () => {
    // Reset scrape state but KEEP previously saved portals on screen.
    candidatesMap.clear();
    triedSet.clear();
    redditAfter = null;
    redditExhausted = false;
    setRunning(true);
    try { await harvest(BATCH); }
    finally { setRunning(false); }
  });
  $('more').addEventListener('click', async () => {
    setRunning(true);
    try { await harvest(BATCH); }
    finally { setRunning(false); }
  });
  $('stop').addEventListener('click', () => {
    cancelled = true;
    cancelCounts();
    setStatus('Stopping …');
  });
  $('clear').addEventListener('click', () => {
    if (verifiedMap.size === 0) return;
    if (!confirm('Remove ALL ' + verifiedMap.size + ' saved portal(s)?')) return;
    verifiedMap.clear();
    persistVerified();
    $cards.innerHTML = '';
    setStatus('All portals removed.', '');
    $('more').disabled = true;
    $('clear').disabled = true;
    $('export').disabled = true;
  });

  $('export').addEventListener('click', () => {
    if (verifiedMap.size === 0) return;
    const portals = [...verifiedMap.values()].map(v => ({
      url: v.portal.url,
      username: v.portal.user,
      password: v.portal.pass,
      expiry: v.expiry,
      activeConnections: v.activeConns,
      maxConnections: v.maxConns,
      ...(v.counts ? { counts: v.counts } : {}),
    }));
    const payload = {
      generatedAt: new Date().toISOString(),
      count: portals.length,
      portals,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = 'iptv-portals-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ── Restore saved portals on page load ───────────────────────────────────
  (function restore() {
    const saved = loadSaved();
    if (saved.length === 0) {
      setStatus('No saved portals yet — click “Get IPTV” to scrape some.', '');
      return;
    }
    for (const v of saved) {
      if (!v || !v.portal) continue;
      verifiedMap.set(portalKey(v.portal), v);
      renderCard(v, verifiedMap.size);
    }
    $('more').disabled = false;
    $('clear').disabled = false;
    $('export').disabled = false;
    setStatus('Loaded ' + verifiedMap.size + ' saved portal(s).', 'ok');
  })();
})();
