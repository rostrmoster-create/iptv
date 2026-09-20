// ── App download modal ─────────────────────────────────────────────────────
// Pulls the latest release tag from GitHub for both the mobile/desktop app
// (PlayTorrioV2) and the Android-TV app (PlayTorrioTVKT) and renders a
// platform-grouped download UI. Each group shows a "Download" button; if
// there are multiple files for that group (different ABIs / disk image
// formats) a small <select> lets the user pick.
(() => {
  const $ = (id) => document.getElementById(id);
  const modal = $('app-modal');
  const grid  = $('app-downloads');
  const verEl = $('app-version');

  const REPO_MAIN = 'ayman708-UX/PlayTorrioV2';
  const REPO_TV   = 'ayman708-UX/PlayTorrioTVKT';

  // Cache release lookups for the session so reopening the modal is instant
  // and we don't burn through GitHub's anonymous API quota.
  const releaseCache = new Map();

  async function latestRelease(repo) {
    if (releaseCache.has(repo)) return releaseCache.get(repo);
    const r = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error(repo + ' → HTTP ' + r.status);
    const data = await r.json();
    releaseCache.set(repo, data);
    return data;
  }

  // Map a release asset filename to a platform group + label.
  function classify(name) {
    const n = name.toLowerCase();
    if (n.endsWith('arm64-v8a-release.apk'))   return { group: 'android',     label: 'ARM64 (most phones)' };
    if (n.endsWith('armeabi-v7a-release.apk')) return { group: 'android',     label: 'ARMv7 (older phones)' };
    if (n.endsWith('.ipa'))                    return { group: 'ios',         label: 'iOS .ipa' };
    if (n.includes('macos-arm64') && n.endsWith('.dmg')) return { group: 'macos-arm', label: 'Apple Silicon .dmg' };
    if (n.includes('macos-arm64') && n.endsWith('.zip')) return { group: 'macos-arm', label: 'Apple Silicon .zip' };
    if (n.includes('macos-intel') && n.endsWith('.dmg')) return { group: 'macos-intel', label: 'Intel .dmg' };
    if (n.includes('macos-intel') && n.endsWith('.zip')) return { group: 'macos-intel', label: 'Intel .zip' };
    if (n.endsWith('windows-setup.exe') || n.endsWith('-setup.exe')) return { group: 'windows', label: 'Installer (.exe)' };
    return null;
  }

  // Display order + metadata for each platform group.
  const PLATFORMS = [
    { key: 'android',     icon: 'android', title: 'Android' },
    { key: 'androidtv',   icon: 'tv',      title: 'Android TV' },
    { key: 'ios',         icon: 'apple',   title: 'iOS' },
    { key: 'macos-arm',   icon: 'apple',   title: 'macOS (Apple Silicon)' },
    { key: 'macos-intel', icon: 'apple',   title: 'macOS (Intel)' },
    { key: 'windows',     icon: 'windows', title: 'Windows' },
  ];

  function buildGroups(mainRel, tvRel) {
    const groups = Object.fromEntries(PLATFORMS.map(p => [p.key, []]));

    for (const a of (mainRel.assets || [])) {
      const c = classify(a.name);
      if (c) groups[c.group].push({ label: c.label, name: a.name, url: a.browser_download_url });
    }
    for (const a of (tvRel.assets || [])) {
      const n = a.name.toLowerCase();
      if (n.endsWith('arm64-v8a-release.apk'))
        groups.androidtv.push({ label: 'ARM64 TV box (most TVs)', name: a.name, url: a.browser_download_url });
      else if (n.endsWith('armeabi-v7a-release.apk'))
        groups.androidtv.push({ label: 'ARMv7 TV box (older TVs)', name: a.name, url: a.browser_download_url });
    }
    return groups;
  }

  function render(mainRel, tvRel) {
    const groups = buildGroups(mainRel, tvRel);
    const tagMain = mainRel.tag_name || mainRel.name || '';
    const tagTv = tvRel.tag_name || tvRel.name || '';
    verEl.textContent = tagMain + (tagTv && tagTv !== tagMain ? '  ·  TV ' + tagTv : '');

    grid.innerHTML = '';
    for (const p of PLATFORMS) {
      const items = groups[p.key];
      if (!items || items.length === 0) continue;
      const card = document.createElement('div');
      card.className = 'plat-card';
      let html =
        '<div class="plat-head">' +
          '<span class="plat-icon">' + (window.Icons[p.icon] ? window.Icons[p.icon]() : '') + '</span>' +
          '<span class="plat-title">' + p.title + '</span>' +
        '</div>';
      if (items.length === 1) {
        html +=
          '<a class="plat-dl" href="' + items[0].url + '" rel="noopener" target="_blank" download>' +
            window.Icons.download() + '<span>Download</span>' +
            '<span class="plat-sub">' + items[0].label + '</span>' +
          '</a>';
      } else {
        const opts = items.map((it, i) =>
          '<option value="' + it.url + '">' + it.label + '</option>'
        ).join('');
        html +=
          '<label class="plat-pick">Version' +
            '<select>' + opts + '</select>' +
          '</label>' +
          '<a class="plat-dl" href="' + items[0].url + '" rel="noopener" target="_blank" download>' +
            window.Icons.download() + '<span>Download</span>' +
          '</a>';
      }
      card.innerHTML = html;
      const sel = card.querySelector('select');
      const dl  = card.querySelector('a.plat-dl');
      if (sel) sel.addEventListener('change', () => { dl.href = sel.value; });
      grid.appendChild(card);
    }
    if (!grid.children.length) {
      grid.innerHTML = '<div class="app-modal-loading">No downloads available.</div>';
    }
  }

  async function load() {
    grid.innerHTML = '<div class="app-modal-loading">Loading latest release…</div>';
    try {
      const [mainRel, tvRel] = await Promise.all([
        latestRelease(REPO_MAIN),
        latestRelease(REPO_TV),
      ]);
      render(mainRel, tvRel);
    } catch (e) {
      grid.innerHTML =
        '<div class="app-modal-loading">Couldn\u2019t reach GitHub. ' +
        '<a href="https://github.com/' + REPO_MAIN + '/releases/latest" target="_blank" rel="noopener">' +
          'Open releases page</a> instead.</div>';
      verEl.textContent = '';
    }
  }

  function open() {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    if (!grid.dataset.loaded) {
      load().then(() => { grid.dataset.loaded = '1'; });
    }
  }
  function close() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }

  $('get-app').addEventListener('click', open);
  modal.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });
})();
