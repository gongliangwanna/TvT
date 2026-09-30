(function () {
  'use strict';

  const STORAGE_KEY = 'sakura_feedback_threads_v1';
  const LEGACY_STORAGE_KEYS = ['uwu_feedback_threads_v1', 'ephone_feedback_threads_v1'];
  const DRAFT_KEY = mode => `sakura_feedback_draft_${mode}_v1`;
  const NOTICE_SUPPRESS_KEY = 'sakura_feedback_notice_ver';
  const NOTICE_VERSION = 'v2_natural';
  const MAX_IMAGE_BYTES = 1024 * 1024;

  const config = window.EPHONE_FEEDBACK_CONFIG || {};
  const apiUrl = String(config.apiUrl || 'https://ephone-feedback-public.zrb9080.workers.dev').replace(/\/+$/, '');
  const siteKey = String(config.turnstileSiteKey || '0x4AAAAAAFGVGxOUkCwKUOiV');

  const state = {
    mode: 'private', // 'private' | 'public'
    page: 'list',    // 'list' | 'new' | 'thread'
    thread: null,
    publicItems: [],
    publicNextCursor: null,
    owned: [],
    busy: false
  };

  let root;
  let turnstilePromise;
  let challengeWidgetId;
  let refreshTimer;
  let noticeCountdownTimer;
  let viewSequence = 0;
  let lastIndicatorCheck = 0;
  let confirmResolve;

  // 魔卡少女樱 (Cardcaptor Sakura) 风格矢量线框图标库
  // 严禁渐变色、严禁系统默认表情符号，纯几何与线条艺术
  const SAKURA_ICONS = {
    // 星之钥匙与法阵五角星
    star: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    // 星之法阵 (中央星与双重魔法轮)
    magicCircle: `<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="20" cy="20" r="18"/><circle cx="20" cy="20" r="15" stroke-dasharray="2 2"/><polygon points="20 7 23.5 15.5 32.5 16.5 26 22.5 27.5 31.5 20 27 12.5 31.5 14 22.5 7.5 16.5 16.5 15.5 20 7"/><circle cx="20" cy="20" r="4.5"/></svg>`,
    // 太阳与月亮守护印记 (封印之兽可鲁贝洛斯与月)
    sunMoon: `<svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="16" cy="16" r="13"/><path d="M16 3a13 13 0 0 0 0 26 10 10 0 0 1 0-26z"/><circle cx="16" cy="16" r="4" stroke-dasharray="1.5 1.5"/><line x1="16" y1="1" x2="16" y2="3"/><line x1="16" y1="29" x2="16" y2="31"/><line x1="1" y1="16" x2="3" y2="16"/><line x1="29" y1="16" x2="31" y2="16"/></svg>`,
    // 星之羽翼 (小樱魔杖双翼展开)
    wings: `<svg viewBox="0 0 32 20" width="28" height="18" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M16 14 C12 11, 4 9, 2 3 C5 10, 8 13, 16 16 C24 13, 27 10, 30 3 C28 9, 20 11, 16 14 Z"/><path d="M16 16 C10 14, 6 12, 4 7"/><path d="M16 16 C22 14, 26 12, 28 7"/></svg>`,
    // 封印之杖 / 飞翔星杖
    wand: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="4" y1="20" x2="15" y2="9"/><circle cx="17.5" cy="6.5" r="3.5"/><path d="M14 6.5h7"/><path d="M17.5 3v7"/><path d="M11 13l-1.5 1.5"/></svg>`,
    // 库洛牌 / 樱之卡框
    card: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5" y="2" width="14" height="20" rx="1.5"/><circle cx="12" cy="12" r="4.5" stroke-dasharray="1.5 1.5"/><path d="M9 2v3M15 2v3M9 22v-3M15 22v-3"/></svg>`,
    // 锁扣
    lock: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="4" y="11" width="16" height="11" rx="1.5"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16.5" r="1.5"/><path d="M12 18v2"/></svg>`,
    // 返回法阵箭头
    back: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" stroke-dasharray="2 2"/><path d="M13.5 8.5L10 12l3.5 3.5"/><path d="M10 12h5"/></svg>`,
    // 关闭
    close: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/><line x1="15.5" y1="8.5" x2="8.5" y2="15.5"/></svg>`,
    // 随信画卷附图
    photo: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="3" width="18" height="18" rx="1.5"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    // 删除
    stardust: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="2"/><circle cx="5" cy="5" r="1"/><circle cx="19" cy="5" r="1"/><circle cx="5" cy="19" r="1"/><circle cx="19" cy="19" r="1"/></svg>`,
    // 樱花瓣印记 (Sakura Petal)
    sakura: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12 3 C10 8, 4 8, 4 12 C4 16, 8 20, 12 21 C16 20, 20 16, 20 12 C20 8, 14 8, 12 3 Z"/><path d="M12 10v7"/></svg>`
  };

  function randomUUID() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function readLocal(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; }
  }

  function ownedThreads() {
    let items = readLocal(STORAGE_KEY, null);
    if (!Array.isArray(items)) {
      items = [];
      for (const legacyKey of LEGACY_STORAGE_KEYS) {
        const legacyItems = readLocal(legacyKey, []);
        if (Array.isArray(legacyItems) && legacyItems.length) {
          items.push(...legacyItems);
        }
      }
    }
    const clean = items.filter(item =>
      item && /^[0-9a-f-]{36}$/i.test(item.id) && typeof item.token === 'string' &&
      /^[0-9a-f]{64}$/i.test(item.token) && ['private', 'public'].includes(item.kind));
    return clean;
  }

  function saveOwned(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    LEGACY_STORAGE_KEYS.forEach(k => localStorage.setItem(k, JSON.stringify(items)));
  }

  function storeThread(thread, token) {
    const items = ownedThreads().filter(item => item.id !== thread.id);
    items.unshift({
      id: thread.id,
      token,
      kind: thread.kind,
      title: thread.title,
      seenAt: thread.last_admin_at || 0,
      updated_at: thread.updated_at || thread.created_at
    });
    saveOwned(items);
    state.owned = items;
  }

  function getCredential(id) {
    return ownedThreads().find(item => item.id === id);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char =>
      ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' })[char]);
  }

  function dateText(value) {
    if (!value) return '';
    const d = new Date(value);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function status(message, error) {
    const el = root?.querySelector('.sakura-status');
    if (!el) return;
    el.innerHTML = message ? `<span class="sakura-status-inner">${escapeHtml(message)}</span>` : '';
    el.classList.toggle('error', !!error);
  }

  async function request(path, options = {}, token) {
    if (location.protocol === 'file:') throw new Error('信箱需在网页或本地服务环境下使用。');
    if (!apiUrl) throw new Error('信箱服务尚未联通，请联系掌柜。');
    const headers = new Headers(options.headers || {});
    headers.set('X-EPhone-Feedback', '1');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`${apiUrl}${path}`, { ...options, headers, cache: 'no-store' });
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) throw new Error(data.error || `信件递送受阻（${response.status}）`);
    return data;
  }

  async function loadTurnstile() {
    if (!siteKey) throw new Error('安全验证尚未配置，请联系掌柜。');
    if (window.turnstile) return window.turnstile;
    if (!turnstilePromise) {
      turnstilePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = () => resolve(window.turnstile);
        script.onerror = () => reject(new Error('安全验证加载失败，请检查网络连接。'));
        document.head.appendChild(script);
      });
    }
    return turnstilePromise;
  }

  async function renderChallenge() {
    const host = root?.querySelector('.sakura-challenge');
    if (!host || location.protocol === 'file:') return;
    try {
      const turnstile = await loadTurnstile();
      if (!host.isConnected) return;
      challengeWidgetId = turnstile.render(host, {
        sitekey: siteKey,
        theme: 'light',
        callback: token => { host.dataset.token = token; },
        'expired-callback': () => { host.dataset.token = ''; },
        'error-callback': () => { host.dataset.token = ''; status('人机验证未通过，请重新校验。', true); }
      });
    } catch (error) { status(error.message, true); }
  }

  function clearChallenge() {
    if (challengeWidgetId !== undefined && window.turnstile) {
      try { window.turnstile.remove(challengeWidgetId); } catch (_) { /* 已销毁 */ }
    }
    challengeWidgetId = undefined;
  }

  function clearNoticeCountdown() {
    if (noticeCountdownTimer) clearInterval(noticeCountdownTimer);
    noticeCountdownTimer = null;
  }

  function showNoticeModal() {
    if (!root) return;
    const backdrop = root.querySelector('.sakura-notice-backdrop');
    if (!backdrop) return;
    const privacyTitle = backdrop.querySelector('.sakura-notice-privacy-title');
    const privacyText = backdrop.querySelector('.sakura-notice-privacy-text');
    if (privacyTitle) privacyTitle.textContent = state.mode === 'private' ? '私密信件' : '公开信件';
    if (privacyText) privacyText.textContent = state.mode === 'private'
      ? '此信仅你与作者可见，双方可在此往来回信。'
      : '审核通过后，信件内容将向所有读者公开展阅。';

    clearNoticeCountdown();
    const ackBtn = backdrop.querySelector('[data-action="notice-ack"]');
    const countdownEl = ackBtn?.querySelector('.ack-countdown');
    if (ackBtn) ackBtn.disabled = true;

    let seconds = 5;
    if (countdownEl) countdownEl.textContent = `(${seconds}s)`;

    backdrop.hidden = false;
    backdrop.classList.add('is-open');

    noticeCountdownTimer = setInterval(() => {
      seconds--;
      if (seconds > 0) {
        if (countdownEl) countdownEl.textContent = `(${seconds}s)`;
      } else {
        clearNoticeCountdown();
        if (countdownEl) countdownEl.textContent = '';
        if (ackBtn) ackBtn.disabled = false;
      }
    }, 1000);
  }

  function closeNoticeModal() {
    clearNoticeCountdown();
    const backdrop = root?.querySelector('.sakura-notice-backdrop');
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.classList.remove('is-open');
    }
  }

  function formDataFrom(form) {
    const data = new FormData(form);
    const image = data.get('image');
    if (image && image.size > MAX_IMAGE_BYTES) throw new Error('随信附图不能超过 1 MB。');
    if (!image || !image.size) data.delete('image');
    const challenge = form.querySelector('.sakura-challenge');
    if (!challenge?.dataset.token) throw new Error('请先完成人机安全验证。');
    data.set('turnstileToken', challenge.dataset.token);
    return data;
  }

  function clearRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function shell() {
    if (root) return;
    root = document.createElement('section');
    root.id = 'sakura-feedback';
    root.className = 'sakura-overlay';
    root.setAttribute('aria-label', '心之信箱');
    root.innerHTML = `
      <div class="sakura-book-container">
        <!-- 典雅四角花纹 -->
        <span class="sakura-corner corner-tl"></span>
        <span class="sakura-corner corner-tr"></span>
        <span class="sakura-corner corner-bl"></span>
        <span class="sakura-corner corner-br"></span>

        <!-- 顶栏导航 -->
        <header class="sakura-header">
          <button type="button" class="sakura-btn-icon" data-action="back" aria-label="返回">${SAKURA_ICONS.back}</button>
          <div class="sakura-title-group">
            <span class="sakura-sub-emblem">${SAKURA_ICONS.wings} SAKURA POST & ECHOES ${SAKURA_ICONS.wings}</span>
            <h2 class="sakura-title">心之信箱</h2>
          </div>
          <button type="button" class="sakura-btn-icon" data-action="close" aria-label="关闭">${SAKURA_ICONS.close}</button>
        </header>

        <!-- 状态/通知条 -->
        <div class="sakura-status" role="status"></div>

        <!-- 核心内容视窗 -->
        <main class="sakura-viewport"></main>

        <!-- 子弹窗 1：作者寄语 · 投稿须知 弹窗 -->
        <div class="sakura-notice-backdrop" hidden>
          <div class="sakura-notice-modal" role="dialog" aria-modal="true" aria-labelledby="sakuraNoticeTitle">
            <div class="sakura-modal-decor">
              <span class="sakura-corner corner-tl"></span>
              <span class="sakura-corner corner-tr"></span>
              <span class="sakura-corner corner-bl"></span>
              <span class="sakura-corner corner-br"></span>
            </div>
            <header class="sakura-notice-header">
              <div class="sakura-notice-wings">${SAKURA_ICONS.wings}</div>
              <div class="sakura-notice-badge">
                <span class="badge-star">${SAKURA_ICONS.star}</span>
                <span class="badge-text">SUBMISSION GUIDE</span>
                <span class="badge-star">${SAKURA_ICONS.star}</span>
              </div>
              <h3 class="sakura-notice-title" id="sakuraNoticeTitle">作者寄语 · 投稿须知</h3>
            </header>

            <div class="sakura-notice-body">
              <div class="sakura-notice-item">
                <div class="notice-item-head">
                  <span class="notice-item-glyph">✦</span>
                  <strong class="notice-item-title">尊重原创 · 请勿搬运他人灵感</strong>
                </div>
                <p class="notice-item-desc">请写下专属于你自己的真实心声与构想。严禁搬运或投稿其他作者的专属设定，请共同尊重并守护每一位创作者的心血。</p>
              </div>

              <div class="sakura-notice-item">
                <div class="notice-item-head">
                  <span class="notice-item-glyph">⚑</span>
                  <strong class="notice-item-title">异常反馈 · 尽量附带截图</strong>
                </div>
                <p class="notice-item-desc">反馈 BUG 或报错时，请尽量随信附带相关截图，并简述触发步骤或提示。</p>
              </div>

              <div class="sakura-notice-item">
                <div class="notice-item-head">
                  <span class="notice-item-glyph">◈</span>
                  <strong class="notice-item-title sakura-notice-privacy-title">私密信件</strong>
                </div>
                <p class="notice-item-desc sakura-notice-privacy-text">此信仅你与作者可见，双方可在此往来回信。</p>
              </div>
            </div>

            <footer class="sakura-notice-footer">
              <button type="button" class="sakura-btn-suppress" data-action="notice-suppress">不再提示</button>
              <button type="button" class="sakura-btn-ack" data-action="notice-ack" disabled>
                <span class="ack-text">我已知悉</span>
                <span class="ack-countdown">(5s)</span>
              </button>
            </footer>
          </div>
        </div>

        <!-- 子弹窗 2：自定义确认弹窗 -->
        <div class="sakura-confirm-backdrop" hidden>
          <div class="sakura-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="sakuraConfirmTitle">
            <div class="sakura-modal-decor">
              <span class="sakura-corner corner-tl"></span>
              <span class="sakura-corner corner-tr"></span>
              <span class="sakura-corner corner-bl"></span>
              <span class="sakura-corner corner-br"></span>
            </div>
            <div class="sakura-confirm-emblem">${SAKURA_ICONS.sunMoon}</div>
            <h3 id="sakuraConfirmTitle" class="sakura-confirm-title">请确认操作</h3>
            <p class="sakura-confirm-message"></p>
            <div class="sakura-confirm-actions">
              <button type="button" class="sakura-btn-cancel" data-action="confirm-cancel">取消</button>
              <button type="button" class="sakura-btn-accept" data-action="confirm-accept">确认</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.addEventListener('click', handleClick);
    root.addEventListener('keydown', event => {
      const dialog = root.querySelector('.sakura-confirm-backdrop');
      if (dialog?.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); settleConfirm(false); }
      if (event.key === 'Tab') {
        const buttons = [...dialog.querySelectorAll('button')];
        const next = event.shiftKey ? buttons[0] : buttons[1];
        if (document.activeElement === next) {
          event.preventDefault();
          (event.shiftKey ? buttons[1] : buttons[0]).focus();
        }
      }
    });
    root.addEventListener('submit', handleSubmit);
    root.addEventListener('input', event => {
      if (!event.target.closest('.sakura-form')) return;
      const form = event.target.form;
      if (!form) return;
      const draft = Object.fromEntries(new FormData(form).entries());
      delete draft.image;
      delete draft.turnstileToken;
      localStorage.setItem(DRAFT_KEY(state.mode), JSON.stringify({ mode: state.mode, ...draft }));
    });
    root.addEventListener('change', event => {
      if (event.target.matches('input[type="file"][name="image"]')) {
        const file = event.target.files[0];
        const previewEl = event.target.closest('.sakura-file-label')?.querySelector('.sakura-file-tip');
        if (previewEl) {
          previewEl.textContent = file ? `已夹入画卷: ${file.name}` : '可随信夹入一张附图（1MB以内）';
        }
      }
      if (event.target.matches('input[name="category"]')) {
        root.querySelectorAll('.sakura-stamp-pill').forEach(el => el.classList.remove('is-active'));
        const activeLabel = event.target.closest('.sakura-stamp-pill');
        if (activeLabel) activeLabel.classList.add('is-active');
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!root.classList.contains('open')) return;
      if (document.hidden) clearRefresh();
      else { refresh(); startRefresh(); }
    });
  }

  function heading() {
    const titleEl = root.querySelector('.sakura-title');
    if (!titleEl) return;
    if (state.page === 'thread') {
      titleEl.textContent = state.thread?.title || '往来信件';
    } else if (state.page === 'new') {
      titleEl.textContent = state.mode === 'private' ? '写私密信件' : '写公开反馈';
    } else {
      titleEl.textContent = state.mode === 'private' ? '私密信箱 · 秘语录' : '公开信箱 · 展阅集';
    }
  }

  // 1. 首页：信箱展厅 (Hub)
  function renderList() {
    viewSequence++;
    clearChallenge();
    state.page = 'list';
    state.thread = null;
    heading();

    const owned = state.owned.filter(item => item.kind === state.mode);
    const isPrivate = state.mode === 'private';

    root.querySelector('.sakura-viewport').innerHTML = `
      <div class="sakura-hub">
        <!-- 顶部信箱引言卷轴 -->
        <section class="sakura-emblem-parchment">
          <div class="sakura-magic-crest">
            <span class="sakura-crest-icon">${SAKURA_ICONS.magicCircle}</span>
            <div class="sakura-crest-divider">
              <span class="crest-line"></span>
              <span class="crest-star">${SAKURA_ICONS.star}</span>
              <span class="crest-line"></span>
            </div>
          </div>
          <p class="sakura-parchment-text">
            ${isPrivate
              ? '「把心里的想法，折成一封心愿信笺。」<br>投递的每一封信件保存在当前浏览器，可随时查阅回复。请勿清理站点数据以免凭证丢失。'
              : '「公开展阅的每一抹回声，经审阅通过后将向所有人展示。」'}
          </p>
        </section>

        <!-- 核心操作：写一封新信笺 -->
        <section class="sakura-release-section">
          <button type="button" class="sakura-btn-release" data-action="new">
            <div class="sakura-release-decor">
              <span class="release-wand">${SAKURA_ICONS.wand}</span>
            </div>
            <div class="sakura-release-content">
              <strong class="sakura-release-label">${isPrivate ? '写一封私密信件' : '写一封公开反馈'}</strong>
              <span class="sakura-release-hint">COMPOSE · 投递你的心愿或建议</span>
            </div>
            <span class="sakura-release-arrow">${SAKURA_ICONS.card}</span>
          </button>
        </section>

        <!-- 我的信件档案列表 -->
        <section class="sakura-section">
          <div class="sakura-section-header">
            <span class="sakura-section-glyph">${SAKURA_ICONS.wings}</span>
            <h3 class="sakura-section-title">我的信件 · ARCHIVE</h3>
            <span class="sakura-badge-count">${owned.length}</span>
          </div>

          <div class="sakura-card-stack">
            ${owned.length ? owned.map(item => `
              <button type="button" class="sakura-card-item" data-action="own" data-id="${item.id}">
                <div class="sakura-card-left-frame">
                  <span class="sakura-card-glyph">${SAKURA_ICONS.card}</span>
                  <span class="sakura-card-star">${SAKURA_ICONS.star}</span>
                </div>
                <div class="sakura-card-info">
                  <div class="sakura-card-meta">
                    <span class="sakura-card-code">NO. ${item.id.slice(0, 8).toUpperCase()}</span>
                    <span class="sakura-status-tag" data-bind-status="${item.id}">待回复</span>
                  </div>
                  <strong class="sakura-card-title">${escapeHtml(item.title || '无题信札')}</strong>
                </div>
                <div class="sakura-card-enter-tag">展读 →</div>
              </button>
            `).join('') : `
              <div class="sakura-empty-state">
                <div class="sakura-empty-icon">${SAKURA_ICONS.star}</div>
                <p class="sakura-empty-text">信盒尚空，未曾投递任何信件</p>
              </div>
            `}
          </div>
        </section>

        ${!isPrivate ? `
          <!-- 公开回声牌架 -->
          <section class="sakura-section">
            <div class="sakura-section-header">
              <span class="sakura-section-glyph">${SAKURA_ICONS.sunMoon}</span>
              <h3 class="sakura-section-title">公开展览信件 · PUBLIC ECHOES</h3>
            </div>
            <div class="sakura-public-board">
              <div class="sakura-public-list">
                <div class="sakura-empty-state"><p class="sakura-empty-text">正在翻阅公开信笺…</p></div>
              </div>
              <button type="button" data-action="more" class="sakura-btn-secondary" hidden>翻阅更多信笺</button>
            </div>
          </section>
        ` : ''}
      </div>
    `;

    refreshOwned();
    if (!isPrivate) loadPublic(true);
  }

  function paintEntryIndicators(threads, owned) {
    const byId = new Map(threads.map(thread => [thread.id, thread]));
    for (const mode of ['private', 'public']) {
      const buttons = document.querySelectorAll(`[data-sakura-feedback-mode="${mode}"], [data-uwu-feedback-mode="${mode}"]`);
      buttons.forEach(button => {
        const mine = owned.filter(item => item.kind === mode).map(item => ({ local: item, remote: byId.get(item.id) })).filter(item => item.remote);
        const replied = mine.some(({ local, remote }) => remote.last_admin_at > (local.seenAt || 0));
        const published = mode === 'public' && mine.some(({ remote }) => remote.status === 'visible');
        const badge = button.querySelector('.uwu-feedback-entry-badge, .sakura-entry-badge');

        button.classList.toggle('has-feedback-notice', replied || published);
        button.classList.toggle('has-reply', replied);

        if (badge) {
          badge.textContent = replied && published ? '回信·公开' : replied ? '有回信' : published ? '已公开' : '›';
        }
      });
    }
  }

  function confirmAction(message) {
    const backdrop = root.querySelector('.sakura-confirm-backdrop');
    backdrop.querySelector('.sakura-confirm-message').textContent = message;
    backdrop.hidden = false;
    backdrop.querySelector('[data-action="confirm-cancel"]').focus();
    return new Promise(resolve => { confirmResolve = resolve; });
  }

  function settleConfirm(approved) {
    const backdrop = root?.querySelector('.sakura-confirm-backdrop');
    if (backdrop) backdrop.hidden = true;
    if (confirmResolve) { confirmResolve(approved); confirmResolve = null; }
  }

  async function fetchOwnedStatuses() {
    const owned = ownedThreads();
    if (!apiUrl || !owned.length) { paintEntryIndicators([], owned); return []; }
    const threads = [];
    for (let start = 0; start < owned.length; start += 30) {
      const data = await request('/inbox', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threads: owned.slice(start, start + 30).map(({ id, token }) => ({ id, token })) })
      });
      threads.push(...data.threads);
    }
    paintEntryIndicators(threads, owned);
    return threads;
  }

  async function refreshOwned() {
    try {
      const threads = await fetchOwnedStatuses();
      for (const thread of threads) {
        const local = state.owned.find(item => item.id === thread.id);
        if (!local) continue;
        const tag = root.querySelector(`[data-bind-status="${thread.id}"]`);
        if (tag) {
          const hasNew = thread.last_admin_at > (local.seenAt || 0);
          tag.classList.toggle('has-reply', hasNew);
          const isPublished = thread.status === 'visible';
          const label = hasNew && isPublished ? '新回信 · 已公开' :
            hasNew ? '有新回信' :
            isPublished ? '信件已公开' :
            thread.visitor_closed || thread.status === 'closed' ? '对话已关闭' :
            thread.status === 'pending' ? '待审核' : '已归档';
          tag.innerHTML = `${SAKURA_ICONS.star}<span>${label}</span>`;
        }
      }
    } catch (error) { status(error.message, true); }
  }

  async function loadPublic(reset) {
    try {
      const cursor = reset ? '' : state.publicNextCursor || '';
      const data = await request(`/public/threads${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`);
      state.publicItems = reset ? data.threads : [...state.publicItems, ...data.threads];
      state.publicNextCursor = data.nextCursor;
      const host = root.querySelector('.sakura-public-list');
      if (!host) return;
      host.innerHTML = state.publicItems.length ? state.publicItems.map(item => `
        <button type="button" class="sakura-public-card" data-action="public" data-id="${item.id}">
          <div class="sakura-public-top">
            <span class="sakura-sender-mark">${SAKURA_ICONS.sakura} 寄信人：${escapeHtml(item.nickname || '匿名读者')}</span>
            <span class="sakura-card-date">${dateText(item.created_at)}</span>
          </div>
          <strong class="sakura-public-heading">${escapeHtml(item.title)}</strong>
        </button>`).join('') : '<div class="sakura-empty-state"><p class="sakura-empty-text">信架清澈，暂无公开展出信件</p></div>';
      const moreBtn = root.querySelector('[data-action="more"]');
      if (moreBtn) moreBtn.hidden = !data.nextCursor;
    } catch (error) { status(error.message, true); }
  }

  // 2. 写信页：心愿信笺撰写
  function renderNew() {
    viewSequence++;
    clearChallenge();
    state.page = 'new';
    heading();

    const draft = readLocal(DRAFT_KEY(state.mode), {});
    const isPrivate = state.mode === 'private';
    const activeCat = (draft.mode === state.mode && draft.category) || 'wish';

    root.querySelector('.sakura-viewport').innerHTML = `
      <div class="sakura-parchment-sheet">
        <form class="sakura-form sakura-new-form">
          <!-- 页眉与印章 -->
          <div class="sakura-sheet-header">
            <div class="sakura-stamp-box">
              <span class="stamp-border">
                <span class="stamp-icon">${SAKURA_ICONS.star}</span>
                <span class="stamp-text">POST</span>
              </span>
            </div>
            <div class="sakura-sheet-motto">
              <div class="sakura-sheet-motto-row">
                <span class="motto-line">LETTER · 心之所向</span>
                <button type="button" class="sakura-btn-guide-tag" data-action="open-notice">
                  <span>✦ 投稿须知</span>
                </button>
              </div>
              <p class="motto-note">${isPrivate ? '把最真实的心声折进信笺，此信仅你与掌柜可见。' : '公开的回声在经审阅后将向所有人展出。'}</p>
            </div>
          </div>

          <!-- 分类印章选择器 (无下拉框、纯线框) -->
          <div class="sakura-field">
            <label class="sakura-field-label">
              <span class="label-star">${SAKURA_ICONS.star}</span>
              <span>信件品类 · CATEGORY</span>
            </label>
            <div class="sakura-stamp-group">
              <label class="sakura-stamp-pill ${activeCat === 'wish' ? 'is-active' : ''}">
                <input type="radio" name="category" value="wish" ${activeCat === 'wish' ? 'checked' : ''}>
                <span class="pill-symbol">✦</span>
                <span class="pill-title">心愿许愿</span>
              </label>
              <label class="sakura-stamp-pill ${activeCat === 'feedback' ? 'is-active' : ''}">
                <input type="radio" name="category" value="feedback" ${activeCat === 'feedback' ? 'checked' : ''}>
                <span class="pill-symbol">✧</span>
                <span class="pill-title">功能建议</span>
              </label>
              <label class="sakura-stamp-pill ${activeCat === 'bug' ? 'is-active' : ''}">
                <input type="radio" name="category" value="bug" ${activeCat === 'bug' ? 'checked' : ''}>
                <span class="pill-symbol">⚑</span>
                <span class="pill-title">异常报错</span>
              </label>
              <label class="sakura-stamp-pill ${activeCat === 'other' ? 'is-active' : ''}">
                <input type="radio" name="category" value="other" ${activeCat === 'other' ? 'checked' : ''}>
                <span class="pill-symbol">◈</span>
                <span class="pill-title">其他随笔</span>
              </label>
            </div>
          </div>

          ${!isPrivate ? `
            <!-- 公开署名 -->
            <div class="sakura-field">
              <label class="sakura-field-label">
                <span class="label-star">${SAKURA_ICONS.star}</span>
                <span>署名 · SENDER NICKNAME（可选）</span>
              </label>
              <div class="sakura-input-wrap">
                <input type="text" name="nickname" maxlength="24" placeholder="留下你的专属代号或匿名…" value="${escapeHtml(draft.mode === state.mode ? draft.nickname || '' : '')}">
              </div>
            </div>
          ` : ''}

          <!-- 正文书写信笺纸 -->
          <div class="sakura-field">
            <label class="sakura-field-label">
              <span class="label-star">${SAKURA_ICONS.star}</span>
              <span>信札正文 · LETTER CONTENTS</span>
            </label>
            <div class="sakura-textarea-wrap">
              <textarea name="body" maxlength="5000" rows="8" required placeholder="提笔写下你想传达的心语或所遇之问题…">${escapeHtml(draft.mode === state.mode ? draft.body || '' : '')}</textarea>
              <div class="sakura-lined-bg" aria-hidden="true"></div>
            </div>
          </div>

          <!-- 随信附图附件卡 -->
          <div class="sakura-field">
            <label class="sakura-file-label">
              <input type="file" name="image" accept="image/png,image/jpeg,image/webp">
              <span class="sakura-file-card">
                <span class="sakura-file-icon">${SAKURA_ICONS.photo}</span>
                <span class="sakura-file-tip">随信附上截图（可选，1MB以内）</span>
              </span>
            </label>
          </div>

          <!-- 人机验证 -->
          <div class="sakura-challenge-section">
            <div class="sakura-challenge-title">安全人机验证</div>
            <div class="sakura-challenge"></div>
          </div>

          <!-- 封印呈递操作栏 -->
          <div class="sakura-actions-bar">
            <button type="submit" class="sakura-btn-seal">
              <span class="seal-icon">${SAKURA_ICONS.wand}</span>
              <span class="seal-text">${isPrivate ? '封缄并投入私密信箱' : '封缄并呈递公开审阅'}</span>
            </button>
          </div>
        </form>
      </div>
    `;

    renderChallenge();

    const suppressedVer = localStorage.getItem(state.mode === 'private' ? NOTICE_SUPPRESS_KEY : `${NOTICE_SUPPRESS_KEY}_public`);
    if (suppressedVer !== NOTICE_VERSION) {
      showNoticeModal();
    }
  }

  // 3. 详情与往来回信页 (对话式架构)
  async function openThread(id, publicView) {
    const currentView = ++viewSequence;
    try {
      status('正在展开启封信件…');
      const credential = getCredential(id);
      const data = await request(`/threads/${id}`, {}, publicView ? null : credential?.token);
      if (state.page === 'closed' || currentView !== viewSequence) return;
      const scrollTop = root.querySelector('.sakura-viewport').scrollTop;
      clearChallenge();
      state.thread = data.thread;
      state.page = 'thread';
      heading();

      const canReply = !!credential && !data.thread.visitor_closed && data.thread.status !== 'closed' && data.thread.status !== 'hidden';

      root.querySelector('.sakura-viewport').innerHTML = `
        <div class="sakura-thread-view">
          <!-- 信件头部铭牌 -->
          <header class="sakura-thread-meta-bar">
            <div class="sakura-thread-info">
              <span class="meta-tag">LETTER NO. ${id.slice(0, 8).toUpperCase()}</span>
              <span class="meta-kind">${data.thread.kind === 'public' ? '公开信件' : '私密信件'}</span>
              <span class="meta-date">${dateText(data.thread.created_at)}</span>
            </div>
            <div class="sakura-thread-crest">${SAKURA_ICONS.magicCircle}</div>
          </header>

          <!-- 往来对话流 (核心对话式架构) -->
          <div class="sakura-thread-scroll">
            <div class="sakura-scroll-inner">
              ${data.messages.map((message) => {
                const isAdmin = message.sender === 'admin';
                return `
                  <article class="sakura-message-card ${isAdmin ? 'message-guardian' : 'message-caster'}">
                    <div class="sakura-bubble-frame">
                      <div class="bubble-head">
                        <span class="bubble-author">
                          <span class="author-glyph">${isAdmin ? SAKURA_ICONS.wings : SAKURA_ICONS.star}</span>
                          ${isAdmin ? '作者 · 掌柜' : escapeHtml(data.thread.nickname || '投信者')}
                        </span>
                        <time class="bubble-time">${dateText(message.created_at)}</time>
                      </div>
                      <div class="bubble-body">${escapeHtml(message.body).replace(/\n/g, '<br>')}</div>
                      ${message.attachment_key ? `
                        <div class="bubble-attachment">
                          <button type="button" class="sakura-attachment-btn" data-action="image" data-key="${message.attachment_key}" data-id="${id}">
                            <span class="btn-ic">${SAKURA_ICONS.photo}</span>
                            <span>查看随信画卷</span>
                          </button>
                        </div>
                      ` : ''}
                    </div>
                  </article>
                `;
              }).join('')}
            </div>
          </div>

          <!-- 续写回信栏 (对话式延续) -->
          ${canReply ? `
            <section class="sakura-reply-drawer">
              <form class="sakura-form sakura-reply-form">
                <div class="sakura-reply-prompt">
                  <span class="reply-wand">${SAKURA_ICONS.wand}</span>
                  <strong>续写你的回信</strong>
                </div>
                <div class="sakura-textarea-wrap mini">
                  <textarea name="body" maxlength="5000" rows="3" required placeholder="在此提笔续写…"></textarea>
                </div>
                <label class="sakura-file-label mini">
                  <input type="file" name="image" accept="image/png,image/jpeg,image/webp">
                  <span class="sakura-file-card mini">
                    <span class="sakura-file-icon">${SAKURA_ICONS.photo}</span>
                    <span class="sakura-file-tip">随信附图（可选，1MB内）</span>
                  </span>
                </label>
                <div class="sakura-challenge-section mini">
                  <div class="sakura-challenge"></div>
                </div>
                <button type="submit" class="sakura-btn-seal mini">
                  <span class="seal-icon">${SAKURA_ICONS.wand}</span>
                  <span class="seal-text">发出回信</span>
                </button>
              </form>
            </section>
          ` : data.thread.visitor_closed || data.thread.status === 'closed' ? `
            <p class="sakura-thread-closed">此对话已关闭，往来记录依然保留。</p>
          ` : ''}

          <!-- 会话操作区 (关闭与永久删除) -->
          ${credential ? `
            <div class="sakura-danger-zone">
              ${!data.thread.visitor_closed && data.thread.status !== 'closed' ? `
                <button type="button" class="sakura-burn-btn" data-action="close-thread" data-id="${id}">
                  <span>关闭对话</span>
                </button>
              ` : ''}
              <button type="button" class="sakura-burn-btn" data-action="delete" data-id="${id}">
                <span class="burn-icon">${SAKURA_ICONS.stardust}</span>
                <span>删除记录</span>
              </button>
            </div>
          ` : ''}
        </div>
      `;

      root.querySelector('.sakura-viewport').scrollTop = scrollTop;
      if (credential) {
        const items = ownedThreads();
        const item = items.find(row => row.id === id);
        if (item) {
          item.seenAt = Math.max(item.seenAt || 0, data.thread.last_admin_at || 0);
          saveOwned(items);
          state.owned = items;
        }
        fetchOwnedStatuses().catch(() => {});
      }
      status('');
      if (canReply) renderChallenge();
    } catch (error) { status(error.message, true); }
  }

  async function viewImage(id, key) {
    try {
      const credential = getCredential(id);
      const response = await fetch(`${apiUrl}/attachments/${key}`, {
        headers: { 'X-EPhone-Feedback': '1', ...(credential ? { Authorization: `Bearer ${credential.token}` } : {}) },
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('画卷显现受阻。');
      const url = URL.createObjectURL(await response.blob());
      const container = document.createElement('div');
      container.className = 'sakura-image-viewer';
      const image = new Image();
      image.src = url;
      image.alt = '随信附图';
      image.className = 'sakura-framed-photo';
      image.onload = () => URL.revokeObjectURL(url);
      container.appendChild(image);
      root.querySelector(`[data-key="${key}"]`)?.replaceWith(container);
    } catch (error) { status(error.message, true); }
  }

  async function handleClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !root.contains(button)) return;
    const { action, id, key } = button.dataset;
    if (action === 'confirm-cancel') return settleConfirm(false);
    if (action === 'confirm-accept') return settleConfirm(true);
    if (action === 'close') return close();
    if (action === 'back') { status(''); if (state.page === 'list') close(); else renderList(); return; }
    if (action === 'new') return renderNew();
    if (action === 'own') return openThread(id, false);
    if (action === 'public') return openThread(id, true);
    if (action === 'more') return loadPublic(false);
    if (action === 'image') return viewImage(id, key);
    if (action === 'open-notice') {
      showNoticeModal();
      return;
    }
    if (action === 'notice-ack') {
      closeNoticeModal();
      return;
    }
    if (action === 'notice-suppress') {
      localStorage.setItem(state.mode === 'private' ? NOTICE_SUPPRESS_KEY : `${NOTICE_SUPPRESS_KEY}_public`, NOTICE_VERSION);
      closeNoticeModal();
      return;
    }
    if (action === 'close-thread') {
      if (!await confirmAction(state.thread?.kind === 'public'
        ? '关闭后无法继续回信，已有记录会完整保留，已公开的信件仍会展示。确定关闭？'
        : '关闭后无法继续回信，已有记录会完整保留。确定关闭？')) return;
      try {
        await request(`/threads/${id}`, { method: 'PATCH' }, getCredential(id)?.token);
        await openThread(id, false);
        status('对话已关闭。');
      } catch (error) { status(error.message, true); }
    }
    if (action === 'delete') {
      if (!await confirmAction(state.thread?.kind === 'public'
        ? '确认永久删除此对话吗？已公开的信件也将撤除，此操作无法撤销。'
        : '确认永久删除此对话及附件吗？此操作无法撤销。')) return;
      try {
        await request(`/threads/${id}`, { method: 'DELETE' }, getCredential(id)?.token);
        const items = ownedThreads().filter(item => item.id !== id);
        saveOwned(items);
        state.owned = items;
        renderList();
        status('记录已成功删除。');
      } catch (error) { status(error.message, true); }
    }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!form.matches('.sakura-new-form, .sakura-reply-form')) return;
    event.preventDefault();
    if (state.busy) return;
    try {
      const data = formDataFrom(form);
      state.busy = true;
      form.querySelector('[type="submit"]').disabled = true;
      status('正在投递信件…');
      if (form.classList.contains('.sakura-new-form') || form.matches('.sakura-new-form')) {
        const summary = String(data.get('body') || '').trim().replace(/\s+/g, ' ');
        data.set('title', summary.length > 32 ? `${summary.slice(0, 32)}…` : summary);
        const draftKey = DRAFT_KEY(state.mode);
        const oldDraft = readLocal(draftKey, {});
        const pending = oldDraft.mode === state.mode && oldDraft.pending;
        const id = pending?.id || randomUUID();
        const token = pending?.token || [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(draftKey, JSON.stringify({ ...oldDraft, mode: state.mode, pending: { id, token } }));
        data.set('id', id);
        data.set('token', token);
        data.set('kind', state.mode);
        const result = await request('/threads', { method: 'POST', body: data });
        storeThread(result.thread, token);
        localStorage.removeItem(draftKey);
        await openThread(id, false);
      } else {
        const id = state.thread.id;
        form.dataset.messageId ||= randomUUID();
        data.set('messageId', form.dataset.messageId);
        await request(`/threads/${id}/messages`, { method: 'POST', body: data }, getCredential(id)?.token);
        await openThread(id, false);
      }
      status('投递达成。');
    } catch (error) { status(error.message, true); }
    finally {
      state.busy = false;
      if (form.isConnected) {
        form.querySelector('[type="submit"]').disabled = false;
        const challenge = form.querySelector('.sakura-challenge');
        if (challenge) challenge.dataset.token = '';
        if (challengeWidgetId !== undefined && window.turnstile) window.turnstile.reset(challengeWidgetId);
      }
    }
  }

  async function refresh() {
    if (state.busy || document.hidden) return;
    if (state.page === 'list') {
      await refreshOwned();
      if (state.mode === 'public') await loadPublic(true);
      return;
    }
    if (state.page === 'thread' && state.thread) {
      if (root.querySelector('.sakura-reply-form textarea')?.value.trim()) return;
      const id = state.thread.id;
      await openThread(id, !getCredential(id));
    }
  }

  function startRefresh() {
    clearRefresh();
    refreshTimer = setInterval(refresh, 60000);
  }

  function open(mode) {
    shell();
    state.mode = mode === 'public' ? 'public' : 'private';
    state.owned = ownedThreads();
    state.publicItems = [];
    state.publicNextCursor = null;
    root.classList.add('open');
    document.body.classList.add('sakura-feedback-open');
    status(apiUrl && siteKey ? '' : '信箱未启，掌柜尚未联通通路。', true);
    renderList();
    startRefresh();
  }

  function close() {
    settleConfirm(false);
    viewSequence++;
    clearRefresh();
    clearChallenge();
    clearNoticeCountdown();
    closeNoticeModal();
    state.page = 'closed';
    state.thread = null;
    if (root) root.classList.remove('open');
    document.body.classList.remove('sakura-feedback-open');
  }

  async function refreshIndicators(force = false) {
    if (document.hidden || root?.classList.contains('open')) return;
    if (!force && Date.now() - lastIndicatorCheck < 15000) return;
    lastIndicatorCheck = Date.now();
    try { await fetchOwnedStatuses(); } catch (_) { /* 保持已知 */ }
  }

  // 双重命名空间暴露，兼容所有入口
  const exported = { open, close, refreshIndicators };
  window.EPhoneFeedback = exported;
  window.UWUFeedback = exported;
  window.SakuraFeedback = exported;

  document.addEventListener('click', () => setTimeout(refreshIndicators, 0), true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIndicators(true); });
  window.addEventListener('pageshow', () => refreshIndicators(true));
  setInterval(() => refreshIndicators(true), 60000);
})();
