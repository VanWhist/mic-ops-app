/*
 * MIC スタッフ予定 — 画面
 *
 * データはすべて Apps Script（MIC-Staff-API）から読む。このファイルにはスタッフ名・トークンを書かない。
 * トークンは URL の # の後ろ（#t=...）で受け取る。# 以降はサーバーへ送られず、リファラにも載らない。
 *
 * 保存の約束：
 *   - タップした日は「保存待ち」として持ち、まとめて送る（1回ずつ順番に。追い越さない）
 *   - サーバーが ok:true を返した日だけ「保存済み」にする。失敗したら印を残したまま警告を出す
 */
(function () {
  'use strict';

  var CFG = window.MIC_OPS_CONFIG || {};
  var DEMO = !CFG.apiUrl;

  // 国民の祝日（Google カレンダー「日本の祝日」2026-10-02 確認）。土日と同じく赤で表示する
  var HOLIDAYS = {
    '2026-11-03': '文化の日', '2026-11-23': '勤労感謝の日',
    '2027-01-01': '元日', '2027-01-11': '成人の日', '2027-02-11': '建国記念の日',
    '2027-02-23': '天皇誕生日', '2027-03-21': '春分の日', '2027-03-22': '振替休日'
  };
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  var ROLE_DEF = [
    { key: 'coaching', label: 'MICコーチング', short: 'コーチ', choices: ['積極的にやりたい', '可能', '希望しない'] },
    { key: 'lesson', label: '一般レッスン', short: 'レッスン', choices: ['積極的にやりたい', '可能', '希望しない'] },
    { key: 'escort', label: '大会引率', short: '引率', choices: ['可能', '条件付き', '難しい'] }
  ];
  var STATUS_CLASS = { '○': 's-o', '△': 's-t', '×': 's-x', '': 's-n' };
  var NOTE_MAX = 100;
  var BATCH_MAX = 200;

  var token = parseToken();
  var S = {
    me: null, staff: [], roles: {}, avail: {}, period: null,
    tab: 'mine', month: null, pen: '○', range: false, rangeStart: null,
    pending: {}, failed: {}, inflight: false, timer: null, error: null, lastSaved: null,
    noteDates: [], weekendOnly: true, selectedDay: null,
    events: {}, openEvent: null, evBusy: false, evMsg: null,
    uiReady: false, dead: false, bootAt: 0, fromCache: false, refreshing: false, stale: false,
    savedAt: {}, rolesSavedAt: 0, rolesDirty: false, deferRender: false, selKeep: {}
  };

  // ================================================================ 端末内キャッシュ（前回の内容をすぐ出す）
  //
  // 開いたらまず前回の内容を出し、裏で最新を取り直す。
  // ★ キーは「トークンのハッシュ＋版番号」。トークンそのものはキーにも値にも入れない。
  //   別の人の URL を同じ端末で開いても、前の人の内容は出ない（キーが違う）。
  // ★ 保存しておく形を変えたら CACHE_VER を上げる（古い形は読まれなくなる）。
  // ★ 保存に成功するたびに書き直す（開き直したときに、保存した日が消えて見えないように）。
  // ★ 最新を取れなかったら、前回の内容であることを必ず画面に出す。
  var CACHE_VER = 'v1';
  var cacheKey = null;

  function makeCacheKey() {
    try {
      if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) return Promise.resolve(null);
      return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)).then(function (buf) {
        var hex = Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        return 'micops_' + CACHE_VER + '_' + hex.slice(0, 32);
      }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function loadCache() {
    if (!cacheKey) return null;
    try {
      var c = JSON.parse(localStorage.getItem(cacheKey));
      return c && c.boot && c.boot.me && Array.isArray(c.boot.staff) && c.boot.period ? c : null;
    } catch (e) { return null; }
  }

  function saveCache() {
    if (!cacheKey || !S.me || !S.bootAt || S.dead) return;
    var events = {};
    Object.keys(S.events).forEach(function (m) {
      var e = S.events[m];
      if (e && e.data && e.at) events[m] = { data: e.data, at: e.at };
    });
    var boot = { me: S.me, staff: S.staff, roles: S.roles, availability: S.avail, period: S.period, venues: S.venues };
    try { localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), bootAt: S.bootAt, boot: boot, events: events })); }
    catch (e) { /* 容量不足などでも、キャッシュなしで動く */ }
  }

  function dropLocalCache() {
    if (!cacheKey) return;
    try { localStorage.removeItem(cacheKey); } catch (e) { /* なにもしない */ }
  }

  /** bootstrap の結果を画面の状態へ入れる。fetchStart 以降に保存した自分の日・役割は手元の値を残す */
  function applyBoot(r, fetchStart) {
    var fresh = r.availability || {};
    var meId = r.me && r.me.staffId;
    if (fetchStart && meId && S.avail[meId]) {
      var oldMine = S.avail[meId];
      var newMine = fresh[meId] || (fresh[meId] = {});
      Object.keys(S.savedAt).forEach(function (d) {
        if (S.savedAt[d] < fetchStart) return;   // 取得より前の保存は、取得結果に入っている
        if (oldMine[d]) newMine[d] = oldMine[d]; else delete newMine[d];
      });
    }
    var roles = r.roles || {};
    if (fetchStart && meId && S.rolesSavedAt >= fetchStart && S.roles[meId]) roles[meId] = S.roles[meId];
    S.me = r.me; S.staff = r.staff; S.roles = roles; S.avail = fresh; S.period = r.period; S.venues = r.venues || [];
  }

  /** 入力中（文字入力・プルダウン）は描き直さず、終わってから描く */
  function renderSafe() {
    var el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'checkbox' && el.type !== 'radio') { S.deferRender = true; renderAsOf(); return; }
    S.deferRender = false;
    renderAll();
  }

  function clock(ms) {
    var d = new Date(ms), now = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return d.toDateString() === now.toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  function renderAsOf() {
    var el = byId('asOf');
    if (!S.bootAt) { el.textContent = ''; return; }
    el.textContent = clock(S.bootAt) + '時点' + (S.refreshing ? '・最新を確認中…' : '');
    var b = byId('staleBanner');
    b.hidden = !S.stale;
    if (S.stale) byId('staleText').textContent = '最新を取得できませんでした。前回開いたときの内容です（' + clock(S.bootAt) + '時点）';
  }

  // ================================================================ 通信

  function api(action, body, timeoutMs) {
    var payload = Object.assign({ action: action, token: token }, body || {});
    if (DEMO) return window.MicDemo.call(payload);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000);
    return fetch(CFG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // プリフライトを起こさない
      body: JSON.stringify(payload),
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok) throw new Error('サーバーが応答しませんでした（' + res.status + '）');
      return res.json().catch(function () { throw new Error('サーバーの応答を読めませんでした'); });
    }, function (e) {
      throw new Error(e && e.name === 'AbortError' ? '時間内に応答がありませんでした' : '通信できませんでした。電波の状態を確認してください');
    }).then(function (data) {
      if (!data || data.ok !== true) {
        var err = new Error((data && data.message) || 'うまくいきませんでした');
        err.code = data && data.error;
        throw err;
      }
      return data;
    }).finally(function () { clearTimeout(timer); });
  }

  function parseToken() {
    var m = /(?:^|[#&])t=([^&]+)/.exec(location.hash || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  // ================================================================ 日付

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function parts(date) { return date.split('-').map(Number); }
  function weekday(date) { var p = parts(date); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); }
  function isOff(date) { var w = weekday(date); return w === 0 || w === 6 || !!HOLIDAYS[date]; }
  function daysOf(ym) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var out = [];
    for (var d = 1; d <= n; d++) out.push(ymd(y, m, d));
    return out;
  }
  function monthsOf(period) {
    var out = [], y = +period.start.slice(0, 4), m = +period.start.slice(5, 7);
    for (var i = 0; i < 24; i++) {
      var ym = y + '-' + pad(m);
      if (ym > period.end) break;
      out.push(ym);
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }
  function between(a, b) {
    if (a > b) { var t = a; a = b; b = t; }
    var out = [], p = parts(a), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    for (var i = 0; i < 200; i++) {
      var s = ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      if (s > b) break;
      out.push(s);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }
  function todayJst() {
    var j = new Date(Date.now() + 9 * 3600 * 1000);
    return ymd(j.getUTCFullYear(), j.getUTCMonth() + 1, j.getUTCDate());
  }
  function md(date) { var p = parts(date); return p[1] + '/' + p[2]; }
  function longDate(date) { var p = parts(date); return p[1] + '月' + p[2] + '日（' + WD[weekday(date)] + (HOLIDAYS[date] ? '・祝' : '') + '）'; }
  function inPeriod(date) { var ym = date.slice(0, 7); return ym >= S.period.start && ym <= S.period.end; }

  // ================================================================ 状態

  function cleanNote(s) {
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NOTE_MAX);
  }

  /** 画面に出す値：保存待ちがあればそれ、なければ保存済み */
  function valueOf(staffId, date) {
    if (staffId === S.me.staffId && S.pending.hasOwnProperty(date)) return S.pending[date];
    var m = S.avail[staffId];
    return (m && m[date]) || { s: '', n: '' };
  }

  function setPending(date, s, n) {
    S.pending[date] = { s: s, n: s === '△' ? cleanNote(n) : '' };
  }

  function pendingCount() { return Object.keys(S.pending).length; }

  function scheduleFlush(delay) {
    clearTimeout(S.timer);
    S.timer = setTimeout(flush, delay == null ? 400 : delay);
    renderSaveState();
  }

  function flush() {
    if (S.inflight || pendingCount() === 0) return Promise.resolve();
    var dates = Object.keys(S.pending).sort().slice(0, BATCH_MAX);
    var days = dates.map(function (d) { return { date: d, status: S.pending[d].s, note: S.pending[d].n }; });
    S.inflight = true;
    S.error = null;
    renderSaveState();
    return api('saveDays', { days: days }).then(function (r) {
      var mine = S.avail[S.me.staffId] || (S.avail[S.me.staffId] = {});
      r.saved.forEach(function (x) {
        if (x.status) mine[x.date] = { s: x.status, n: x.note || '' }; else delete mine[x.date];
        S.savedAt[x.date] = Date.now();
        var p = S.pending[x.date];
        if (p && p.s === x.status && p.n === (x.note || '')) delete S.pending[x.date];   // 送信中に変えた日は残す
        delete S.failed[x.date];
      });
      S.lastSaved = new Date();
      saveCache();
    }, function (e) {
      days.forEach(function (d) { S.failed[d.date] = true; });
      S.error = e.message;
    }).then(function () {
      S.inflight = false;
      renderAll();
      if (pendingCount() && !S.error) scheduleFlush(0);
    });
  }

  // ================================================================ 起動

  function start() {
    if (DEMO) show('demoBanner');
    if (!token) return fatal('URLが正しくありません。管理者から届いたURLをそのまま開いてください。');
    window.addEventListener('beforeunload', function (ev) {
      if (pendingCount() || S.inflight) { ev.preventDefault(); ev.returnValue = ''; }
    });
    byId('retryBtn').addEventListener('click', function () { S.error = null; flush(); });
    byId('staleRetry').addEventListener('click', function () { refreshBoot(); if (S.tab === 'events') loadEvents(S.month, true); });
    document.addEventListener('focusout', function () {
      setTimeout(function () { if (S.deferRender) renderSafe(); }, 0);
    });

    makeCacheKey().then(function (k) {
      cacheKey = k;
      var c = loadCache();
      if (c) {
        // 前回の内容をすぐ出す（管理者は予定も前回の分を出し、bootstrap と並行で取り直す）
        applyBoot(c.boot);
        S.bootAt = c.bootAt; S.fromCache = true;
        Object.keys(c.events || {}).forEach(function (m) { S.events[m] = { status: 'cached', data: c.events[m].data, at: c.events[m].at }; });
        initUI();
        window.__micopsCacheShownAt = performance.now();   // 計測用
      }
      refreshBoot();
    });
  }

  /** 画面の部品を一度だけ組み立てる（キャッシュ・最新のどちらが先に来ても1回） */
  function initUI() {
    if (S.uiReady) return;
    S.uiReady = true;
    var t = todayJst().slice(0, 7);
    var months = monthsOf(S.period);
    S.month = months.indexOf(t) >= 0 ? t : months[0];
    S.tab = S.me.isAdmin ? 'events' : 'mine';
    hide('loading');
    byId('who').textContent = S.me.isAdmin ? '管理者' : S.me.name + 'さん';
    setupTabs();
    setupMine();
    setupAll();
    setupRoles();
    setupEvents();
    setupStaffAdmin();
    setupAi();
    renderAll();
    if (S.tab === 'events') loadEvents(S.month);
  }

  function refreshBoot() {
    var t0 = Date.now();
    S.refreshing = true;
    renderAsOf();
    return api('bootstrap').then(function (r) {
      applyBoot(r, t0);
      S.bootAt = Date.now(); S.fromCache = false; S.stale = false;
      saveCache();
      if (!S.uiReady) initUI();
      else { if (!S.rolesDirty) fillRolesForm(); renderSafe(); }
    }, function (e) {
      if (e.code === 'auth') {
        // URL が無効化・再発行された。前回の内容も消して、何も出さない
        dropLocalCache();
        S.dead = true;
        ['tabs', 'tab-mine', 'tab-all', 'tab-events', 'tab-roles', 'tab-staff', 'tab-ai', 'staleBanner', 'errorBanner'].forEach(hide);
        byId('asOf').textContent = '';
        return fatal('このURLは使えません。管理者に新しいURLをもらってください。');
      }
      if (S.uiReady) { S.stale = true; return; }
      fatal('読み込めませんでした：' + e.message + '（時間をおいて開き直してください）');
    }).then(function () {
      S.refreshing = false;
      if (!S.dead) renderAsOf();
    });
  }

  function fatal(msg) {
    hide('loading');
    S.dead = S.dead || !S.uiReady;
    var el = byId('fatal');
    el.textContent = msg;
    el.hidden = false;
  }

  // ================================================================ タブ

  function setupTabs() {
    var nav = byId('tabs');
    nav.hidden = false;
    nav.querySelectorAll('.tab').forEach(function (b) {
      if (S.me.isAdmin && b.dataset.tab === 'mine') b.hidden = true;
      if (b.dataset.tab === 'staff' || b.dataset.tab === 'ai') b.hidden = !S.me.isAdmin;
      b.addEventListener('click', function () {
        S.tab = b.dataset.tab;
        renderAll();
        if (S.tab === 'events') loadEvents(S.month);
        if (S.tab === 'staff') loadStaffAdmin();
      });
    });
    document.querySelectorAll('.month-nav').forEach(function (nav) {
      nav.querySelector('.prev').addEventListener('click', function () { moveMonth(-1); });
      nav.querySelector('.next').addEventListener('click', function () { moveMonth(1); });
    });
  }

  function moveMonth(d) {
    var months = monthsOf(S.period);
    var i = months.indexOf(S.month) + d;
    if (i < 0 || i >= months.length) return;
    S.month = months[i];
    S.selectedDay = null;
    S.openEvent = null;
    renderAll();
    if (S.tab === 'events') loadEvents(S.month);
  }

  // ================================================================ 自分の予定

  function setupMine() {
    if (S.me.isAdmin) return;
    document.querySelectorAll('.pen').forEach(function (b) {
      b.addEventListener('click', function () { S.pen = b.dataset.pen; S.rangeStart = null; renderMine(); });
    });
    byId('rangeMode').addEventListener('change', function (e) { S.range = e.target.checked; S.rangeStart = null; renderMine(); });
    byId('rangeCancel').addEventListener('click', function () { S.range = false; S.rangeStart = null; byId('rangeMode').checked = false; renderMine(); });
    // 初回だけ使い方を出す。閉じたら二度と出さない（この端末で）
    var helpSeen = false;
    try { helpSeen = localStorage.getItem('micops_help_closed') === '1'; } catch (e) { helpSeen = false; }
    byId('help').hidden = helpSeen;
    byId('helpClose').addEventListener('click', function () {
      byId('help').hidden = true;
      try { localStorage.setItem('micops_help_closed', '1'); } catch (e) { /* 保存できなくても閉じる */ }
    });
    byId('cal').addEventListener('click', function (e) {
      var cell = e.target.closest('.day');
      if (cell) onDayTap(cell.dataset.date);
    });
    byId('noteSave').addEventListener('click', saveNote);
    // △の備考は、下の一覧の「備考を直す」から開く（△の日をもう一度タップすると消えるため）
    byId('mineSummary').addEventListener('click', function (e) {
      var b = e.target.closest('[data-note-date]');
      if (!b) return;
      var d = b.dataset.noteDate;
      S.noteDates = [d];
      renderMine();
      byId('noteInput').value = valueOf(S.me.staffId, d).n;
      byId('notePanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      byId('noteInput').focus();
    });
    byId('noteInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveNote(); } });
  }

  function onDayTap(date) {
    if (S.range) {
      if (!S.rangeStart) { S.rangeStart = date; renderMine(); return; }
      var a = S.rangeStart;
      S.rangeStart = null;
      paint(between(a, date).filter(inPeriod));
    } else if (S.pen && valueOf(S.me.staffId, date).s === S.pen) {
      // 同じ印の日をもう一度タップしたら消す（未回答に戻す）
      paint([date], '');
    } else {
      paint([date]);
    }
  }

  function paint(dates, penOverride) {
    var pen = penOverride == null ? S.pen : penOverride;
    dates.forEach(function (d) {
      var cur = valueOf(S.me.staffId, d);
      setPending(d, pen, pen === '△' && cur.s === '△' ? cur.n : '');
    });
    S.noteDates = pen === '△' ? dates : [];
    renderMine();
    scheduleFlush();
    if (pen === '△') {
      var input = byId('noteInput');
      input.value = commonNote(dates);
      byId('notePanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function commonNote(dates) {
    var notes = dates.map(function (d) { return valueOf(S.me.staffId, d).n; });
    return notes.every(function (n) { return n === notes[0]; }) ? notes[0] : '';
  }

  function saveNote() {
    var note = byId('noteInput').value;
    S.noteDates.forEach(function (d) {
      if (valueOf(S.me.staffId, d).s === '△') setPending(d, '△', note);
    });
    renderMine();
    scheduleFlush(0);
  }

  function renderMine() {
    if (S.me.isAdmin) return;
    renderMonthLabels();
    document.querySelectorAll('.pen').forEach(function (b) {
      var on = b.dataset.pen === S.pen;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    byId('hint').textContent = S.range
      ? (S.rangeStart ? md(S.rangeStart) + ' から。終わりの日をタップしてください' : '始まりの日をタップしてください')
      : '印を選んで日付をタップ。間違えたら、同じ印のままもう一度タップすると消えます';
    byId('rangeSteps').hidden = !S.range;
    byId('rangeSteps').querySelectorAll('.step').forEach(function (el) {
      el.classList.toggle('now', el.dataset.step === (S.rangeStart ? '2' : '1'));
      el.classList.toggle('done', el.dataset.step === '1' && !!S.rangeStart);
    });
    var PEN_NAME = { '○': '行ける', '△': '条件付き', '×': '行けない' };
    byId('penNow').innerHTML = S.pen
      ? '<span class="mk ' + STATUS_CLASS[S.pen] + '">' + S.pen + '</span>（' + PEN_NAME[S.pen] + '）を入力中' + (S.range ? '・期間でまとめて' : '')
      : '<span class="mk s-n">消</span>消す（未回答に戻す）を入力中' + (S.range ? '・期間でまとめて' : '');

    var cal = byId('cal');
    var days = daysOf(S.month);
    var html = '';
    for (var i = 0; i < weekday(days[0]); i++) html += '<span class="blank"></span>';
    var today = todayJst();
    days.forEach(function (d) {
      var v = valueOf(S.me.staffId, d);
      var w = weekday(d);
      var cls = ['day', STATUS_CLASS[v.s]];
      if (w === 0 || HOLIDAYS[d]) cls.push('sun'); else if (w === 6) cls.push('sat');
      if (S.pending.hasOwnProperty(d)) cls.push('pending');
      if (S.failed[d]) cls.push('failed');
      if (S.rangeStart === d) cls.push('range-start');
      if (d === today) cls.push('today');
      var label = longDate(d) + ' ' + (v.s || '未回答') + (v.n ? ' ' + v.n : '');
      html += '<button type="button" class="' + cls.join(' ') + '" data-date="' + d + '" aria-label="' + esc(label) + '">' +
        '<span class="dn">' + parts(d)[2] + '</span><span class="mk">' + esc(v.s) + '</span>' +
        (v.n ? '<span class="nd" aria-hidden="true"></span>' : '') + '</button>';
    });
    cal.innerHTML = html;

    var np = byId('notePanel');
    var noteDates = S.noteDates.filter(function (d) { return valueOf(S.me.staffId, d).s === '△'; });
    np.hidden = noteDates.length === 0;
    if (noteDates.length) {
      byId('noteLabel').textContent = '△の備考（' + (noteDates.length === 1 ? md(noteDates[0]) : md(noteDates[0]) + '〜' + md(noteDates[noteDates.length - 1]) + ' の△' + noteDates.length + '日') + '）';
    }

    var mine = days.map(function (d) { return [d, valueOf(S.me.staffId, d)]; });
    var answered = mine.filter(function (x) { return x[1].s; }).length;
    var offMissing = mine.filter(function (x) { return !x[1].s && isOff(x[0]); }).length;
    var notes = mine.filter(function (x) { return x[1].s === '△'; }).map(function (x) {
      return '<li>' + md(x[0]) + '（' + WD[weekday(x[0])] + '）△ ' + (x[1].n ? esc(x[1].n) : '<span class="muted">備考なし</span>') +
        ' <button type="button" class="note-edit" data-note-date="' + x[0] + '">備考を直す</button></li>';
    });
    byId('mineSummary').innerHTML = '入力済み ' + answered + '日／土日祝で未回答 <strong>' + offMissing + '日</strong>' +
      (notes.length ? '<ul class="note-list">' + notes.join('') + '</ul>' : '');
  }

  // ================================================================ みんなの予定

  function setupAll() {
    byId('weekendOnly').addEventListener('change', function (e) { S.weekendOnly = e.target.checked; renderAll(); });
    byId('grid').addEventListener('click', function (e) {
      var th = e.target.closest('[data-day]');
      if (!th) return;
      S.selectedDay = S.selectedDay === th.dataset.day ? null : th.dataset.day;
      renderAll();
      if (S.selectedDay) byId('dayDetail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    byId('reloadBtn').addEventListener('click', reload);
  }

  function reload() {
    var btn = byId('reloadBtn');
    btn.disabled = true;
    btn.textContent = '読み込み中…';
    api('bootstrap').then(function (r) {
      S.staff = r.staff; S.roles = r.roles || {}; S.avail = r.availability || {};
      btn.textContent = '最新にする';
    }, function (e) {
      btn.textContent = '読み込めませんでした（もう一度）';
    }).then(function () { btn.disabled = false; renderAll(); });
  }

  function renderGrid() {
    var today = todayJst();
    var days = daysOf(S.month).filter(function (d) { return !S.weekendOnly || isOff(d) || d === today; });
    var h = '<thead><tr><th class="corner">' + (+S.month.slice(5, 7)) + '月</th>';
    days.forEach(function (d) {
      var w = weekday(d);
      var c = (w === 0 || HOLIDAYS[d]) ? 'sun' : (w === 6 ? 'sat' : '');
      h += '<th class="dh ' + c + (S.selectedDay === d ? ' sel' : '') + (d === today ? ' today' : '') + '"><button type="button" data-day="' + d + '">' +
        parts(d)[2] + '<small>' + WD[w] + '</small></button></th>';
    });
    h += '</tr></thead><tbody>';
    S.staff.forEach(function (st) {
      var self = S.me.staffId === st.staffId;
      h += '<tr' + (self ? ' class="self"' : '') + '><th class="nm">' + esc(st.name) + '</th>';
      days.forEach(function (d) {
        var v = valueOf(st.staffId, d);
        h += '<td class="' + STATUS_CLASS[v.s] + (S.selectedDay === d ? ' sel' : '') + (d === today ? ' today' : '') + '"' + (v.n ? ' title="' + esc(v.n) + '"' : '') + '>' +
          esc(v.s) + (v.n ? '<i class="nd"></i>' : '') + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody><tfoot><tr><th class="nm">○の人数</th>';
    days.forEach(function (d) {
      var n = S.staff.filter(function (st) { return valueOf(st.staffId, d).s === '○'; }).length;
      h += '<td>' + n + '</td>';
    });
    h += '</tr></tfoot>';
    byId('grid').innerHTML = days.length ? h : '<tbody><tr><td>この月に表示する日がありません</td></tr></tbody>';
    renderDayDetail();
  }

  function renderDayDetail() {
    var el = byId('dayDetail');
    var d = S.selectedDay;
    if (!d || d.slice(0, 7) !== S.month) { el.hidden = true; return; }
    var by = { '○': [], '△': [], '×': [], '': [] };
    S.staff.forEach(function (st) { by[valueOf(st.staffId, d).s].push(st); });

    var h = '<h3>' + longDate(d) + '</h3>';
    h += '<h4><span class="mk s-o">○</span> 行ける人 ' + by['○'].length + '人</h4>';
    if (by['○'].length) {
      h += '<dl class="by-role">';
      ROLE_DEF.forEach(function (rd) {
        var groups = rd.choices.slice(0, 2).map(function (c) {
          var names = by['○'].filter(function (st) { return (S.roles[st.staffId] || {})[rd.key] === c; }).map(function (st) {
            var r = S.roles[st.staffId];
            return esc(st.name) + (rd.key === 'escort' && c === '条件付き' && r.escort_note ? '<small>（' + esc(r.escort_note) + '）</small>' : '');
          });
          return names.length ? '<span class="grp"><em>' + (c === '積極的にやりたい' ? '積極的' : c) + '</em> ' + names.join('、') + '</span>' : '';
        }).join('');
        h += '<dt>' + rd.label + '</dt><dd>' + (groups || '<span class="muted">なし</span>') + '</dd>';
      });
      var noRole = by['○'].filter(function (st) { return !S.roles[st.staffId]; }).map(function (st) { return esc(st.name); });
      if (noRole.length) h += '<dt>役割の希望が未登録</dt><dd>' + noRole.join('、') + '</dd>';
      h += '</dl>';
    }
    h += '<h4><span class="mk s-t">△</span> 条件付き ' + by['△'].length + '人</h4>';
    if (by['△'].length) {
      h += '<ul class="plain">' + by['△'].map(function (st) {
        var n = valueOf(st.staffId, d).n;
        return '<li>' + esc(st.name) + (n ? '：' + esc(n) : '') + '</li>';
      }).join('') + '</ul>';
    }
    h += '<h4><span class="mk s-x">×</span> 行けない ' + by['×'].length + '人</h4>';
    if (by['×'].length) h += '<p>' + by['×'].map(function (st) { return esc(st.name); }).join('、') + '</p>';
    h += '<h4><span class="mk s-n"></span> 未回答 ' + by[''].length + '人</h4>';
    if (by[''].length) h += '<p>' + by[''].map(function (st) { return esc(st.name); }).join('、') + '</p>';
    el.innerHTML = h;
    el.hidden = false;
  }

  // ================================================================ 役割の希望

  function setupRoles() {
    var form = byId('rolesForm');
    if (S.me.isAdmin) return;
    form.hidden = false;
    fillRolesForm();
    form.addEventListener('change', function () {
      S.rolesDirty = true;
      toggleEscortNote();
      setRolesMsg('', '');
    });
    byId('escortNote').addEventListener('input', function () { S.rolesDirty = true; });
    toggleEscortNote();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var roles = {};
      ROLE_DEF.forEach(function (rd) {
        var c = form.querySelector('input[name="' + rd.key + '"]:checked');
        roles[rd.key] = c ? c.value : '';
      });
      roles.escort_note = roles.escort === '条件付き' ? byId('escortNote').value : '';
      roles.venues = Array.prototype.map.call(form.querySelectorAll('input[name="venue"]:checked'), function (x) { return x.value; });
      var btn = byId('rolesSave');
      btn.disabled = true;
      setRolesMsg('保存中…', 'busy');
      api('saveRoles', { roles: roles }).then(function (r) {
        S.roles[S.me.staffId] = r.roles;
        S.rolesSavedAt = Date.now();
        S.rolesDirty = false;
        saveCache();
        byId('escortNote').value = r.roles.escort_note || '';
        setRolesMsg('✓ 保存しました', 'ok');
        renderRolesTable();
      }, function (err) {
        setRolesMsg('⚠ 保存できませんでした：' + err.message, 'ng');
      }).then(function () { btn.disabled = false; });
    });
  }

  /** 役割の希望の欄を、保存済みの内容で埋める（変更中は呼ばない） */
  function fillRolesForm() {
    var form = byId('rolesForm');
    if (S.me.isAdmin) return;
    var cur = S.roles[S.me.staffId] || {};
    ROLE_DEF.forEach(function (rd) {
      var box = form.querySelector('[data-role="' + rd.key + '"] .choices');
      box.innerHTML = rd.choices.map(function (c, i) {
        var id = 'r-' + rd.key + '-' + i;
        return '<input type="radio" name="' + rd.key + '" id="' + id + '" value="' + c + '"' + (cur[rd.key] === c ? ' checked' : '') + '>' +
          '<label for="' + id + '">' + c + '</label>';
      }).join('');
    });
    byId('escortNote').value = cur.escort_note || '';
    var curVenues = cur.venues || [];
    form.querySelector('[data-role="venues"]').hidden = S.venues.length === 0;   // 旧版の API では出さない
    byId('venueChoices').innerHTML = S.venues.map(function (v, i) {
      var id = 'v-' + i;
      return '<input type="checkbox" name="venue" id="' + id + '" value="' + esc(v) + '"' + (curVenues.indexOf(v) >= 0 ? ' checked' : '') + '>' +
        '<label for="' + id + '">' + esc(v) + '</label>';
    }).join('');
    toggleEscortNote();
  }

  function toggleEscortNote() {
    var c = document.querySelector('input[name="escort"]:checked');
    byId('escortNoteWrap').hidden = !(c && c.value === '条件付き');
  }

  function setRolesMsg(text, kind) {
    var el = byId('rolesMsg');
    el.textContent = text;
    el.className = 'roles-msg ' + kind;
  }

  function renderRolesTable() {
    var h = '<thead><tr><th></th>' + ROLE_DEF.map(function (rd) { return '<th>' + rd.short + '</th>'; }).join('') + '<th>会場</th></tr></thead><tbody>';
    S.staff.forEach(function (st) {
      var r = S.roles[st.staffId];
      h += '<tr' + (st.staffId === S.me.staffId ? ' class="self"' : '') + '><th class="nm">' + esc(st.name) + '</th>';
      ROLE_DEF.forEach(function (rd) {
        var v = r ? r[rd.key] : '';
        var cls = v === '積極的にやりたい' ? 'r-hi' : (v === '可能' ? 'r-ok' : (v === '条件付き' ? 'r-cond' : (v ? 'r-no' : 'r-none')));
        var label = v === '積極的にやりたい' ? '積極的' : (v || '未登録');
        h += '<td class="' + cls + '">' + esc(label) + (rd.key === 'escort' && r && r.escort_note ? '<small>' + esc(r.escort_note) + '</small>' : '') + '</td>';
      });
      var vs = r && r.venues;
      h += '<td class="venues ' + (vs && vs.length ? '' : 'r-none') + '">' + (!r ? '未登録' : (vs && vs.length ? esc(vs.join('・')) : 'なし')) + '</td>';
      h += '</tr>';
    });
    byId('rolesTable').innerHTML = h + '</tbody>';
  }

  // ================================================================ 予定と担当（③）

  var ROLE_LABEL = { coaching: 'MICコーチング', lesson: '一般レッスン', escort: '大会引率' };
  var ROLE_SHORT = { coaching: 'コーチ', lesson: 'レッスン', escort: '引率' };
  var ROLE_TOP = { coaching: ['積極的にやりたい', '可能'], lesson: ['積極的にやりたい', '可能'], escort: ['可能', '条件付き'] };
  var EVENT_TYPES = ['練習', '合宿', '大会', '一般レッスン', '未分類'];
  var VENUE_NONE = 'なし';

  function setupEvents() {
    byId('evReload').addEventListener('click', function () {
      // 空き状況・役割も読み直す（担当の人が×に変えたかの警告は、これを元に出している）。
      // 管理者はカレンダーも読み直す（サーバー側の10分キャッシュを使わない）
      refreshBoot();
      loadEvents(S.month, true, true);
    });
    byId('tab-events').addEventListener('change', function (e) {
      if (e.target.dataset && e.target.dataset.keep) S.selKeep[e.target.dataset.keep] = e.target.value;
    });
    byId('tab-events').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      var act = b.dataset.act, key = b.dataset.key;
      if (act === 'open') { S.openEvent = S.openEvent === key ? null : key; renderEvents(); return; }
      if (!S.me.isAdmin || S.evBusy) return;
      if (act === 'assign-pick') {
        // 「全員から選ぶ」：空き状況・役割の希望に関係なく、だれでも担当にできる（電話で頼んだ人など）
        var sel = b.closest('.pick').querySelector('select');
        if (!sel.value) { S.evMsg = { kind: 'ng', text: '担当にする人を選んでください' }; renderEvents(); return; }
        adminOp('assign', { eventKey: key, staffId: sel.value, role: b.dataset.role, on: true });
      } else if (act === 'assign' || act === 'unassign') {
        adminOp('assign', { eventKey: key, staffId: b.dataset.staff, role: b.dataset.role, on: act === 'assign' });
      } else if (act === 'relink') {
        // 日時が変わった予定へ付け直す：新しい予定に付けてから、古い割り当てを外す
        adminOp('assign', { eventKey: b.dataset.to, staffId: b.dataset.staff, role: b.dataset.role, on: true }, function () {
          return { action: 'assign', payload: { eventKey: key, staffId: b.dataset.staff, role: b.dataset.role, on: false } };
        });
      } else if (act === 'meta') {
        var box = b.closest('.ev-meta');
        adminOp('setEventMeta', { eventKey: key, type: box.querySelector('select[name="type"]').value, venue: box.querySelector('select[name="venue"]').value });
      }
    });
  }

  function loadEvents(month, force, fresh) {
    var cur = S.events[month];
    if (cur && (cur.status === 'loading' || (cur.status === 'ok' && !force))) return;
    S.evMsg = null;
    S.events[month] = { status: 'loading', data: cur && cur.data, at: cur && cur.at };
    renderEvents();
    api('events', fresh && S.me.isAdmin ? { month: month, fresh: true } : { month: month }).then(function (r) {
      S.events[month] = { status: 'ok', data: r, at: Date.now() };
      saveCache();
    }, function (e) {
      var msg = e.code === 'bad_request' && /不明な操作/.test(e.message) ? 'サーバー側（Apps Script）がまだ古い版です。更新後に「最新にする」を押してください' : e.message;
      S.events[month] = { status: 'error', error: msg, data: cur && cur.data, at: cur && cur.at };
    }).then(function () { if (S.tab === 'events') renderSafe(); else renderEvents(); });
  }

  /** 管理者の操作。成功したらサーバーが返した月の予定で描き直す。then は続けて行う操作 */
  function adminOp(action, payload, then) {
    var month = S.month;
    S.evBusy = true;
    S.evMsg = { kind: 'busy', text: '保存中…' };
    renderEvents();
    api(action, Object.assign({ month: month }, payload)).then(function (r) {
      S.events[month] = { status: 'ok', data: r, at: Date.now() };
      var next = then && then();
      if (next) return api(next.action, Object.assign({ month: month }, next.payload)).then(function (r2) { S.events[month] = { status: 'ok', data: r2, at: Date.now() }; });
    }).then(function () {
      saveCache();
      // 保存した予定のプルダウンは、保存後の内容で出し直す
      Object.keys(S.selKeep).forEach(function (k) { if (k.indexOf(':' + payload.eventKey) >= 0) delete S.selKeep[k]; });
      S.evMsg = { kind: 'ok', text: '✓ 保存しました' };
    }, function (e) {
      S.evMsg = { kind: 'ng', text: '⚠ 保存できませんでした：' + e.message };
    }).then(function () { S.evBusy = false; renderEvents(); });
  }

  /** その予定の日付すべてでの、スタッフの空き具合 */
  function availOn(staffId, dates) {
    var c = { o: 0, t: 0, x: 0, n: 0, notes: [] };
    dates.forEach(function (d) {
      var v = valueOf(staffId, d);
      if (v.s === '○') c.o++; else if (v.s === '△') { c.t++; if (v.n) c.notes.push(md(d) + ' ' + v.n); } else if (v.s === '×') c.x++; else c.n++;
    });
    var len = dates.length;
    c.free = c.o + c.t > 0;
    c.full = c.o === len;
    if (len === 1) c.label = c.o ? '○' : c.t ? '△' : c.x ? '×' : '未回答';
    else c.label = c.full ? '全日○' : '○' + c.o + (c.t ? '・△' + c.t : '') + '／' + len + '日';
    return c;
  }

  function venueOk(staffId, ev) {
    if (!ev.venue) return true;
    var r = S.roles[staffId];
    return !!(r && r.venues && r.venues.indexOf(ev.venue) >= 0);
  }

  function nameOf(id) {
    var st = S.staff.filter(function (x) { return x.staffId === id; })[0];
    return st ? st.name : id;
  }

  function evDateLabel(ev) {
    var d = ev.dates, f = d[0], l = d[d.length - 1];
    var s = md(f) + '（' + WD[weekday(f)] + '）';
    if (d.length > 1) return s + '〜' + md(l) + '（' + WD[weekday(l)] + '）' + d.length + '日間';
    return ev.allDay ? s + ' 終日' : s + ' ' + ev.start.slice(11) + '–' + ev.end.slice(11);
  }

  function renderEvents() {
    if (!S.me) return;
    var st = S.events[S.month];
    var status = byId('evStatus');
    if (S.evMsg) { status.textContent = S.evMsg.text; status.className = 'ev-status ' + S.evMsg.kind; }
    else if (st && st.status === 'loading') { status.textContent = st.data ? clock(st.at) + '時点の内容・最新を確認中…' : '読み込み中…'; status.className = 'ev-status busy'; }
    else if (st && st.status === 'cached') { status.textContent = clock(st.at) + '時点の内容'; status.className = 'ev-status busy'; }
    else if (st && st.status === 'error') {
      status.textContent = st.data ? '⚠ 最新を取得できませんでした。前回開いたときの内容です（' + clock(st.at) + '時点）' : '⚠ 読み込めませんでした：' + st.error;
      status.className = 'ev-status ng';
    }
    else { status.textContent = ''; status.className = 'ev-status'; }
    var data = st && st.data;
    if (!data || data.month !== S.month) { byId('evList').innerHTML = ''; byId('evOrphans').innerHTML = ''; return; }

    // 要確認：割り当て済みなのに予定が見つからない（削除・日時変更）
    var oh = '';
    if (data.orphans.length) {
      oh = '<div class="orphans"><h3>⚠ 要確認：カレンダーで予定が消えたか、日時が変わりました</h3><ul>' + data.orphans.map(function (o) {
        var btns = S.me.isAdmin ? (o.moved ? '<button type="button" class="mini" data-act="relink" data-key="' + o.key + '" data-to="' + o.moved.key + '" data-staff="' + esc(o.staffId) + '" data-role="' + esc(o.role) + '">新しい日時に付け直す</button>' : '') +
          '<button type="button" class="mini ghost" data-act="unassign" data-key="' + o.key + '" data-staff="' + esc(o.staffId) + '" data-role="' + esc(o.role) + '">外す</button>' : '';
        return '<li><b>' + esc(o.title) + '</b>（元の日時 ' + esc(o.start) + '）— ' + esc(nameOf(o.staffId)) + '（' + (ROLE_SHORT[o.role] || esc(o.role)) + '）' +
          (o.moved ? '<br><span class="moved">→ 新しい日時 ' + esc(o.moved.start) + '</span>' : '<br><span class="moved">→ 見つかりません（削除された可能性）</span>') + ' ' + btns + '</li>';
      }).join('') + '</ul></div>';
    }
    byId('evOrphans').innerHTML = oh;

    if (!data.events.length) { byId('evList').innerHTML = '<p class="muted">この月の予定はありません。</p>'; return; }
    byId('evList').innerHTML = data.events.map(renderEventCard).join('');
    // 選んだだけでまだ保存していないプルダウンは、描き直しても選んだ値のままにする
    byId('evList').querySelectorAll('select[data-keep]').forEach(function (sel) {
      var v = S.selKeep[sel.dataset.keep];
      if (v != null && Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) sel.value = v;
    });
  }

  function renderEventCard(ev) {
    var open = S.openEvent === ev.key;
    var badges = '<span class="badge type">' + esc(ev.type) + (ev.typeFixed ? '✎' : '') + '</span>' +
      (ev.venue ? '<span class="badge venue">' + esc(ev.venue) + (ev.venueFixed ? '✎' : '') + '</span>' : '<span class="badge novenue">会場：' + (ev.venueFixed ? '絞らない✎' : '推定なし') + '</span>') +
      (ev.tentative ? '<span class="badge tent">仮</span>' : '') +
      (ev.cal === 'レッスン' ? '<span class="badge calsrc">MICレッスン</span>' : '');
    var assigned = ev.assigned.length ? ev.assigned.map(function (a) {
      var c = availOn(a.staffId, ev.dates);
      var warn = c.x ? ' <span class="warn">⚠×の日あり</span>' : (c.n ? ' <span class="warn">⚠未回答の日あり</span>' : '');
      return '<b>' + esc(nameOf(a.staffId)) + '</b>（' + (ROLE_SHORT[a.role] || esc(a.role)) + '）' + warn;
    }).join('、') : '<span class="muted">未定</span>';
    var h = '<article class="ev' + (open ? ' open' : '') + '" data-key="' + ev.key + '">' +
      '<div class="ev-date">' + evDateLabel(ev) + '</div>' +
      '<h3 class="ev-title">' + esc(ev.title) + '</h3>' +
      (ev.location ? '<div class="ev-loc">' + esc(ev.location) + '</div>' : '') +
      '<div class="badges">' + badges + '</div>' +
      '<div class="ev-assigned">担当：' + assigned + '</div>';
    if (S.me.isAdmin) {
      h += '<button type="button" class="ev-open' + (open ? ' is-open' : '') + '" data-act="open" data-key="' + ev.key + '">' +
        (open ? '閉じる ▴' : '<span class="ev-open-icon" aria-hidden="true">＋</span>担当を決める<small>空いている人を見る</small><span class="ev-open-arrow" aria-hidden="true">▾</span>') + '</button>';
      if (open) h += renderEventDetail(ev);
    }
    return h + '</article>';
  }

  function renderEventDetail(ev) {
    var h = '<div class="ev-detail">';
    ev.roles.forEach(function (role) {
      h += '<section class="role-sec"><h4>' + ROLE_LABEL[role] + '</h4>';
      var mine = ev.assigned.filter(function (a) { return a.role === role; });
      if (mine.length) {
        h += '<ul class="cand assigned">' + mine.map(function (a) {
          var c = availOn(a.staffId, ev.dates);
          return '<li><span class="nm">' + esc(nameOf(a.staffId)) + '</span><span class="av">' + c.label + '</span>' +
            (c.x ? '<span class="warn">⚠×の日あり</span>' : c.n ? '<span class="warn">⚠未回答の日あり</span>' : '') +
            '<button type="button" class="mini ghost" data-act="unassign" data-key="' + ev.key + '" data-staff="' + a.staffId + '" data-role="' + role + '"' + (S.evBusy ? ' disabled' : '') + '>外す</button></li>';
        }).join('') + '</ul>';
      }
      var top = ROLE_TOP[role];
      var rows = S.staff.map(function (st, i) {
        var r = S.roles[st.staffId] || null;
        return { st: st, i: i, c: availOn(st.staffId, ev.dates), pref: r ? r[role] : '', ok: venueOk(st.staffId, ev), hasRoles: !!r };
      }).filter(function (x) { return x.c.free && !mine.some(function (a) { return a.staffId === x.st.staffId; }); });
      var main = rows.filter(function (x) { return top.indexOf(x.pref) >= 0; });
      var rest = rows.filter(function (x) { return top.indexOf(x.pref) < 0; });
      main.sort(function (a, b) {
        return (b.ok - a.ok) || (top.indexOf(a.pref) - top.indexOf(b.pref)) || (b.c.full - a.c.full) || (a.i - b.i);
      });
      if (!main.length) h += '<p class="muted">空いていて、この役割を希望・可能としている人はいません。</p>';
      else h += '<ul class="cand">' + main.map(function (x) { return candRow(ev, role, x); }).join('') + '</ul>';
      if (rest.length) {
        h += '<p class="rest">ほかに空いている人：' + rest.map(function (x) {
          return esc(x.st.name) + '<small>（' + (x.pref ? esc(x.pref) : '役割未登録') + (x.ok ? '' : '・会場外') + '）</small>';
        }).join('、') + '</p>';
      }
      h += pickRow(ev, role, mine);
      h += '</section>';
    });
    var busy = S.staff.filter(function (st) { return !availOn(st.staffId, ev.dates).free; }).map(function (st) {
      return esc(st.name) + '<small>（' + availOn(st.staffId, ev.dates).label + '）</small>';
    });
    if (busy.length) h += '<p class="rest">行けない・未回答：' + busy.join('、') + '</p>';

    // 種類・会場の手直し（アプリ側だけに保存。カレンダーには書かない）
    h += '<div class="ev-meta"><h4>種類・会場を直す</h4>' +
      '<label>種類 <select name="type" data-keep="type:' + ev.key + '"><option value="">自動（' + esc(ev.typeAuto) + '）</option>' +
      EVENT_TYPES.map(function (t) { return '<option' + (ev.typeFixed && ev.type === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select></label>' +
      '<label>会場 <select name="venue" data-keep="venue:' + ev.key + '"><option value="">自動（' + esc(ev.venueAuto || '推定なし') + '）</option>' +
      S.venues.map(function (v) { return '<option' + (ev.venueFixed && ev.venue === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') +
      '<option value="' + VENUE_NONE + '"' + (ev.venueFixed && !ev.venue ? ' selected' : '') + '>会場で絞らない</option></select></label>' +
      '<button type="button" class="mini" data-act="meta" data-key="' + ev.key + '"' + (S.evBusy ? ' disabled' : '') + '>直す</button></div>';
    return h + '</div>';
  }

  /** 全員から選ぶ：候補にいない人（希望しない・未回答・×・会場外）も担当にできる */
  function pickRow(ev, role, mine) {
    var opts = S.staff.filter(function (st) { return !mine.some(function (a) { return a.staffId === st.staffId; }); }).map(function (st) {
      var c = availOn(st.staffId, ev.dates);
      var r = S.roles[st.staffId];
      var notes = [c.label];
      if (r && r[role]) notes.push(r[role] === '積極的にやりたい' ? '積極的' : r[role]);
      if (!venueOk(st.staffId, ev)) notes.push('会場外');
      return '<option value="' + esc(st.staffId) + '">' + esc(st.name) + '（' + esc(notes.join('・')) + '）</option>';
    });
    if (!opts.length) return '';
    return '<div class="pick"><label>全員から選ぶ <select data-keep="pick:' + ev.key + ':' + role + '" aria-label="' + ROLE_LABEL[role] + 'の担当を全員から選ぶ"><option value="">選んでください</option>' + opts.join('') + '</select></label>' +
      '<button type="button" class="mini" data-act="assign-pick" data-key="' + ev.key + '" data-role="' + role + '"' + (S.evBusy ? ' disabled' : '') + '>担当にする</button>' +
      '<small class="pick-hint">電話で頼んだ人など、アプリ未入力の人もここから選べます</small></div>';
  }

  function candRow(ev, role, x) {
    var tag = x.ok ? '' : '<span class="out">' + (x.hasRoles ? '会場外' : '会場未登録') + '</span>';
    var pref = x.pref === '積極的にやりたい' ? '<span class="pref hi">積極的</span>' : '<span class="pref">' + esc(x.pref) + '</span>';
    var note = x.c.notes.length ? '<small class="tnote">△ ' + esc(x.c.notes.join('／')) + '</small>' : '';
    var escortNote = role === 'escort' && x.pref === '条件付き' && S.roles[x.st.staffId].escort_note ? '<small class="tnote">条件：' + esc(S.roles[x.st.staffId].escort_note) + '</small>' : '';
    return '<li class="' + (x.ok ? '' : 'outside') + '"><span class="nm">' + esc(x.st.name) + '</span>' + pref +
      '<span class="av">' + x.c.label + '</span>' + tag +
      '<button type="button" class="mini" data-act="assign" data-key="' + ev.key + '" data-staff="' + x.st.staffId + '" data-role="' + role + '"' + (S.evBusy ? ' disabled' : '') + '>担当にする</button>' +
      note + escortNote + '</li>';
  }

  // ================================================================ スタッフ管理（④・管理者だけ）
  //
  // ★ トークン（URL）は、表示しているあいだ画面の入力欄にあるだけ。状態にも端末にも保存しない。

  function appUrlFor(t) { return location.origin + location.pathname + '#t=' + t; }

  function setupStaffAdmin() {
    if (!S.me.isAdmin) return;
    S.staffAdmin = null;
    byId('staffAdminList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || b.disabled || S.stBusy) return;
      var id = b.dataset.staff, name = b.dataset.name;
      if (b.dataset.act === 'url') {
        staffOp('staffUrl', { staffId: id }, function (r) { showUrl(name + 'さんのURL（本人にだけ送ってください）', r.token); });
      } else if (b.dataset.act === 'reissue') {
        if (!window.confirm(name + 'さんのURLを再発行します。\n今のURLはすぐ使えなくなります。よろしいですか？')) return;
        staffOp('reissueToken', { staffId: id }, function (r) {
          showUrl(name + 'さんの新しいURL（古いURLはもう使えません。本人にだけ送ってください）', r.token);
          loadStaffAdmin(true);
          refreshBoot();
        });
      } else if (b.dataset.act === 'disable' || b.dataset.act === 'enable') {
        var on = b.dataset.act === 'enable';
        if (!on && !window.confirm(name + 'さんのURLを無効にします。\nすぐ使えなくなり、みんなの予定にも出なくなります（入力済みの予定は消えません）。よろしいですか？')) return;
        staffOp('setActive', { staffId: id, active: on }, function (r) { S.staffAdmin = r.staff; hideUrl(); refreshBoot(); });
      }
    });
    byId('addStaffBtn').addEventListener('click', function () {
      var name = byId('newName').value.trim();
      if (!name) { setStStatus('ng', '表示名を入れてください'); return; }
      staffOp('addStaff', { name: name }, function (r) {
        byId('newName').value = '';
        showUrl(r.name + 'さん（' + r.staffId + '）を追加しました。URL（本人にだけ送ってください）', r.token);
        loadStaffAdmin(true);
        refreshBoot();
      });
    });
    byId('reissueAdminBtn').addEventListener('click', function () {
      if (!window.confirm('管理者URLを再発行します。\n今開いているこのURLもすぐ使えなくなります。新しいURLを必ず控えてください。よろしいですか？')) return;
      staffOp('reissueAdmin', {}, function (r) {
        dropLocalCache();   // 古いURLの前回の内容は使わない
        showUrl('新しい管理者URL（必ず控えてください。今のURLはもう使えません）', r.token);
        S.newAdminUrl = appUrlFor(r.token);
        byId('openNewAdmin').hidden = false;
      });
    });
    byId('copyUrl').addEventListener('click', function () {
      var input = byId('urlText');
      var done = function () { byId('copyMsg').textContent = '✓ コピーしました'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(done, function () { input.select(); byId('copyMsg').textContent = '選択しました。長押しでコピーしてください'; });
      } else { input.select(); byId('copyMsg').textContent = '選択しました。長押しでコピーしてください'; }
    });
    byId('openNewAdmin').addEventListener('click', function () {
      if (!S.newAdminUrl) return;
      location.replace(S.newAdminUrl);
      location.reload();
    });
    byId('hideUrl').addEventListener('click', hideUrl);
  }

  function showUrl(label, t) {
    byId('urlLabel').textContent = label;
    byId('urlText').value = appUrlFor(t);
    byId('copyMsg').textContent = '';
    byId('openNewAdmin').hidden = true;
    byId('urlBox').hidden = false;
    byId('urlBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function hideUrl() {
    byId('urlBox').hidden = true;
    byId('urlText').value = '';   // 画面からも消す
    byId('copyMsg').textContent = '';
  }

  function setStStatus(kind, text) {
    var el = byId('stStatus');
    el.textContent = text;
    el.className = 'ev-status ' + kind;
  }

  function loadStaffAdmin(force) {
    if (!S.me.isAdmin || (S.staffAdmin && !force)) { renderStaffAdmin(); return; }
    setStStatus('busy', '読み込み中…');
    api('staffList').then(function (r) {
      S.staffAdmin = r.staff;
      setStStatus('', '');
    }, function (e) {
      setStStatus('ng', '⚠ 読み込めませんでした：' + e.message);
    }).then(renderStaffAdmin);
  }

  function staffOp(action, payload, done) {
    S.stBusy = true;
    setStStatus('busy', '保存中…');
    renderStaffAdmin();
    api(action, payload).then(function (r) {
      setStStatus('ok', '✓ 保存しました');
      done(r);
    }, function (e) {
      setStStatus('ng', '⚠ できませんでした：' + e.message);
    }).then(function () { S.stBusy = false; renderStaffAdmin(); });
  }

  function renderStaffAdmin() {
    if (!S.me || !S.me.isAdmin) return;
    var list = S.staffAdmin || [];
    byId('staffAdminList').innerHTML = list.map(function (st) {
      var dis = S.stBusy ? ' disabled' : '';
      var nm = esc(st.name), id = esc(st.staffId);
      return '<li class="' + (st.active ? '' : 'inactive') + '"><div class="who"><b>' + nm + '</b><small>' + id + '</small>' +
        '<span class="badge ' + (st.active ? 'venue' : 'novenue') + '">' + (st.active ? '有効' : '無効') + '</span></div>' +
        '<div class="acts">' +
        (st.active ? '<button type="button" class="mini" data-act="url" data-staff="' + id + '" data-name="' + nm + '"' + dis + '>URLを表示</button>' : '') +
        '<button type="button" class="mini" data-act="reissue" data-staff="' + id + '" data-name="' + nm + '"' + dis + '>再発行</button>' +
        (st.active
          ? '<button type="button" class="mini ghost" data-act="disable" data-staff="' + id + '" data-name="' + nm + '"' + dis + '>無効にする</button>'
          : '<button type="button" class="mini" data-act="enable" data-staff="' + id + '" data-name="' + nm + '"' + dis + '>有効に戻す</button>') +
        '</div></li>';
    }).join('');
    byId('addStaffBtn').disabled = !!S.stBusy;
    byId('reissueAdminBtn').disabled = !!S.stBusy;
  }

  // ================================================================ AIに質問（管理者だけ）
  //
  // ★ 会話はこの画面の中だけに持つ（端末に保存しない）。閉じると消える。
  // ★ 続きの質問のために、直前の3往復だけを文字でサーバーへ渡す。

  var AI_TIMEOUT_MS = 120000;   // Claude を何回か呼ぶので、ふつうの操作より長く待つ

  function setupAi() {
    if (!S.me.isAdmin) return;
    S.ai = [];   // { q, a, error, busy }
    byId('aiForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      askAi(byId('aiInput').value);
    });
    byId('aiExamples').querySelectorAll('.chip').forEach(function (b) {
      b.addEventListener('click', function () { askAi(b.textContent); });
    });
    byId('aiClear').addEventListener('click', function () {
      if (S.aiBusy) return;
      S.ai = [];
      renderAi();
    });
    renderAi();
  }

  function askAi(text) {
    var q = String(text || '').trim();
    if (!q || S.aiBusy) return;
    var history = S.ai.filter(function (t) { return t.a && !t.error; }).slice(-3).map(function (t) { return { q: t.q, a: t.a }; });
    var turn = { q: q, a: '', busy: true };
    S.ai.push(turn);
    S.aiBusy = true;
    byId('aiInput').value = '';
    renderAi();
    api('aiAsk', { question: q, history: history }, AI_TIMEOUT_MS).then(function (r) {
      turn.a = r.answer;
      S.aiUsage = r.used + ' / ' + r.limit + '回';
    }, function (e) {
      turn.error = true;
      turn.a = e.message;
    }).then(function () {
      turn.busy = false;
      S.aiBusy = false;
      renderAi();
    });
  }

  function renderAi() {
    if (!S.me || !S.me.isAdmin || !S.ai) return;
    byId('aiLog').innerHTML = S.ai.map(function (t) {
      return '<div class="ai-q">' + esc(t.q) + '</div>' +
        (t.busy ? '<div class="ai-a busy">考え中…（10〜30秒ほどかかります）</div>'
          : '<div class="ai-a' + (t.error ? ' ng' : '') + '">' + (t.error ? '⚠ ' : '') + esc(t.a) + '</div>');
    }).join('');
    byId('aiSend').disabled = !!S.aiBusy;
    byId('aiExamples').querySelectorAll('.chip').forEach(function (b) { b.disabled = !!S.aiBusy; });
    byId('aiClear').hidden = !S.ai.length;
    byId('aiUsage').textContent = S.aiUsage ? '今日の利用：' + S.aiUsage : '';
    var last = byId('aiLog').lastElementChild;
    if (last && S.tab === 'ai' && last.scrollIntoView) last.scrollIntoView({ block: 'nearest' });
  }

  // ================================================================ 描画まとめ

  function renderMonthLabels() {
    var months = monthsOf(S.period);
    var i = months.indexOf(S.month);
    document.querySelectorAll('.month-nav').forEach(function (nav) {
      nav.querySelector('.month-label').textContent = S.month.slice(0, 4) + '年' + (+S.month.slice(5, 7)) + '月';
      nav.querySelector('.prev').disabled = i <= 0;
      nav.querySelector('.next').disabled = i >= months.length - 1;
    });
  }

  function renderSaveState() {
    var el = byId('saveState');
    var n = pendingCount();
    var text = '', cls = 'save-state';
    if (S.inflight) { text = '保存中…'; cls += ' busy'; }
    else if (S.error && n) { text = '⚠ 保存できていない日が ' + n + '日 あります'; cls += ' ng'; }
    else if (n) { text = '保存待ち…'; cls += ' busy'; }
    else if (S.lastSaved) { text = '✓ 保存しました ' + pad(S.lastSaved.getHours()) + ':' + pad(S.lastSaved.getMinutes()); cls += ' ok'; }
    el.textContent = text;
    el.className = cls;
    var banner = byId('errorBanner');
    banner.hidden = !(S.error && n && !S.inflight);
    if (!banner.hidden) byId('errorText').textContent = '保存できませんでした：' + S.error;
  }

  function renderAll() {
    if (!S.me || !S.uiReady || S.dead) return;
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });
    ['mine', 'all', 'events', 'roles', 'staff', 'ai'].forEach(function (t) { byId('tab-' + t).hidden = S.tab !== t; });
    renderMonthLabels();
    renderMine();
    renderGrid();
    renderEvents();
    renderRolesTable();
    renderSaveState();
    renderAsOf();
  }

  // ================================================================ 小物

  function byId(id) { return document.getElementById(id); }
  function show(id) { byId(id).hidden = false; }
  function hide(id) { byId(id).hidden = true; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // デモ（apiUrl が空）のときだけ demo.js を読む。本番では読み込まない
  if (DEMO && !window.MicDemo) {
    var ds = document.createElement('script');
    ds.src = 'demo.js';
    ds.onload = start;
    ds.onerror = function () { fatal('デモ用のファイルを読めませんでした'); };
    document.head.appendChild(ds);
  } else {
    start();
  }
})();
