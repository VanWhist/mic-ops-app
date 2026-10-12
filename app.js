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
    var boot = S.family
      ? { me: S.meOrig, staff: [], athletes: S.athletes, myAthletes: S.myAthletes, athleteAvailability: S.avail, period: S.period }
      : { me: S.me, staff: S.staff, roles: S.roles, availability: S.avail, period: S.period, venues: S.venues, athletes: S.athletes, athleteAvailability: S.aAvail };
    var store = { savedAt: Date.now(), bootAt: S.bootAt, boot: boot, events: events };
    if (S.inEv) store.inEv = S.inEv;   // 「自分の予定」に出す合宿・大会（v13〜）
    try { localStorage.setItem(cacheKey, JSON.stringify(store)); }
    catch (e) { /* 容量不足などでも、キャッシュなしで動く */ }
  }

  function dropLocalCache() {
    if (!cacheKey) return;
    try { localStorage.removeItem(cacheKey); } catch (e) { /* なにもしない */ }
  }

  /** bootstrap の結果を画面の状態へ入れる。fetchStart 以降に保存した自分の日・役割は手元の値を残す */
  function applyBoot(r, fetchStart) {
    if (r.me && r.me.isFamily) return applyFamilyBoot(r, fetchStart);
    S.athletes = r.athletes || []; S.aAvail = r.athleteAvailability || {};
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

  /**
   * 家族（v11〜）：選手を「人」として、スタッフ画面と同じ入力・一覧のしくみに載せる。
   *   S.staff ＝ 全選手（一覧の行）、S.avail ＝ 選手の○△×、S.me.staffId ＝ いま入力している選手（タブで切り替え）
   * ★ 書けるのは自分の家族の選手だけ（サーバーで判定）。保存待ちがある間は選手を切り替えない
   */
  function applyFamilyBoot(r, fetchStart) {
    var fresh = r.athleteAvailability || {};
    if (fetchStart && S.family) {
      // 取得中に保存した日は手元の値を残す（自分の家族の選手の分）
      (S.myAthletes || []).forEach(function (id) {
        var oldM = S.avail[id];
        if (!oldM) return;
        var newM = fresh[id] || (fresh[id] = {});
        Object.keys(S.savedAt).forEach(function (d) {
          if (S.savedAt[d] < fetchStart) return;
          if (oldM[d]) newM[d] = oldM[d]; else delete newM[d];
        });
      });
    }
    S.family = true;
    S.meOrig = r.me;
    S.athletes = r.athletes || [];
    S.myAthletes = (r.myAthletes || []).filter(function (id) { return S.athletes.some(function (a) { return a.athleteId === id; }); });
    if (S.myAthletes.indexOf(S.curAthlete) < 0) S.curAthlete = S.myAthletes[0] || null;
    S.staff = S.athletes.map(function (a) { return { staffId: a.athleteId, name: a.name, familyId: a.familyId }; });
    S.avail = fresh; S.roles = {}; S.venues = []; S.period = r.period;
    S.me = Object.assign({}, r.me, { staffId: S.curAthlete });
  }

  /** 家族：入力する選手を切り替える（保存待ちがあれば先に保存する） */
  function switchAthlete(id) {
    if (id === S.curAthlete) return;
    if (S.inflight || pendingCount()) {
      flush().then(function () { if (!pendingCount() && !S.inflight) switchAthlete(id); });
      return;
    }
    S.curAthlete = id;
    S.me.staffId = id;
    S.noteDates = [];
    S.rangeStart = null;
    renderAll();
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
    // 家族は選手を指定する（「兄弟にも同じ印」なら兄弟全員）。スタッフは本人の分（サーバーがトークンで決める）
    var payload = S.family ? { days: days, athleteIds: S.sibAll ? S.myAthletes.slice() : [S.me.staffId] } : { days: days };
    return api('saveDays', payload).then(function (r) {
      var ids = r.athleteIds || [S.me.staffId];
      r.saved.forEach(function (x) {
        ids.forEach(function (id) {
          var m = S.avail[id] || (S.avail[id] = {});
          if (x.status) m[x.date] = { s: x.status, n: x.note || '' }; else delete m[x.date];
        });
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
      renderTabsBadge();   // ○を付けた日の受付中の予定が「参加しますか？」に増える
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
        if (c.inEv && typeof c.inEv === 'object') S.inEv = c.inEv;
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
    byId('who').textContent = S.me.isAdmin ? '管理者' : S.family ? S.me.name : S.me.name + 'さん';
    if (S.family) setupFamilyUI();
    setupTabs();
    setupMine();
    setupAll();
    setupRoles();
    setupEvents();
    setupPlan();
    setupStaffAdmin();
    setupFamilyAdmin();
    setupAi();
    setupCalSync();
    renderAll();
    if (S.tab === 'events' || S.family) loadEvents(S.month);   // 家族は「参加しますか？」の件数をタブに出すため最初に読む
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
        ['tabs', 'tab-mine', 'tab-all', 'tab-plan', 'tab-events', 'tab-roles', 'tab-staff', 'aiFab', 'aiPanel', 'staleBanner', 'errorBanner'].forEach(hide);
        document.body.classList.remove('has-ai');
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
    applyAppName();   // 使えないURLなら中立の名前に戻す
  }

  // ================================================================ 家族の画面（v11〜）

  function setupFamilyUI() {
    // タブ：入力・みんなの予定・練習会など（役割・スタッフ管理は出さない。AIは右下のボタン・v18〜）
    var label = { mine: '予定を入力', all: 'みんなの予定', events: '練習会など' };
    document.querySelectorAll('.tab').forEach(function (b) {
      if (label[b.dataset.tab]) b.textContent = label[b.dataset.tab];
    });
    // ペンの言葉：○△×は空き状況（参加の申し込みではない）。「行ける／未定／行けない」（城さん確定 2026-10-11）
    var penLabel = { '○': '行ける', '△': '未定', '×': '行けない' };
    document.querySelectorAll('.pen').forEach(function (b) {
      if (penLabel[b.dataset.pen]) b.innerHTML = '<b>' + b.dataset.pen + '</b>' + penLabel[b.dataset.pen];
    });
    byId('noteWarn').innerHTML = '備考は<strong>全員（ほかの家族・スタッフ）に見えます</strong>。個人的な事情は書かず、「午後のみ」「10時から」のように書いてください。';
    byId('athTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-ath]');
      if (b) switchAthlete(b.dataset.ath);
    });
    byId('sibAll').addEventListener('change', function (e) { S.sibAll = e.target.checked; renderMine(); });
    document.querySelector('#tab-events .hint').textContent = 'これからの練習会・合宿・大会です。参加の受付中の予定は、選手ごと・日ごとに参加の仕方を選んで［この内容で保存］を押してください。';
    document.querySelector('#tab-events .month-nav').hidden = true;   // 月ごとではなく、これからの予定をまとめて出す
    byId('evList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-ad]');
      if (!b || b.disabled || S.ansBusy) return;
      answerClick(b);
    });
    // 日ごとの備考（v16〜）：打つたびに下書きへ。描き直さず（入力中の文字を消さないように）「まだ保存していません」だけ出し入れする
    byId('evList').addEventListener('input', function (e) {
      var t = e.target;
      if (!t.dataset || !t.dataset.adn) return;
      var dr = draftOf(t.dataset.key, t.dataset.id);
      var v = dr[t.dataset.date] || (dr[t.dataset.date] = {});
      v.n = t.value;
      var ev = upcomingEvent(t.dataset.key);
      document.querySelectorAll('#evList .ans-ath[data-key="' + t.dataset.key + '"][data-id="' + t.dataset.id + '"]').forEach(function (blk) {
        var dirty = ev && draftDirty(ev, t.dataset.id);
        blk.classList.toggle('dirty', !!dirty);
        blk.querySelector('.ans-unsaved').hidden = !dirty;
        // 予定が「参加しますか？」と一覧の両方に出ているときは、もう片方の欄にも同じ文字を入れる
        blk.querySelectorAll('[data-adn][data-date="' + t.dataset.date + '"]').forEach(function (x) { if (x !== t) x.value = t.value; });
      });
    });
    byId('evList').addEventListener('change', function (e) {
      var t = e.target;
      if (!t.dataset || !t.dataset.adt) return;
      var dr = draftOf(t.dataset.key, t.dataset.id);
      var v = dr[t.dataset.date] || (dr[t.dataset.date] = { k: '時間' });
      v[t.dataset.adt] = t.value;
      renderUpcoming();
    });
    document.querySelector('#tab-all .hint').textContent = '全選手の○△×です（見るだけ）。日付をタップすると、その日の○・△の人を表示します。';
  }

  function renderAthTabs() {
    if (!S.family) return;
    var many = S.myAthletes.length > 1;
    var tabs = byId('athTabs');
    tabs.hidden = !many;
    byId('sibWrap').hidden = !many;
    tabs.innerHTML = S.myAthletes.map(function (id) {
      var a = S.staff.filter(function (x) { return x.staffId === id; })[0];
      return '<button type="button" class="ath-tab' + (id === S.curAthlete ? ' on' : '') + '" data-ath="' + esc(id) + '">' + esc(a ? a.name : id) + '</button>';
    }).join('');
  }

  // ================================================================ タブ

  // 家族：保存していない参加の回答があるまま閉じる・再読み込みするときは、ブラウザに確かめてもらう（v15〜）
  window.addEventListener('beforeunload', function (e) {
    if (S.me && S.family && hasUnsavedAnswers()) { e.preventDefault(); e.returnValue = ''; }
  });

  function setupTabs() {
    var nav = byId('tabs');
    nav.hidden = false;
    nav.querySelectorAll('.tab').forEach(function (b) {
      if (S.me.isAdmin && b.dataset.tab === 'mine') b.hidden = true;
      if (b.dataset.tab === 'staff' || b.dataset.tab === 'plan') b.hidden = !S.me.isAdmin;
      // 管理者はタブが6つになるので、2つを短くして1行に収める（v14〜）
      if (S.me.isAdmin && b.dataset.tab === 'roles') b.textContent = '役割';
      if (S.me.isAdmin && b.dataset.tab === 'staff') b.textContent = '管理';
      if (b.dataset.tab === 'roles' && S.family) b.hidden = true;
      b.addEventListener('click', function () {
        if (S.family && S.tab === 'events' && b.dataset.tab !== 'events' && hasUnsavedAnswers() && !window.confirm(UNSAVED_MSG)) return;
        S.tab = b.dataset.tab;
        renderAll();
        if (S.tab === 'events') { if (S.family) S.ansMsg = null; loadEvents(S.month, !!S.family); }   // 家族は開くたびに最新の受付・回答を読む
        if (S.tab === 'staff') { loadStaffAdmin(); loadFamilies(); loadAiSuggestions(); }
        if (S.tab === 'plan') renderPlan();
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

  // ---------------------------------------------------------------- 入力カレンダーに練習会・合宿・大会（v13〜、v17〜全スタッフと家族・練習会も）

  /** 予定の種類 → 帯の色（練習会＝緑、合宿＝紫、大会＝橙） */
  function inEvClass(type) { return type === '大会' ? 'ev-comp' : type === '練習' ? 'ev-prac' : 'ev-camp'; }
  // settings の events_on_input の人（既定 ALL＝全スタッフと家族。S001 にすれば城さんだけ）。タイトルと日付だけ（説明文は受け取らない）

  function loadInputEvents(month) {
    S.inEv = S.inEv || {};
    S.inEvAsked = S.inEvAsked || {};
    if (S.inEvAsked[month]) return;   // この画面を開いている間は月ごとに1回（サーバー側は10分キャッシュ）
    S.inEvAsked[month] = true;
    api('inputEvents', { month: month }).then(function (r) {
      S.inEv[month] = r.events || [];
      saveCache();
      if (S.month === month) renderMine();
    }, function () { S.inEvAsked[month] = false; /* 出せなくても入力には影響させない */ });
  }

  /** 日付 → その日の合宿・大会（合宿・大会の順。前の月から続く行事も、その月に読んだ分で出す） */
  function inputEventsByDay() {
    var out = {};
    if (!S.me.eventsOnInput || !S.inEv) return out;
    var seen = {};
    Object.keys(S.inEv).forEach(function (m) {
      (S.inEv[m] || []).forEach(function (ev) {
        if (seen[ev.key]) return;
        seen[ev.key] = true;
        ev.dates.forEach(function (d) { (out[d] = out[d] || []).push(ev); });
      });
    });
    return out;
  }

  /** マスの中は短く：先頭の（仮）などは外す（一覧には元のタイトルを出す） */
  function shortTitle(t) {
    return String(t).replace(/^[（(]仮[）)]\s*/, '').replace(/\s+/g, '');
  }

  function renderInputEventList() {
    var box = byId('inEvList');
    var list = (S.me.eventsOnInput && S.inEv && S.inEv[S.month]) || [];
    box.hidden = !list.length;
    box.innerHTML = list.length ? '<span class="lbl">この月の練習会・合宿・大会</span>' + list.map(function (ev) {
      var a = ev.dates[0], b = ev.dates[ev.dates.length - 1];
      return '<span class="item"><span class="sw ' + inEvClass(ev.type) + '">' + esc(ev.type === '練習' ? '練習会' : ev.type) + '</span>' +
        esc(md(a) + (b !== a ? '〜' + md(b) : '')) + ' ' + esc(ev.title) + '</span>';
    }).join('') : '';
  }

  function renderMine() {
    if (S.me.isAdmin) return;
    renderMonthLabels();
    renderAthTabs();
    if (S.family && !S.curAthlete) {
      byId('cal').innerHTML = '';
      byId('mineSummary').textContent = '選手がまだ登録されていません。管理者に連絡してください。';
      return;
    }
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
    var PEN_NAME = S.family ? { '○': '行ける', '△': '未定', '×': '行けない' } : { '○': '行ける', '△': '条件付き', '×': '行けない' };
    var who = S.family ? esc(nameOf(S.curAthlete)) + (S.sibAll ? 'と兄弟' : '') + 'の' : '';
    byId('penNow').innerHTML = S.pen
      ? who + '<span class="mk ' + STATUS_CLASS[S.pen] + '">' + S.pen + '</span>（' + PEN_NAME[S.pen] + '）を入力中' + (S.range ? '・期間でまとめて' : '')
      : '<span class="mk s-n">消</span>消す（未入力に戻す）を入力中' + (S.range ? '・期間でまとめて' : '');

    var cal = byId('cal');
    var days = daysOf(S.month);
    var html = '';
    for (var i = 0; i < weekday(days[0]); i++) html += '<span class="blank"></span>';
    var today = todayJst();
    var evDay = inputEventsByDay();
    days.forEach(function (d) {
      var v = valueOf(S.me.staffId, d);
      var w = weekday(d);
      var cls = ['day', STATUS_CLASS[v.s]];
      if (w === 0 || HOLIDAYS[d]) cls.push('sun'); else if (w === 6) cls.push('sat');
      if (S.pending.hasOwnProperty(d)) cls.push('pending');
      if (S.failed[d]) cls.push('failed');
      if (S.rangeStart === d) cls.push('range-start');
      if (d === today) cls.push('today');
      var evs = evDay[d] || [];
      if (evs.length) cls.push('has-ev');
      var label = longDate(d) + ' ' + (v.s || '未回答') + (v.n ? ' ' + v.n : '') + evs.map(function (e) { return '（' + e.type + '：' + e.title + '）'; }).join('');
      html += '<button type="button" class="' + cls.join(' ') + '" data-date="' + d + '" aria-label="' + esc(label) + '">' +
        '<span class="dn">' + parts(d)[2] + '</span><span class="mk">' + esc(v.s) + '</span>' +
        (v.n ? '<span class="nd" aria-hidden="true"></span>' : '') +
        (evs.length ? '<span class="dev ' + inEvClass(evs[0].type) + '" aria-hidden="true">' + esc(shortTitle(evs[0].title)) + (evs.length > 1 ? '+' + (evs.length - 1) : '') + '</span>' : '') +
        '</button>';
    });
    cal.innerHTML = html;
    renderInputEventList();
    if (S.me.eventsOnInput) loadInputEvents(S.month);

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
    // スタッフ・管理者：「選手」に切り替えると、選手の○△×を見られる（見るだけ）
    byId('allView').hidden = !!S.family;
    byId('allView').addEventListener('change', function (e) {
      if (e.target.name !== 'allView') return;
      S.allView = e.target.value;
      S.selectedDay = null;
      renderAll();
    });
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
      applyBoot(r);
      btn.textContent = '最新にする';
    }, function (e) {
      btn.textContent = '読み込めませんでした（もう一度）';
    }).then(function () { btn.disabled = false; renderAll(); });
  }

  /** みんなの予定の行：スタッフ（家族の画面では選手）か、スタッフ・管理者が「選手」を選んだときの選手 */
  function gridAthletes() { return !S.family && S.allView === 'athletes'; }
  function gridRows() {
    return gridAthletes() ? (S.athletes || []).map(function (a) { return { staffId: a.athleteId, name: a.name }; }) : S.staff;
  }
  function gridVal(id, d) {
    if (!gridAthletes()) return valueOf(id, d);
    var m = (S.aAvail || {})[id];
    return (m && m[d]) || { s: '', n: '' };
  }

  function renderGrid() {
    var rows = gridRows();
    var today = todayJst();
    var days = daysOf(S.month).filter(function (d) { return !S.weekendOnly || isOff(d) || d === today; });
    var h = '<thead><tr><th class="corner">' + (+S.month.slice(5, 7)) + '月</th>';
    days.forEach(function (d) {
      var w = weekday(d);
      var c = (w === 0 || HOLIDAYS[d]) ? 'sun' : (w === 6 ? 'sat' : '');
      h += '<th class="dh ' + c + (S.selectedDay === d ? ' sel' : '') + (d === today ? ' today' : '') + '"><button type="button" data-day="' + d + '">' +
        parts(d)[2] + '<small>' + WD[w] + '</small></button></th>';
    });
    h += '</tr>';
    if (!S.family) {
      // 日ごとの○の人数（v14〜・表の一番上にも）
      h += '<tr class="ocount"><th class="nm">○の人数</th>' + days.map(function (d) {
        return '<td>' + rows.filter(function (st) { return gridVal(st.staffId, d).s === '○'; }).length + '</td>';
      }).join('') + '</tr>';
    }
    h += '</thead><tbody>';
    rows.forEach(function (st) {
      var self = !gridAthletes() && S.me.staffId === st.staffId;
      h += '<tr' + (self ? ' class="self"' : '') + '><th class="nm">' + esc(st.name) + '</th>';
      days.forEach(function (d) {
        var v = gridVal(st.staffId, d);
        h += '<td class="' + STATUS_CLASS[v.s] + (S.selectedDay === d ? ' sel' : '') + (d === today ? ' today' : '') + '"' + (v.n ? ' title="' + esc(v.n) + '"' : '') + '>' +
          esc(v.s) + (v.n ? '<i class="nd"></i>' : '') + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody><tfoot><tr><th class="nm">○の人数</th>';
    days.forEach(function (d) {
      var n = rows.filter(function (st) { return gridVal(st.staffId, d).s === '○'; }).length;
      h += '<td>' + n + '</td>';
    });
    h += '</tr></tfoot>';
    byId('grid').innerHTML = !rows.length ? '<tbody><tr><td>' + (gridAthletes() || S.family ? '選手がまだ登録されていません' : '') + '</td></tr></tbody>'
      : days.length ? h : '<tbody><tr><td>この月に表示する日がありません</td></tr></tbody>';
    renderDayDetail();
  }

  function renderDayDetail() {
    var el = byId('dayDetail');
    var d = S.selectedDay;
    if (!d || d.slice(0, 7) !== S.month) { el.hidden = true; return; }
    var by = { '○': [], '△': [], '×': [], '': [] };
    var rows = gridRows();
    rows.forEach(function (st) { by[gridVal(st.staffId, d).s].push(st); });

    var h = '<h3>' + longDate(d) + '</h3>';
    if (S.family || gridAthletes()) {
      // 選手：○・△（備考）・×・未回答を並べるだけ（役割は無い）
      h += '<h4><span class="mk s-o">○</span> 行ける ' + by['○'].length + '人</h4>' + (by['○'].length ? '<p>' + by['○'].map(function (st) { return esc(st.name); }).join('、') + '</p>' : '');
      h += '<h4><span class="mk s-t">△</span> 未定 ' + by['△'].length + '人</h4>' + (by['△'].length ? '<ul class="plain">' + by['△'].map(function (st) {
        var n = gridVal(st.staffId, d).n;
        return '<li>' + esc(st.name) + (n ? '：' + esc(n) : '') + '</li>';
      }).join('') + '</ul>' : '');
      h += '<h4><span class="mk s-x">×</span> 行けない ' + by['×'].length + '人</h4>' + (by['×'].length ? '<p>' + by['×'].map(function (st) { return esc(st.name); }).join('、') + '</p>' : '');
      h += '<h4><span class="mk s-n"></span> 未回答 ' + by[''].length + '人</h4>' + (by[''].length ? '<p>' + by[''].map(function (st) { return esc(st.name); }).join('、') + '</p>' : '');
      el.innerHTML = h;
      el.hidden = false;
      return;
    }
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
    if (S.me.isAdmin || S.family) return;
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
  var EVENT_TYPES = ['練習', '合宿', '大会', '一般レッスン', '不在', '未分類'];
  var VENUE_NONE = 'なし';

  // ================================================================ カレンダーへの反映・Deacon の指導日（管理者だけ）
  //
  // ★ 反映は「カレンダーに反映」ボタンだけ（担当の保存では反映しない）。担当などを変えたら「未反映の変更あり」を出す。
  // ★ サーバーは1回に40件まで直し、残りがあれば more:true を返すので、終わるまで続けて呼ぶ。

  var CAL_SYNC_TIMEOUT_MS = 300000;

  function setupCalSync() {
    if (!S.me.isAdmin) return;
    S.cal = null;
    byId('calBar').hidden = false;
    byId('deaconBox').hidden = false;
    byId('dcVenue').innerHTML = '<option value="">会場（未定）</option>' + S.venues.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');
    var months = monthsOf(S.period);
    byId('dcDate').min = months[0] + '-01';
    byId('dcDate').max = months[months.length - 1] + '-31';
    byId('calSyncBtn').addEventListener('click', runCalSync);
    byId('dcAdd').addEventListener('click', function () {
      deaconOp('deaconSave', { date: byId('dcDate').value, start: byId('dcStart').value, end: byId('dcEnd').value, venue: byId('dcVenue').value }, function () {
        byId('dcDate').value = ''; byId('dcStart').value = ''; byId('dcEnd').value = '';
      });
    });
    byId('deaconList').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-dc]');
      if (!b || S.dcBusy) return;
      if (b.dataset.dc === 'delete' && !confirm('この指導日を消しますか？（付けた担当も外れます）')) return;
      if (b.dataset.dc === 'delete') deaconOp('deaconDelete', { id: b.dataset.id });
      else deaconOp('deaconConfirm', { id: b.dataset.id, confirmed: b.dataset.dc === 'confirm' });
    });
  }

  function loadCalStatus() {
    if (!S.me.isAdmin) return;
    api('calStatus').then(function (r) { S.cal = r; }, function (e) {
      S.cal = { error: /不明な操作/.test(e.message) ? 'サーバー側（Apps Script）がまだ古い版です' : e.message };
    }).then(renderCalBar);
    api('deaconList').then(function (r) { S.deacon = r.items; renderDeacon(); }, function () {});
  }

  function stampLabel(s) {
    return s ? (+s.slice(5, 7)) + '/' + (+s.slice(8, 10)) + ' ' + s.slice(11, 16) : '';
  }

  function renderCalBar() {
    if (!S.me.isAdmin) return;
    var c = S.cal || {};
    var info = byId('calInfo');
    byId('calSyncBtn').disabled = !!S.calBusy || !c.configured;
    byId('calDirty').hidden = !c.dirty || !!S.calBusy;
    if (S.calMsg) { info.textContent = S.calMsg.text; info.className = 'ev-status ' + S.calMsg.kind; return; }
    info.className = 'ev-status';
    if (c.error) { info.textContent = '⚠ ' + c.error; info.className = 'ev-status ng'; }
    else if (!S.cal) info.textContent = '';
    else if (!c.configured) info.textContent = '反映先のカレンダー「MIC 予定（アプリ）」がまだありません（エディタで setupAppCalendar を実行）';
    else info.textContent = '「' + c.calendarName + '」へ反映。' + (c.syncedAt ? '最終反映：' + stampLabel(c.syncedAt) : 'まだ反映していません');
  }

  function runCalSync() {
    if (S.calBusy) return;
    S.calBusy = true;
    var sum = { created: 0, updated: 0, deleted: 0, failed: 0 };
    var progress = function () { return '作成' + sum.created + '・更新' + sum.updated + '・削除' + sum.deleted + (sum.failed ? '・失敗' + sum.failed : ''); };
    S.calMsg = { kind: 'busy', text: '反映中…' };
    renderCalBar();
    var step = function () {
      return api('calSync', {}, CAL_SYNC_TIMEOUT_MS).then(function (r) {
        Object.keys(sum).forEach(function (k) { sum[k] += r.result[k] || 0; });
        S.cal = Object.assign({}, S.cal, { syncedAt: r.syncedAt || (S.cal && S.cal.syncedAt), dirty: r.dirty });
        if (r.more) { S.calMsg = { kind: 'busy', text: '反映中…（' + progress() + '）' }; renderCalBar(); return step(); }
      });
    };
    step().then(function () {
      S.calMsg = sum.failed
        ? { kind: 'ng', text: '⚠ 一部反映できませんでした（' + progress() + '）。もう一度押してください' }
        : { kind: 'ok', text: '✓ 反映しました（' + progress() + '）最終反映：' + stampLabel(S.cal.syncedAt) };
    }, function (e) {
      S.calMsg = { kind: 'ng', text: '⚠ 反映できませんでした：' + e.message };
    }).then(function () { S.calBusy = false; renderCalBar(); });
  }

  function deaconOp(action, payload, done) {
    S.dcBusy = true;
    byId('dcMsg').textContent = '保存中…'; byId('dcMsg').className = 'ev-status busy';
    renderDeacon();
    api(action, payload).then(function (r) {
      S.deacon = r.items;
      byId('dcMsg').textContent = '✓ 保存しました'; byId('dcMsg').className = 'ev-status ok';
      if (done) done();
      if (S.cal) S.cal.dirty = true;
      S.calMsg = null;
      renderCalBar();
      loadEvents(S.month, true);   // 予定の一覧にも出す
    }, function (e) {
      byId('dcMsg').textContent = '⚠ できませんでした：' + e.message; byId('dcMsg').className = 'ev-status ng';
    }).then(function () { S.dcBusy = false; renderDeacon(); });
  }

  function renderDeacon() {
    if (!S.me.isAdmin) return;
    var list = S.deacon || [];
    byId('deaconCount').textContent = list.length ? '（' + list.length + '件・未確定' + list.filter(function (x) { return !x.confirmed; }).length + '）' : '';
    byId('dcAdd').disabled = !!S.dcBusy;
    byId('deaconList').innerHTML = list.length ? list.map(function (x) {
      var dis = S.dcBusy ? ' disabled' : '';
      return '<li><span class="dc-when">' + md(x.date) + '（' + WD[weekday(x.date)] + '）' + (x.start ? ' ' + esc(x.start) + '–' + esc(x.end) : ' 終日') + '</span>' +
        (x.venue ? '<span class="badge venue">' + esc(x.venue) + '</span>' : '') +
        (x.confirmed ? '<span class="badge type">確定</span>' : '<span class="badge tent">仮</span>') +
        '<span class="dc-acts">' + (x.confirmed
          ? '<button type="button" class="mini ghost" data-dc="unconfirm" data-id="' + esc(x.id) + '"' + dis + '>仮に戻す</button>'
          : '<button type="button" class="mini" data-dc="confirm" data-id="' + esc(x.id) + '"' + dis + '>確定にする</button>') +
        '<button type="button" class="mini ghost" data-dc="delete" data-id="' + esc(x.id) + '"' + dis + '>削除</button></span></li>';
    }).join('') : '<li class="muted">登録はまだありません</li>';
  }

  function setupEvents() {
    byId('evReload').addEventListener('click', function () {
      // 空き状況・役割も読み直す（担当の人が×に変えたかの警告は、これを元に出している）。
      // 管理者はカレンダーも読み直す（サーバー側の10分キャッシュを使わない）
      refreshBoot();
      loadEvents(S.month, true, true);
    });
    byId('tab-events').addEventListener('change', function (e) {
      if (e.target.dataset && e.target.dataset.keep) S.selKeep[e.target.dataset.keep] = e.target.value;
      if (e.target.name === 'type') syncAbsentPick(e.target);
    });
    byId('tab-events').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      var act = b.dataset.act, key = b.dataset.key;
      if (act === 'open') { S.openEvent = S.openEvent === key ? null : key; renderEvents(); return; }
      if (!S.me.isAdmin || S.evBusy) return;
      if (act === 'plan-edit') { openPlanEditorFor(key); return; }
      if (act === 'replaced') {
        var rep = b.dataset.on === '1';
        if (rep && !window.confirm('この予定を「アプリ版に置き換え済み」にします。\n計画・カレンダー反映・スタッフ・家族の画面から隠れます（元のカレンダーは変わりません）。よろしいですか？')) return;
        adminOp('setReplaced', { eventKey: key, replaced: rep });
        return;
      }
      if (act === 'answer-partial') { adminOp('setAnswerPartial', { eventKey: key, partial: b.dataset.on === '1' }); return; }
      if (act === 'answer-open') {
        var on = b.dataset.open === '1';
        if (!on && !window.confirm('参加の受付を止めます。\n家族は回答できなくなります（それまでの回答は残ります）。よろしいですか？')) return;
        adminOp('setAnswerOpen', { eventKey: key, open: on });
        return;
      }
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
        var tsel = box.querySelector('select[name="type"]');
        var type = tsel.value;
        var people = Array.prototype.map.call(box.querySelectorAll('input[name="people"]:checked'), function (x) { return x.value; });
        if (people.length && !type && /自動（不在）/.test(tsel.options[0].textContent)) type = '不在';   // 自動で不在の予定に人を選んだ
        if (people.length && type !== '不在') { S.evMsg = { kind: 'ng', text: '不在の人を選ぶときは、種類を「不在」にしてください' }; renderEvents(); return; }
        adminOp('setEventMeta', { eventKey: key, type: type, venue: box.querySelector('select[name="venue"]').value, people: type === '不在' ? people : [] });
      }
    });
  }

  /** 種類を選ぶと、不在の人の欄を出し入れする（「自動」で自動が不在のときも出す） */
  function syncAbsentPick(sel) {
    var auto = /自動（不在）/.test(sel.options[0].textContent);
    sel.closest('.ev-meta').querySelector('.absent-pick').hidden = !(sel.value === '不在' || (!sel.value && auto));
  }

  // ---------------------------------------------------------------- 家族の「練習会など」（v12〜）

  /** これからの練習会・合宿・大会（月をまたいで）。参加の回答もここで返る */
  function loadUpcoming(force) {
    var cur = S.upcoming;
    if (cur && (cur.status === 'loading' || (cur.status === 'ok' && !force))) { renderUpcoming(); return; }
    S.upcoming = { status: 'loading', data: cur && cur.data };
    renderUpcoming();
    api('upcoming').then(function (r) { S.upcoming = { status: 'ok', data: r }; }, function (e) {
      S.upcoming = { status: 'error', error: /不明な操作|使えません/.test(e.message) ? 'サーバー側（Apps Script）がまだ古い版です' : e.message, data: cur && cur.data };
    }).then(function () { renderUpcoming(); renderTabsBadge(); });
  }

  /** 受付中で、その選手が○の日を含み、まだ回答していない（日時が変わって要確認も）予定 → 「参加しますか？」 */
  function askList(events) {
    var out = [];
    events.forEach(function (ev) {
      if (!ev.answers || !ev.answers.open) return;
      var ids = S.myAthletes.filter(function (id) {
        var m = ev.answers.mine[id];
        if (m && m.a) return false;
        return ev.dates.some(function (d) { return valueOf(id, d).s === '○'; });
      });
      if (ids.length) out.push({ ev: ev, ids: ids });
    });
    return out;
  }

  function renderTabsBadge() {
    if (!S.family) return;
    var d = S.upcoming && S.upcoming.data;
    var n = d ? askList(d.events).length : 0;
    var b = document.querySelector('.tab[data-tab="events"]');
    if (b) b.textContent = '練習会など' + (n ? '（' + n + '）' : '');
  }

  // ---- 参加の回答（v15〜日ごと＋時間指定）
  //   日ごとに［終日］［時間を指定］［不参加］（v16〜午前・午後はなくした。時間の指定がオフの予定は［参加］［不参加］だけ）。
  //   日ごとの備考（v16〜）は管理者（城）だけが見る。
  //   選んだ内容は下書き（S.ansDraft）に置き、［この内容で保存］で保存。［全部の日に終日で参加］［兄弟にも同じ回答］はすぐ保存。

  var KIND_FULL = [['終日', '終日'], ['時間', '時間を指定'], ['不参加', '不参加']];
  var ANSWER_NOTE_MAX = 200;
  var KIND_SIMPLE = [['終日', '参加'], ['不参加', '不参加']];

  /** 下書きが保存済みの回答と違うか（選んだのに保存していない日がある） */
  function draftDirty(ev, id) {
    var dr = S.ansDraft && S.ansDraft[ev.key + '|' + id];
    if (!dr || !ev.answers) return false;
    var m = ev.answers.mine[id] || {};
    var saved = m.days || {};
    return ev.dates.some(function (d) {
      var a = dr[d], b = saved[d] || {};
      if (!a || (!a.k && !a.n)) return false;   // 何も選んで・書いていない日は「変更」ではない
      if ((a.n || '') !== (b.n || '')) return true;   // 備考を変えた（v16〜）
      if (!a.k) return false;
      if (a.k !== b.k) return true;
      return a.k === '時間' && (a.s !== (b.s || '') || a.e !== (b.e || ''));
    });
  }

  /** 受付中の予定で、保存していない回答があるか（ほかの画面へ移る・閉じるときに知らせる） */
  function hasUnsavedAnswers() {
    var d = S.family && S.upcoming && S.upcoming.data;
    if (!d) return false;
    return d.events.some(function (ev) {
      return ev.answers && ev.answers.open && S.myAthletes.some(function (id) { return draftDirty(ev, id); });
    });
  }
  var UNSAVED_MSG = 'まだ保存していない参加の回答があります。保存せずにほかの画面へ移りますか？';

  function upcomingEvent(key) {
    var d = S.upcoming && S.upcoming.data;
    return d && d.events.filter(function (x) { return x.key === key; })[0];
  }

  /** 選手の下書き（まだ無ければ保存済みの回答から作る） */
  function draftOf(key, id) {
    S.ansDraft = S.ansDraft || {};
    var k = key + '|' + id;
    if (!S.ansDraft[k]) {
      var ev = upcomingEvent(key);
      var m = (ev && ev.answers && ev.answers.mine[id]) || {};
      var dr = {};
      Object.keys(m.days || {}).forEach(function (d) { var v = m.days[d]; dr[d] = { k: v.k, s: v.s || '', e: v.e || '', n: v.n || '' }; });
      S.ansDraft[k] = dr;
    }
    return S.ansDraft[k];
  }

  function halfHours(win) {
    var out = [];
    var t = function (x) { var p = x.split(':'); return +p[0] * 60 + +p[1]; };
    for (var m = t(win.start); m <= t(win.end); m += 30) out.push(('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + m % 60).slice(-2));
    return out;
  }

  /** 下書き → 送る形。足りない日・時間の不備があれば null と理由 */
  function draftDays(ev, dr) {
    var days = [], why = '';
    ev.dates.forEach(function (d) {
      var v = dr[d];
      if (!v || !v.k) { why = why || md(d) + 'を選んでください'; return; }
      if (v.k === '時間' && !(v.s && v.e && v.s < v.e)) { why = why || md(d) + 'の時間（始まり・終わり）を選んでください'; return; }
      var x = v.k === '時間' ? { date: d, kind: '時間', start: v.s, end: v.e } : { date: d, kind: v.k };
      x.note = String(v.n || '').slice(0, ANSWER_NOTE_MAX);
      days.push(x);
    });
    return why ? { why: why } : { days: days };
  }

  function answerClick(b) {
    var key = b.dataset.key, id = b.dataset.id, act = b.dataset.ad;
    var ev = upcomingEvent(key);
    if (!ev || !ev.answers) return;
    var dr = draftOf(key, id);
    if (act === 'kind') {
      var date = b.dataset.date, kind = b.dataset.kind;
      if (kind === '時間') {
        var hh = halfHours(ev.answers.window);
        var cur = dr[date] && dr[date].k === '時間' ? dr[date] : null;
        dr[date] = cur || { k: '時間', s: hh[0], e: hh[hh.length - 1], n: (dr[date] && dr[date].n) || '' };
      } else dr[date] = { k: kind, n: (dr[date] && dr[date].n) || '' };   // 備考はそのまま
      S.ansMsg = null;
      renderUpcoming();
      return;
    }
    if (act === 'allfull') {
      var all = {};
      ev.dates.forEach(function (d) { all[d] = { k: '終日', n: (dr[d] && dr[d].n) || '' }; });   // 備考はそのまま
      S.ansDraft[key + '|' + id] = all;
      answerEvent(key, [id], ev.dates.map(function (d) { return { date: d, kind: '終日', note: all[d].n }; }));
      return;
    }
    var got = draftDays(ev, dr);
    if (got.why) { S.ansMsg = { kind: 'ng', text: '⚠ ' + nameOf(id) + '：' + got.why }; renderUpcoming(); return; }
    if (act === 'save') answerEvent(key, [id], got.days);
    else if (act === 'sib') {
      var ids = S.myAthletes.slice();
      ids.forEach(function (x) { S.ansDraft[key + '|' + x] = JSON.parse(JSON.stringify(dr)); });
      answerEvent(key, ids, got.days);
    }
  }

  function answerEvent(key, ids, days) {
    var ev = upcomingEvent(key);
    if (!ev) return;
    var month = ev.dates.filter(inPeriod)[0];
    S.ansBusy = true;
    S.ansMsg = { kind: 'busy', text: '保存中…' };
    renderUpcoming();
    api('answer', { month: month.slice(0, 7), eventKey: key, athleteIds: ids, days: days }).then(function (r) {
      S.upcoming = { status: 'ok', data: r };
      ids.forEach(function (x) { delete S.ansDraft[key + '|' + x]; });   // 保存した内容から作り直す
      S.ansMsg = { kind: 'ok', text: '✓ ' + ev.title + '：' + ids.map(nameOf).join('・') + 'の回答を保存しました' };
    }, function (e) {
      S.ansMsg = { kind: 'ng', text: '⚠ 保存できませんでした：' + e.message };
    }).then(function () { S.ansBusy = false; renderUpcoming(); renderTabsBadge(); });
  }

  function savedLabel(ev, m) {
    if (!m || !m.a) return '<span class="muted">未回答</span>';
    var n = ev.dates.filter(function (d) { return m.days && m.days[d] && m.days[d].k !== '不参加'; }).length;
    return m.a === '参加する' ? '保存済み：参加' + (ev.dates.length > 1 ? '（' + n + '/' + ev.dates.length + '日）' : '') : '保存済み：参加しない';
  }

  function answerBlock(ev, id) {
    var a = ev.answers, m = a.mine[id] || {};
    var dr = draftOf(ev.key, id);
    var dis = S.ansBusy || !a.open ? ' disabled' : '';
    var kinds = a.partial ? KIND_FULL : KIND_SIMPLE;
    var hh = halfHours(a.window);
    var attrs = ' data-key="' + ev.key + '" data-id="' + esc(id) + '"';
    var dirty = a.open && draftDirty(ev, id);
    var h = '<div class="ans-ath' + (dirty ? ' dirty' : '') + '"' + attrs + '><div class="ans-head"><span class="ans-name">' + esc(nameOf(id)) + '</span><small class="ans-saved">' + savedLabel(ev, m) + '</small></div>' +
      '<p class="ans-unsaved" role="status"' + (dirty ? '' : ' hidden') + '>まだ保存していません。［この内容で保存］を押してください</p>' +
      (m.recheck ? '<p class="warn">日時が変わりました。もう一度選んでください（前回：' + esc(m.prev) + '）</p>' : '');
    ev.dates.forEach(function (d) {
      var v = dr[d] || {};
      h += '<div class="ans-day"><span class="ans-date">' + md(d) + '（' + WD[weekday(d)] + '）</span><div class="ans-kinds">' + kinds.map(function (k) {
        var on = v.k === k[0];
        return '<button type="button" class="ans-k' + (on ? ' on' : '') + (k[0] === '不参加' ? ' no' : '') + '" data-ad="kind" data-date="' + d + '" data-kind="' + k[0] + '"' + attrs + ' aria-pressed="' + on + '"' + dis + '>' + k[1] + '</button>';
      }).join('') + '</div>';
      if (v.k === '時間') {
        var sel = function (f, val) {
          return '<select data-adt="' + f + '" data-date="' + d + '"' + attrs + dis + ' aria-label="' + md(d) + (f === 's' ? 'の始まり' : 'の終わり') + '">' +
            hh.map(function (t) { return '<option' + (t === val ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select>';
        };
        h += '<div class="ans-time">' + sel('s', v.s) + '<span>〜</span>' + sel('e', v.e) + '</div>';
      }
      h += '<input type="text" class="ans-note" data-adn="1" data-date="' + d + '"' + attrs + dis + ' maxlength="' + ANSWER_NOTE_MAX + '" value="' + esc(v.n || '') + '" placeholder="備考（任意。例：10時ごろ合流）" aria-label="' + md(d) + 'の備考">';
      h += '</div>';
    });
    h += '<p class="ans-note-hint">備考は管理者（城）だけが見ます</p>';
    h += '<div class="ans-acts"><button type="button" class="ans-save" data-ad="save"' + attrs + dis + '>この内容で保存</button>' +
      (ev.dates.length > 1 ? '<button type="button" class="ans-sub" data-ad="allfull"' + attrs + dis + '>全部の日に' + (a.partial ? '終日で' : '') + '参加</button>' : '') +
      (S.myAthletes.length > 1 ? '<button type="button" class="ans-sub" data-ad="sib"' + attrs + dis + '>兄弟にも同じ回答</button>' : '') + '</div></div>';
    return h;
  }

  function familyCard(ev, asking) {
    var a = ev.answers;
    var h = '<article class="ev' + (asking ? ' ask' : '') + '"><div class="ev-date">' + evDateLabel(ev) + '</div>' +
      '<h3 class="ev-title">' + esc(ev.title) + '</h3>' + (ev.location ? '<div class="ev-loc">' + esc(ev.location) + '</div>' : '') +
      '<div class="badges"><span class="badge type">' + esc(ev.type === '練習' ? '練習会' : ev.type) + '</span>' + (ev.tentative ? '<span class="badge tent">仮</span>' : '') +
      (a ? '<span class="badge ' + (a.open ? 'venue' : 'novenue') + '">' + (a.open ? '参加の受付中' : '受付前') + '</span>' : '') + '</div>';
    if (a) {
      h += '<div class="ev-part">参加（1日以上）：' + a.yes.length + '名' + (a.yes.length ? '（' + a.yes.map(function (x) { return esc(x.name); }).join('・') + '）' : '') + '</div>';
      if (a.open) {
        var ids = asking ? asking : S.myAthletes;
        h += '<div class="ans">' + ids.map(function (id) { return answerBlock(ev, id); }).join('') + '</div>';
      }
    }
    return h + '</article>';
  }

  function renderUpcoming() {
    var st = S.upcoming;
    var status = byId('evStatus');
    if (S.ansMsg) { status.textContent = S.ansMsg.text; status.className = 'ev-status ' + S.ansMsg.kind; }
    else if (!st || st.status === 'loading') { status.textContent = st && st.data ? '最新を確認中…' : '読み込み中…'; status.className = 'ev-status busy'; }
    else if (st.status === 'error') { status.textContent = '⚠ 読み込めませんでした：' + st.error; status.className = 'ev-status ng'; }
    else { status.textContent = ''; status.className = 'ev-status'; }
    byId('evOrphans').innerHTML = '';
    var d = st && st.data;
    if (!d) { byId('evList').innerHTML = ''; return; }
    var ask = askList(d.events);
    var h = '';
    if (ask.length) {
      h += '<section class="ask-box"><h3>参加しますか？（' + ask.length + '件）</h3><p class="hint">○（行ける）を付けた日の練習会などです。選手ごとに選んでください。</p>' +
        ask.map(function (x) { return familyCard(x.ev, x.ids); }).join('') + '</section>';
    }
    h += '<h3 class="up-h">これからの練習会・合宿・大会</h3>';
    h += d.events.length ? d.events.map(function (ev) { return familyCard(ev, null); }).join('') : '<p class="muted">これからの練習会・合宿・大会はありません。</p>';
    byId('evList').innerHTML = h;
  }

  function loadEvents(month, force, fresh) {
    if (S.family) return loadUpcoming(force);
    if (S.me.isAdmin && (!S.cal || force)) loadCalStatus();
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
    }).then(function () { if (S.tab === 'events') renderSafe(); else renderEvents(); if (S.tab === 'plan') renderPlan(); });
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
      if (S.cal && S.cal.configured) { S.cal.dirty = true; S.calMsg = null; renderCalBar(); }
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
    var range = md(l) + '（' + WD[weekday(l)] + '）';
    if (d.length > 1) {
      if (ev.allDay) return s + '〜' + range + d.length + '日間';
      // 時刻のある複数日の予定（計画タブで作る予定など）は毎日同じ時間として出す（［時間を指定］で選べる範囲と同じ）
      return s + '〜' + range + d.length + '日間・各日 ' + ev.start.slice(11) + '–' + ev.end.slice(11);
    }
    return ev.allDay ? s + ' 終日' : s + ' ' + ev.start.slice(11) + '–' + ev.end.slice(11);
  }

  function renderEvents() {
    if (!S.me) return;
    if (S.family) return renderUpcoming();
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

    var list = data.events;
    if (S.family) {   // 家族は「これから」の予定だけ
      var today = todayJst();
      list = list.filter(function (ev) { return ev.dates[ev.dates.length - 1] >= today; });
    }
    if (!list.length) { byId('evList').innerHTML = '<p class="muted">' + (S.family ? 'この月のこれからの練習会・合宿・大会はありません。' : 'この月の予定はありません。') + '</p>'; return; }
    byId('evList').innerHTML = list.map(renderEventCard).join('');
    // 選んだだけでまだ保存していないプルダウンは、描き直しても選んだ値のままにする
    byId('evList').querySelectorAll('select[data-keep]').forEach(function (sel) {
      var v = S.selKeep[sel.dataset.keep];
      if (v != null && Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) sel.value = v;
      if (sel.name === 'type') syncAbsentPick(sel);
    });
  }

  // ================================================================ 計画（v14〜・管理者だけ）
  //
  // 空き（スタッフ・選手の○の人数）を見たまま期間を選び、予定を作って担当を決める。
  // ★ 作った予定は app_events（アプリでだけ編集）。下書きは管理者だけに見え、カレンダーに反映しない。
  // ★ 既存のカレンダーの予定（読むだけ）とアプリの予定は帯の色で、下書きは点線で見分ける。
  // ★ 予定の説明文（選手名）はサーバーがそもそも返さない。

  var PLAN_TYPES = [['練習', '練習会'], ['合宿', '合宿'], ['大会', '大会'], ['一般レッスン', '一般レッスン'], ['不在', '不在']];
  var PARTIAL_DEFAULT = { '練習': true, '合宿': false, '大会': false };   // 時間の指定（最初の値。v15〜）
  var ROLES_BY_TYPE = { '練習': ['coaching'], '合宿': ['coaching', 'escort'], '大会': ['escort'], '一般レッスン': ['lesson'], '不在': [] };
  var CAT_LABEL = { full: '全日○', part: '一部○', maybe: '△あり', none: '未回答', ng: '×' };
  var CAT_ORDER = ['full', 'part', 'maybe', 'none', 'ng'];

  function setupPlan() {
    if (!S.me.isAdmin) return;
    S.plan = { start: null, end: null, pick: 'start', view: 'staff', ed: null, busy: false, msg: null };
    byId('plCal').addEventListener('click', function (e) {
      var b = e.target.closest('[data-date]');
      if (b) planTap(b.dataset.date);
    });
    byId('plReload').addEventListener('click', function () {
      refreshBoot();
      planMonths().forEach(function (m) { loadEvents(m, true, true); });
    });
    var tab = byId('tab-plan');
    tab.addEventListener('click', planClick);
    tab.addEventListener('change', planChange);
    tab.addEventListener('input', function (e) {
      var f = e.target.dataset && e.target.dataset.ed;
      if (f && S.plan.ed && (f === 'name' || f === 'memo')) S.plan.ed[f] = e.target.value;
    });
  }

  function addDays(d, n) {
    var p = parts(d);
    var x = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return x.getUTCFullYear() + '-' + ('0' + (x.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + x.getUTCDate()).slice(-2);
  }
  function datesBetween(a, b) {
    var out = [];
    for (var d = a; d <= b && out.length < 62; d = addDays(d, 1)) out.push(d);
    return out;
  }
  function monthsBetween(a, b) {
    var out = [];
    monthsOf(S.period).forEach(function (m) { if (m >= a.slice(0, 7) && m <= b.slice(0, 7)) out.push(m); });
    return out;
  }
  function planMonths() {
    var ms = [S.month];
    var p = S.plan, ed = p && p.ed;
    if (p && p.start) monthsBetween(p.start, p.end || p.start).forEach(function (m) { if (ms.indexOf(m) < 0) ms.push(m); });
    if (ed && ed.startDate && ed.endDate) monthsBetween(ed.startDate, ed.endDate).forEach(function (m) { if (ms.indexOf(m) < 0) ms.push(m); });
    return ms;
  }
  function inPeriodDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && inPeriod(d); }

  /** 読み込んだ月の予定（同じ予定は1つ）。置き換え済みは出さない */
  function planEvents() {
    var out = [], seen = {};
    Object.keys(S.events).forEach(function (m) {
      var e = S.events[m];
      ((e && e.data && e.data.events) || []).forEach(function (ev) {
        if (seen[ev.key] || ev.replaced) return;
        seen[ev.key] = true;
        out.push(ev);
      });
    });
    out.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    return out;
  }

  /** 1回目のタップで開始日、2回目で終了日（前の日を押したら入れ替える） */
  function planTap(d) {
    var p = S.plan;
    if (p.pick === 'start' || !p.start) { p.start = d; p.end = d; p.pick = 'end'; }
    else { if (d < p.start) { p.end = p.start; p.start = d; } else p.end = d; p.pick = 'start'; }
    p.msg = null;
    renderPlan();
  }

  /** 期間の○△×の分け方：全日○／一部○／△あり／未回答／× */
  function planCat(valFn, id, dates) {
    var o = 0, t = 0, x = 0, n = 0;
    dates.forEach(function (d) { var s = valFn(id, d).s; if (s === '○') o++; else if (s === '△') t++; else if (s === '×') x++; else n++; });
    var cat = o === dates.length ? 'full' : o ? 'part' : t ? 'maybe' : n === dates.length ? 'none' : 'ng';
    return { cat: cat, o: o, t: t, x: x, n: n, days: dates.length };
  }
  function athVal(id, d) { var m = (S.aAvail || {})[id]; return (m && m[d]) || { s: '', n: '' }; }
  function staffVal(id, d) { return valueOf(id, d); }
  function planBreak(dates) {
    var b = function (list, idOf, valFn) {
      var out = { full: [], part: [], maybe: [], none: [], ng: [] };
      list.forEach(function (x) { var c = planCat(valFn, idOf(x), dates); out[c.cat].push({ name: x.name, c: c }); });
      return out;
    };
    return {
      staff: b(S.staff, function (x) { return x.staffId; }, staffVal),
      ath: b(S.athletes || [], function (x) { return x.athleteId; }, athVal)
    };
  }
  function breakLine(br, short) {
    return CAT_ORDER.filter(function (k) { return !short || br[k].length; }).map(function (k) { return CAT_LABEL[k] + ' ' + br[k].length; }).join('・') || 'なし';
  }

  /** スタッフの役割順：コーチング → 一般レッスン → 大会引率（希望・可能な最初の役割）→ 未登録 */
  function staffByRole() {
    var order = ['coaching', 'lesson', 'escort'];
    return S.staff.map(function (st, i) {
      var r = S.roles[st.staffId];
      var g = 3;
      if (r) order.some(function (k, j) { if (ROLE_TOP[k].indexOf(r[k]) >= 0) { g = j; return true; } return false; });
      return { st: st, i: i, g: g };
    }).sort(function (a, b) { return a.g - b.g || a.i - b.i; });
  }

  function renderPlan() {
    if (!S.me || !S.me.isAdmin || !S.plan || S.tab !== 'plan') return;
    planMonths().forEach(function (m) { if (!S.events[m]) loadEvents(m); });
    var p = S.plan;
    var st = byId('plStatus');
    var cur = S.events[S.month];
    if (p.msg) { st.innerHTML = p.msg.html || esc(p.msg.text); st.className = 'ev-status ' + p.msg.kind; }
    else if (!cur || cur.status === 'loading') { st.textContent = '予定を読み込み中…'; st.className = 'ev-status busy'; }
    else if (cur.status === 'error') { st.textContent = '⚠ 予定を読み込めませんでした：' + cur.error; st.className = 'ev-status ng'; }
    else { st.textContent = ''; st.className = 'ev-status'; }
    var editing = !!p.ed;
    byId('plMain').hidden = editing;
    byId('plEditor').hidden = !editing;
    if (editing) { renderPlanEditor(); return; }
    renderPlanCal();
    renderPlanDetail();
  }

  function renderPlanCal() {
    var p = S.plan;
    var days = daysOf(S.month);
    var evs = planEvents();
    var today = todayJst();
    var nAth = (S.athletes || []).length;
    var h = '';
    for (var i = 0; i < weekday(days[0]); i++) h += '<span class="blank"></span>';
    days.forEach(function (d) {
      var so = S.staff.filter(function (x) { return valueOf(x.staffId, d).s === '○'; }).length;
      var ao = (S.athletes || []).filter(function (x) { return athVal(x.athleteId, d).s === '○'; }).length;
      var mine = evs.filter(function (ev) { return ev.dates.indexOf(d) >= 0; });
      var w = weekday(d);
      var cls = ['pl-day'];
      if (w === 0 || HOLIDAYS[d]) cls.push('sun'); else if (w === 6) cls.push('sat');
      if (p.start && d >= p.start && d <= (p.end || p.start)) cls.push('in-range');
      if (d === p.start) cls.push('r-start');
      if (d === (p.end || p.start)) cls.push('r-end');
      if (d === today) cls.push('today');
      h += '<button type="button" class="' + cls.join(' ') + '" data-date="' + d + '" aria-label="' + esc(longDate(d) + ' スタッフ○' + so + '人 選手○' + ao + '人' + mine.map(function (ev) { return '・' + ev.title; }).join('')) + '">' +
        '<span class="dn">' + parts(d)[2] + '</span>' +
        '<span class="cnt"><i>ス</i>' + so + '/' + S.staff.length + '</span>' +
        '<span class="cnt"><i>選</i>' + ao + '/' + nAth + '</span>' +
        mine.slice(0, 2).map(function (ev) {
          return '<span class="band ' + bandClass(ev) + '">' + esc(ev.title) + '</span>';
        }).join('') + (mine.length > 2 ? '<span class="band more">+' + (mine.length - 2) + '</span>' : '') +
        '</button>';
    });
    byId('plCal').innerHTML = h;
  }

  function bandClass(ev) {
    if (ev.cal === 'アプリ') return 'b-app' + (ev.appStatus === '下書き' ? ' b-draft' : '') + (ev.cancelled ? ' b-cancel' : '');
    return 'b-cal' + (ev.cancelled ? ' b-cancel' : '');
  }

  function renderPlanDetail() {
    var p = S.plan, el = byId('plDetail');
    if (!p.start) { el.innerHTML = '<p class="hint pl-pick">日付を2回タップして期間を選んでください（1回目＝開始日、2回目＝終了日。1日だけなら同じ日を2回）。</p>'; return; }
    var end = p.end || p.start;
    var dates = datesBetween(p.start, end);
    var br = planBreak(dates);
    var lim = S.period ? { min: S.period.start + '-01', max: daysOf(S.period.end).slice(-1)[0] } : {};
    var h = '<div class="pl-detail">' +
      '<div class="pl-range"><label>開始日 <input type="date" data-pd="start" value="' + p.start + '" min="' + lim.min + '" max="' + lim.max + '"></label>' +
      '<label>終了日 <input type="date" data-pd="end" value="' + end + '" min="' + lim.min + '" max="' + lim.max + '"></label>' +
      '<span class="muted">' + dates.length + '日間' + (p.pick === 'end' ? '（終了日をタップ）' : '') + '</span></div>';
    h += '<div class="pl-break">' + breakBox('スタッフ', br.staff, S.staff.length) + breakBox('選手', br.ath, (S.athletes || []).length) + '</div>';
    // 日別の○△×
    h += '<div class="pl-view" role="radiogroup" aria-label="表に出す人"><label><input type="radio" name="plView" value="staff"' + (p.view === 'staff' ? ' checked' : '') + '> スタッフ（役割順）</label>' +
      '<label><input type="radio" name="plView" value="ath"' + (p.view === 'ath' ? ' checked' : '') + '> 選手</label></div>';
    h += '<div class="grid-wrap pl-grid-wrap"><table class="grid pl-grid"><thead><tr><th class="corner">' + (dates.length) + '日</th>' +
      dates.map(function (d) {
        var w = weekday(d);
        return '<th class="dh ' + ((w === 0 || HOLIDAYS[d]) ? 'sun' : w === 6 ? 'sat' : '') + '"><span>' + (+d.slice(5, 7)) + '/' + (+d.slice(8, 10)) + '<small>' + WD[w] + '</small></span></th>';
      }).join('') + '</tr></thead><tbody>';
    var rows = p.view === 'ath'
      ? (S.athletes || []).map(function (a) { return { id: a.athleteId, name: a.name, val: athVal, tag: '' }; })
      : staffByRole().map(function (x) { return { id: x.st.staffId, name: x.st.name, val: staffVal, tag: ['コーチ', 'レッスン', '引率', '—'][x.g] }; });
    rows.forEach(function (r) {
      h += '<tr><th class="nm">' + esc(r.name) + (r.tag ? '<small class="rt">' + r.tag + '</small>' : '') + '</th>' + dates.map(function (d) {
        var v = r.val(r.id, d);
        return '<td class="' + STATUS_CLASS[v.s] + '"' + (v.n ? ' title="' + esc(v.n) + '"' : '') + '>' + esc(v.s) + (v.n ? '<i class="nd"></i>' : '') + '</td>';
      }).join('') + '</tr>';
    });
    if (!rows.length) h += '<tr><td>' + (p.view === 'ath' ? '選手がまだ登録されていません' : '') + '</td></tr>';
    h += '</tbody></table></div>';
    // 期間に重なる予定
    var over = planEvents().filter(function (ev) { return ev.dates.some(function (d) { return d >= p.start && d <= end; }); });
    h += '<h3 class="pl-h">この期間の予定（' + over.length + '件）</h3>';
    h += over.length ? '<ul class="pl-evs">' + over.map(function (ev) {
      return '<li class="' + bandClass(ev) + '"><span class="pl-ev-date">' + evDateLabel(ev) + '</span> <b>' + esc(ev.title) + '</b> ' +
        '<span class="badge type">' + esc(ev.type === '練習' ? '練習会' : ev.type) + '</span>' +
        (ev.cal === 'アプリ' ? '<span class="badge app">アプリ</span>' + (ev.appStatus !== '確定' ? '<span class="badge ' + (ev.appStatus === '下書き' ? 'draft' : 'tent') + '">' + esc(ev.appStatus) + '</span>' : '') +
          ' <button type="button" class="mini" data-pa="edit" data-key="' + ev.key + '">開く</button>'
          : '<span class="badge calsrc">' + (ev.cal === 'レッスン' ? 'MICレッスン' : ev.cal === 'Deacon' ? 'Deacon' : 'MICスケジュール') + '（読むだけ）</span>') +
        '</li>';
    }).join('') + '</ul>' : '<p class="muted">重なる予定はありません。</p>';
    h += '<button type="button" class="primary pl-create" data-pa="create">この期間で予定を作る</button></div>';
    el.innerHTML = h;
  }

  function breakBox(label, br, total) {
    return '<div class="pl-bk"><b>' + label + '（' + total + '人）</b><ul>' + CAT_ORDER.map(function (k) {
      return '<li class="k-' + k + '"><span class="kl">' + CAT_LABEL[k] + '</span><span class="kn">' + br[k].length + '</span>' +
        (br[k].length ? '<small>' + br[k].map(function (x) { return esc(x.name); }).join('・') + '</small>' : '') + '</li>';
    }).join('') + '</ul></div>';
  }

  function newOpId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  function openPlanEditor(ed) {
    ed.opId = newOpId();
    S.plan.ed = ed;
    S.plan.msg = null;
    S.tab = 'plan';
    renderAll();
    window.scrollTo(0, 0);
  }

  function openPlanEditorFor(key) {
    var ev = planEventsAll().filter(function (x) { return x.key === key; })[0];
    if (!ev || ev.cal !== 'アプリ') return;
    var t = function (s) { return s.length > 10 ? s.slice(11, 16) : ''; };
    var assign = {};
    ev.assigned.forEach(function (a) { (assign[a.staffId] = assign[a.staffId] || []).push(a.role); });
    if (!S.plan.start) { S.plan.start = ev.dates[0]; S.plan.end = ev.dates[ev.dates.length - 1]; }
    openPlanEditor({
      id: ev.appId, status: ev.appStatus, type: ev.type, name: ev.title, venue: ev.venue || '',
      startDate: ev.dates[0], endDate: ev.dates[ev.dates.length - 1], allDay: ev.allDay,
      startTime: t(ev.start), endTime: t(ev.end), memo: ev.memo || '', assign: assign, people: (ev.absentees || []).slice(),
      partial: ev.answers ? ev.answers.partial : undefined
    });
  }
  /** 置き換え済みも含めて探す（予定と担当から開くとき） */
  function planEventsAll() {
    var out = [];
    Object.keys(S.events).forEach(function (m) { var e = S.events[m]; ((e && e.data && e.data.events) || []).forEach(function (ev) { out.push(ev); }); });
    return out;
  }

  function planClick(e) {
    var b = e.target.closest('[data-pa]');
    if (!b || b.disabled) return;
    var p = S.plan, act = b.dataset.pa;
    if (act === 'create') {
      openPlanEditor({ id: null, status: '', type: '練習', name: '', venue: '', startDate: p.start, endDate: p.end || p.start, allDay: true, startTime: '', endTime: '', memo: '', assign: {}, people: [] });
    } else if (act === 'edit') {
      openPlanEditorFor(b.dataset.key);
    } else if (act === 'back') {
      if (p.busy) return;
      p.ed = null; renderPlan();
    } else if (act === 'role') {
      var ed = p.ed, sid = b.dataset.staff, role = b.dataset.role;
      var cur = ed.assign[sid] = ed.assign[sid] || [];
      var i = cur.indexOf(role);
      if (i >= 0) cur.splice(i, 1); else cur.push(role);
      renderPlanEditor();
    } else if (act === 'save') {
      savePlan(b.dataset.status);
    } else if (act === 'delete') {
      if (p.busy || !window.confirm('この下書きを消します。よろしいですか？（担当も消えます）')) return;
      planOp('deleteAppEvent', { id: p.ed.id }, '下書きを消しました');
    } else if (act === 'goto-events') {
      S.tab = 'events'; renderAll(); loadEvents(S.month);
    }
  }

  function planChange(e) {
    var t = e.target, p = S.plan;
    if (t.name === 'plView') { p.view = t.value; renderPlan(); return; }
    if (t.dataset.pd) {
      var v = t.value;
      if (!inPeriodDate(v)) { renderPlan(); return; }
      if (t.dataset.pd === 'start') { p.start = v; if (!p.end || p.end < v) p.end = v; }
      else { p.end = v; if (!p.start || p.start > v) p.start = v; }
      p.pick = 'start';
      renderPlan();
      return;
    }
    var f = t.dataset.ed;
    if (!f || !p.ed) return;
    var ed = p.ed;
    if (f === 'allDay') ed.allDay = t.checked;
    else if (f === 'partial') { ed.partial = t.checked; return; }
    else if (f === 'person') {
      var i = ed.people.indexOf(t.value);
      if (t.checked && i < 0) ed.people.push(t.value); else if (!t.checked && i >= 0) ed.people.splice(i, 1);
      return;
    } else ed[f] = t.value;
    if (f === 'startDate' || f === 'endDate') {
      if (!inPeriodDate(ed[f])) ed[f] = f === 'startDate' ? p.start : (p.end || p.start);
      if (ed.endDate < ed.startDate) { if (f === 'startDate') ed.endDate = ed.startDate; else ed.startDate = ed.endDate; }
    }
    if (f === 'type' || f === 'allDay' || f === 'startDate' || f === 'endDate') renderPlanEditor();
  }

  function renderPlanEditor() {
    var p = S.plan, ed = p.ed;
    var dates = datesBetween(ed.startDate, ed.endDate);
    var br = planBreak(dates);
    var roles = ROLES_BY_TYPE[ed.type] || [];
    var lim = { min: S.period.start + '-01', max: daysOf(S.period.end).slice(-1)[0] };
    var isNew = !ed.id;
    var h = '<div class="pl-sticky"><div><b>' + esc(ed.startDate === ed.endDate ? longDate(ed.startDate) : longDate(ed.startDate) + '〜' + longDate(ed.endDate)) + '</b> ' + dates.length + '日間' +
      (ed.status ? ' <span class="badge ' + (ed.status === '下書き' ? 'draft' : ed.status === '中止' ? 'tent' : 'venue') + '">' + esc(ed.status) + '</span>' : ' <span class="badge draft">新規</span>') + '</div>' +
      '<div class="pl-sum"><span>スタッフ：' + breakLine(br.staff, true) + '</span><span>選手：' + breakLine(br.ath, true) + '</span></div></div>';
    h += '<button type="button" class="link-btn" data-pa="back"' + (p.busy ? ' disabled' : '') + '>← 計画に戻る（保存しない）</button>';
    h += '<div class="pl-form">' +
      '<label>種類 <select data-ed="type">' + PLAN_TYPES.map(function (t) { return '<option value="' + t[0] + '"' + (ed.type === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></label>' +
      '<label>名前 <input type="text" data-ed="name" maxlength="40" value="' + esc(ed.name) + '" placeholder="例：白馬合宿"></label>' +
      '<label>会場 <select data-ed="venue"><option value="">なし（会場で絞らない）</option>' + S.venues.map(function (v) { return '<option' + (ed.venue === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select></label>' +
      '<div class="pl-dates"><label>開始日 <input type="date" data-ed="startDate" value="' + ed.startDate + '" min="' + lim.min + '" max="' + lim.max + '"></label>' +
      '<label>終了日 <input type="date" data-ed="endDate" value="' + ed.endDate + '" min="' + lim.min + '" max="' + lim.max + '"></label></div>' +
      '<label class="chk"><input type="checkbox" data-ed="allDay"' + (ed.allDay ? ' checked' : '') + '> 終日</label>' +
      (PARTIAL_DEFAULT.hasOwnProperty(ed.type) ? '<label class="chk"><input type="checkbox" data-ed="partial"' + (planPartial(ed) ? ' checked' : '') + '> 家族の参加の回答で、時間の指定を受け付ける</label>' : '') +
      (ed.allDay ? '' : '<div class="pl-dates"><label>開始時刻 <input type="time" step="300" data-ed="startTime" value="' + esc(ed.startTime) + '"></label>' +
        '<label>終了時刻 <input type="time" step="300" data-ed="endTime" value="' + esc(ed.endTime) + '"></label></div>') +
      '<label>スタッフ向けメモ <textarea data-ed="memo" maxlength="200" rows="2" placeholder="スタッフに見えます（家族には出ません）">' + esc(ed.memo) + '</textarea></label></div>';
    // 担当（または不在の人）
    var cands = staffCands(dates);
    if (ed.type === '不在') {
      h += '<h3 class="pl-h">不在の人</h3><div class="pl-people">' + S.staff.map(function (st) {
        return '<label><input type="checkbox" data-ed="person" value="' + esc(st.staffId) + '"' + (ed.people.indexOf(st.staffId) >= 0 ? ' checked' : '') + '> ' + esc(st.name) + '</label>';
      }).join('') + '</div>';
    } else {
      var chosen = [];
      S.staff.forEach(function (st) { (ed.assign[st.staffId] || []).forEach(function (r) { if (roles.indexOf(r) >= 0) chosen.push(esc(st.name) + '（' + ROLE_SHORT[r] + '）'); }); });
      h += '<h3 class="pl-h">担当 <small class="muted">' + (chosen.length ? chosen.join('・') : '未定') + '</small></h3>' +
        '<p class="hint">全日○ → 一部○ → △ → 未回答 → × の順。役割のボタンを押すと担当になります（もう一度押すと外れます）。</p>' +
        '<ul class="pl-cands">' + cands.map(function (x) {
          var c = x.c, r = S.roles[x.st.staffId];
          return '<li class="k-' + c.cat + '"><span class="nm">' + esc(x.st.name) + '</span>' +
            '<span class="av">○ ' + c.o + '/' + c.days + '日' + (c.t ? '・△' + c.t : '') + (c.x ? '・×' + c.x : '') + '</span>' +
            '<span class="rb">' + roles.map(function (role) {
              var on = (ed.assign[x.st.staffId] || []).indexOf(role) >= 0;
              var pref = r && r[role] ? (r[role] === '積極的にやりたい' ? '積極的' : r[role]) : '';
              return '<button type="button" class="role-btn' + (on ? ' on' : '') + '" data-pa="role" data-staff="' + esc(x.st.staffId) + '" data-role="' + role + '" aria-pressed="' + on + '">' +
                (on ? '✓' : '') + ROLE_SHORT[role] + (pref ? '<small>' + esc(pref) + '</small>' : '') + '</button>';
            }).join('') + '</span></li>';
        }).join('') + '</ul>';
    }
    // ボタン
    var dis = p.busy ? ' disabled' : '';
    h += '<div class="pl-acts">';
    if (isNew || ed.status === '下書き') {
      h += '<button type="button" class="secondary" data-pa="save" data-status="下書き"' + dis + '>下書き保存</button>' +
        '<button type="button" class="primary" data-pa="save" data-status="確定"' + dis + '>確定</button>';
      if (!isNew) h += '<button type="button" class="link-btn danger-link" data-pa="delete"' + dis + '>下書きを消す</button>';
    } else if (ed.status === '確定') {
      h += '<button type="button" class="primary" data-pa="save" data-status="確定"' + dis + '>保存</button>' +
        '<button type="button" class="secondary" data-pa="save" data-status="下書き"' + dis + '>下書きに戻す</button>' +
        '<button type="button" class="link-btn danger-link" data-pa="save" data-status="中止"' + dis + '>中止にする</button>';
    } else {
      h += '<button type="button" class="primary" data-pa="save" data-status="確定"' + dis + '>確定に戻す</button>' +
        '<button type="button" class="secondary" data-pa="save" data-status="中止"' + dis + '>中止のまま保存</button>';
    }
    h += '</div><p class="hint">下書きは管理者だけに見えます（カレンダーに反映せず、家族にも出ません）。確定すると「予定と担当」で参加の受付・カレンダー反映ができます。</p>';
    byId('plEditor').innerHTML = h;
  }

  /** 時間の指定：手で変えていなければ種類で決める（練習会はオン、合宿・大会はオフ） */
  function planPartial(ed) { return typeof ed.partial === 'boolean' ? ed.partial : !!PARTIAL_DEFAULT[ed.type]; }

  function staffCands(dates) {
    var rank = { full: 0, part: 1, maybe: 2, none: 3, ng: 4 };
    return S.staff.map(function (st, i) { return { st: st, i: i, c: planCat(staffVal, st.staffId, dates) }; })
      .sort(function (a, b) { return rank[a.c.cat] - rank[b.c.cat] || b.c.o - a.c.o || b.c.t - a.c.t || a.i - b.i; });
  }

  function savePlan(status) {
    var p = S.plan, ed = p.ed;
    if (p.busy) return;
    if (!String(ed.name || '').trim()) { p.msg = { kind: 'ng', text: '⚠ 名前を入れてください' }; renderPlan(); return; }
    if (!ed.allDay && (!ed.startTime || !ed.endTime)) { p.msg = { kind: 'ng', text: '⚠ 時刻を入れるか、「終日」にしてください' }; renderPlan(); return; }
    if (status === '中止' && ed.status !== '中止' && !window.confirm('この予定を中止にします。\nカレンダーからは次の反映で消え、家族にも出なくなります。よろしいですか？')) return;
    var roles = ROLES_BY_TYPE[ed.type] || [];
    var assignments = [];
    S.staff.forEach(function (st) { (ed.assign[st.staffId] || []).forEach(function (r) { if (roles.indexOf(r) >= 0) assignments.push({ staffId: st.staffId, role: r }); }); });
    var body = {
      opId: ed.opId, id: ed.id || undefined, type: ed.type, name: ed.name, venue: ed.venue,
      startDate: ed.startDate, endDate: ed.endDate, allDay: !!ed.allDay, startTime: ed.allDay ? '' : ed.startTime, endTime: ed.allDay ? '' : ed.endTime,
      status: status, memo: ed.memo, assignments: ed.type === '不在' ? [] : assignments, people: ed.type === '不在' ? ed.people : []
    };
    if (PARTIAL_DEFAULT.hasOwnProperty(ed.type)) body.partial = planPartial(ed);
    var label = status === '下書き' ? '下書きで保存しました' : status === '中止' ? '中止にしました' : '確定しました';
    planOp('saveAppEvent', body, label, status === '確定');
  }

  function planOp(action, body, label, linkEvents) {
    var p = S.plan, ed = p.ed;
    var touched = ed ? monthsBetween(ed.startDate, ed.endDate) : [];
    p.busy = true;
    p.msg = { kind: 'busy', text: '保存中…' };
    renderPlan();
    api(action, Object.assign({ month: S.month }, body)).then(function (r) {
      S.events[S.month] = { status: 'ok', data: r, at: Date.now() };
      // ほかの月（期間が月をまたぐ・日付を動かした）は読み直す
      Object.keys(S.events).forEach(function (m) { if (m !== S.month) delete S.events[m]; });
      if (ed) { p.start = ed.startDate; p.end = ed.endDate; p.pick = 'start'; }
      p.ed = null;
      p.msg = { kind: 'ok', html: '✓ ' + esc((ed && ed.name ? ed.name + '：' : '') + label) +
        (linkEvents ? ' <button type="button" class="mini" data-pa="goto-events">予定と担当で参加の受付・カレンダー反映へ</button>' : '') };
      saveCache();
      loadCalStatus();
    }, function (e) {
      p.msg = { kind: 'ng', text: '⚠ 保存できませんでした：' + (/不明な操作/.test(e.message) ? 'サーバー側（Apps Script）がまだ古い版です' : e.message) };
    }).then(function () { p.busy = false; renderPlan(); renderEvents(); });
  }

  function renderEventCard(ev) {
    var open = S.openEvent === ev.key;
    var badges = '<span class="badge type">' + esc(ev.type) + (ev.typeFixed ? '✎' : '') + '</span>' +
      (ev.venue ? '<span class="badge venue">' + esc(ev.venue) + (ev.venueFixed ? '✎' : '') + '</span>' : '<span class="badge novenue">会場：' + (ev.venueFixed ? '絞らない✎' : '推定なし') + '</span>') +
      (ev.tentative ? '<span class="badge tent">仮</span>' : '') +
      (ev.cal === 'レッスン' ? '<span class="badge calsrc">MICレッスン</span>' : '') +
      (ev.cal === 'Deacon' ? '<span class="badge calsrc">アプリで登録</span>' : '') +
      (ev.cal === 'アプリ' ? '<span class="badge app">アプリの予定</span>' : '') +
      (ev.appStatus === '下書き' ? '<span class="badge draft">下書き（管理者だけに表示）</span>' : '') +
      (ev.appStatus === '中止' ? '<span class="badge tent">中止</span>' : '') +
      (ev.replaced ? '<span class="badge calsrc">アプリ版に置き換え済み（計画・反映・スタッフ・家族から隠しています）</span>' : '');
    var absent = ev.type === '不在';   // スタッフの不在期間：担当は付けず「不在：誰」を出す
    var assigned = ev.assigned.length ? ev.assigned.map(function (a) {
      var c = availOn(a.staffId, ev.dates);
      var warn = c.x ? ' <span class="warn">⚠×の日あり</span>' : (c.n ? ' <span class="warn">⚠未回答の日あり</span>' : '');
      return '<b>' + esc(nameOf(a.staffId)) + '</b>（' + (ROLE_SHORT[a.role] || esc(a.role)) + '）' + warn;
    }).join('、') : '<span class="muted">未定</span>';
    var h = '<article class="ev' + (open ? ' open' : '') + (ev.appStatus === '下書き' ? ' draft' : '') + (ev.replaced || ev.cancelled ? ' dim' : '') + '" data-key="' + ev.key + '">' +
      '<div class="ev-date">' + evDateLabel(ev) + '</div>' +
      '<h3 class="ev-title">' + esc(ev.title) + '</h3>' +
      (ev.location ? '<div class="ev-loc">' + esc(ev.location) + '</div>' : '') +
      '<div class="badges">' + badges + '</div>' +
      (ev.memo && !S.family ? '<div class="ev-memo">メモ：' + esc(ev.memo) + '</div>' : '') +
      (S.family ? '' : absent
        ? '<div class="ev-assigned ev-absent">不在：' + (ev.absentees && ev.absentees.length ? ev.absentees.map(function (id) { return '<b>' + esc(nameOf(id)) + '</b>'; }).join('・') + (ev.absentFixed ? '✎' : '') : '<span class="muted">（未定）</span>') + '</div>'
        : '<div class="ev-assigned">担当：' + assigned + '</div>') +
      participantsHtml(ev);
    if (S.me.isAdmin) {
      h += '<button type="button" class="ev-open' + (open ? ' is-open' : '') + '" data-act="open" data-key="' + ev.key + '">' +
        (open ? '閉じる ▴' : absent
          ? '<span class="ev-open-icon" aria-hidden="true">✎</span>種類・不在の人を直す<span class="ev-open-arrow" aria-hidden="true">▾</span>'
          : '<span class="ev-open-icon" aria-hidden="true">＋</span>担当を決める<small>空いている人を見る</small><span class="ev-open-arrow" aria-hidden="true">▾</span>') + '</button>';
      if (open) h += renderEventDetail(ev);
    }
    return h + '</article>';
  }

  /**
   * 選手（練習会・合宿・大会）：空き状況（○△×）と、参加の回答を分けて出す
   *   行ける：○2名（A・B）・一部の日○1名・△1名／参加：確定1名（A）・不参加1名・未回答3名［受付中］
   */
  function participantsHtml(ev) {
    var p = ev.avail;
    if (!p) return '';
    var nm = function (x) { return esc(x.name); };
    var av = ['<span class="mk s-o">○</span>' + (p.days > 1 ? '全日' : '') + p.full.length + '名' + (p.full.length ? '（' + p.full.map(nm).join('・') + '）' : '')];
    if (p.partial.length) av.push('一部の日○' + p.partial.length + '名（' + p.partial.map(function (x) { return nm(x) + ' ' + x.o + '/' + p.days + '日'; }).join('・') + '）');
    av.push('<span class="mk s-t">△</span>' + p.maybe.length + '名' + (p.maybe.length ? '（' + p.maybe.map(function (x) { return nm(x) + (x.note ? '：' + esc(x.note) : ''); }).join('・') + '）' : ''));
    var h = '<div class="ev-part">行ける：' + av.join('・') + '</div>';
    var a = ev.answers;
    if (a) {
      var un = a.unanswered.length + a.recheck.length;
      h += '<div class="ev-part ev-ans">参加（1日以上）<b>' + a.yes.length + '名</b>' + (a.yes.length ? '（' + a.yes.map(nm).join('・') + '）' : '') +
        '・不参加' + a.no.length + '名' + (a.no.length ? '（' + a.no.map(nm).join('・') + '）' : '') +
        '・未回答' + un + '名' + (a.recheck.length ? '（うち日時変更で要確認' + a.recheck.length + '名）' : '') +
        ' <span class="badge ' + (a.open ? 'venue' : 'novenue') + '">' + (a.open ? '受付中' : '受付前') + '</span>' +
        (S.me.isAdmin ? ' <button type="button" class="mini' + (a.open ? ' ghost' : '') + '" data-act="answer-open" data-key="' + ev.key + '" data-open="' + (a.open ? '0' : '1') + '"' + (S.evBusy ? ' disabled' : '') + '>' +
          (a.open ? '受付を止める' : '参加の受付を始める') + '</button>' : '') + '</div>';
      // 日ごとの内訳（v15〜）。受付前で回答もなければ出さない（長い合宿で空の行が並ばないように）
      var anyAns = a.open || a.yes.length || a.no.length || a.recheck.length;
      if (anyAns) h += '<ul class="ev-days">' + (a.days || []).map(function (d) {
        // 日ごとに、誰がどの区分か（名前）を出す。未回答は人数だけ
        var who = function (xs) { return xs.length ? '（' + xs.map(function (x) { return esc(x.name); }).join('・') + '）' : ''; };
        var parts = [];
        if (a.partial || d.time.length) {
          parts.push('終日' + d.full.length + who(d.full));
          if (d.time.length) parts.push('時間指定' + d.time.length + '（' + d.time.map(function (x) { return esc(x.name) + ' ' + x.start + '–' + x.end; }).join('、') + '）');
        } else parts.push('参加' + d.full.length + who(d.full));
        parts.push('不参加' + d.no.length + who(d.no), '未回答' + d.unanswered.length);
        // 家族の備考（管理者だけ。サーバーは管理者にだけ返す）
        var notes = (d.notes || []).map(function (x) { return '<div class="ev-note">備考：' + esc(x.name) + ' ' + esc(x.note) + '</div>'; }).join('');
        return '<li>' + md(d.date) + '：' + parts.join('・') + notes + '</li>';
      }).join('') + '</ul>';
      if (S.me.isAdmin) {
        h += '<div class="ev-partial">時間の指定：<b>' + (a.partial ? '受け付ける' : '受け付けない（参加・不参加だけ）') + '</b> ' +
          '<button type="button" class="mini ghost2" data-act="answer-partial" data-key="' + ev.key + '" data-on="' + (a.partial ? '0' : '1') + '"' + (S.evBusy ? ' disabled' : '') + '>' +
          (a.partial ? '受け付けないにする' : '受け付けるにする') + '</button></div>';
      }
    }
    return h;
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
    var busy = ev.type === '不在' ? [] : S.staff.filter(function (st) { return !availOn(st.staffId, ev.dates).free; }).map(function (st) {
      return esc(st.name) + '<small>（' + availOn(st.staffId, ev.dates).label + '）</small>';
    });
    if (busy.length) h += '<p class="rest">行けない・未回答：' + busy.join('、') + '</p>';

    if (ev.cal === 'アプリ') {
      // アプリで作った予定は「計画」で直す（種類・名前・日時・会場・メモ・担当）
      h += '<div class="ev-meta"><h4>この予定を直す</h4><button type="button" class="mini" data-act="plan-edit" data-key="' + ev.key + '">計画で直す（日時・種類・担当など）</button></div>';
      return h + '</div>';
    }
    // 既存の予定を、アプリで作り直したとき：計画・反映・スタッフ・家族から隠す（自動では判定しない）
    h += '<div class="ev-meta"><h4>アプリ版に置き換え</h4>' +
      '<p class="hint">「計画」で同じ予定を作り直したら付けてください。計画・カレンダー反映・スタッフ・家族の画面から隠します（元のカレンダーは変えません）。</p>' +
      '<button type="button" class="mini' + (ev.replaced ? ' ghost' : '') + '" data-act="replaced" data-key="' + ev.key + '" data-on="' + (ev.replaced ? '0' : '1') + '"' + (S.evBusy ? ' disabled' : '') + '>' +
      (ev.replaced ? '置き換え済みを外す' : 'アプリ版に置き換え済みにする') + '</button></div>';
    // 種類・会場の手直し（アプリ側だけに保存。カレンダーには書かない）
    h += '<div class="ev-meta"><h4>種類・会場を直す</h4>' +
      '<label>種類 <select name="type" data-keep="type:' + ev.key + '"><option value="">自動（' + esc(ev.typeAuto) + '）</option>' +
      EVENT_TYPES.map(function (t) { return '<option' + (ev.typeFixed && ev.type === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select></label>' +
      '<label>会場 <select name="venue" data-keep="venue:' + ev.key + '"><option value="">自動（' + esc(ev.venueAuto || '推定なし') + '）</option>' +
      S.venues.map(function (v) { return '<option' + (ev.venueFixed && ev.venue === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') +
      '<option value="' + VENUE_NONE + '"' + (ev.venueFixed && !ev.venue ? ' selected' : '') + '>会場で絞らない</option></select></label>' +
      // 不在の人（種類が不在のときだけ使う）
      '<fieldset class="absent-pick"' + (ev.type === '不在' ? '' : ' hidden') + '><legend>不在の人（種類＝不在のとき）</legend>' +
      S.staff.map(function (st) {
        var on = (ev.absentees || []).indexOf(st.staffId) >= 0;
        return '<label><input type="checkbox" name="people" value="' + esc(st.staffId) + '"' + (on ? ' checked' : '') + '> ' + esc(st.name) + '</label>';
      }).join('') + '</fieldset>' +
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

  // ---------------------------------------------------------------- 家族・選手の管理（v11〜・管理者だけ）

  function setupFamilyAdmin() {
    if (!S.me.isAdmin) return;
    byId('famList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-fam]');
      if (!b || b.disabled || S.famBusy) return;
      var act = b.dataset.fam, fid = b.dataset.id, name = b.dataset.name;
      if (act === 'url') famOp('familyUrl', { familyId: fid }, function (r) { showUrl(name + 'のURL（この家族にだけ送ってください）', r.token); });
      else if (act === 'reissue') {
        if (!window.confirm(name + 'のURLを再発行します。\n今のURLはすぐ使えなくなります。よろしいですか？')) return;
        famOp('familyReissue', { familyId: fid }, function (r) { showUrl(name + 'の新しいURL（古いURLはもう使えません。この家族にだけ送ってください）', r.token); });
      } else if (act === 'disable' || act === 'enable') {
        var on = act === 'enable';
        if (!on && !window.confirm(name + 'のURLを無効にします。\nすぐ使えなくなり、この家族の選手はみんなの予定・参加者に出なくなります（入力済みの予定は消えません）。よろしいですか？')) return;
        famOp('familySetActive', { familyId: fid, active: on }, function () { hideUrl(); });
      } else if (act === 'add-ath') {
        var input = b.closest('li').querySelector('input[name="athName"]');
        var nm = input.value.trim();
        if (!nm) { setFamStatus('ng', '選手の氏名を入れてください'); return; }
        famOp('athleteAdd', { familyId: fid, name: nm });
      } else if (act === 'rename-ath') {
        var nn = window.prompt('選手の氏名（表示用）', name);
        if (nn == null || !nn.trim() || nn.trim() === name) return;
        famOp('athleteRename', { athleteId: b.dataset.ath, name: nn.trim() });
      } else if (act === 'ath-off' || act === 'ath-on') {
        if (act === 'ath-off' && !window.confirm(name + 'さんを無効にします（入力済みの予定は消えません）。よろしいですか？')) return;
        famOp('athleteSetActive', { athleteId: b.dataset.ath, active: act === 'ath-on' });
      }
    });
    byId('addFamilyBtn').addEventListener('click', function () {
      var name = byId('newFamily').value.trim();
      if (!name) { setFamStatus('ng', '家族の表示名を入れてください（例：有賀家）'); return; }
      famOp('familyAdd', { name: name }, function (r) {
        byId('newFamily').value = '';
        showUrl(name + '（' + r.familyId + '）を追加しました。続けて選手を追加してから、URLをこの家族にだけ送ってください', r.token);
      });
    });
  }

  function setFamStatus(kind, text) {
    var el = byId('famStatus');
    el.textContent = text;
    el.className = 'ev-status ' + kind;
  }

  function loadFamilies() {
    if (!S.me.isAdmin) return;
    api('familyList').then(function (r) { S.families = r.families; setFamStatus('', ''); }, function (e) {
      setFamStatus('ng', /不明な操作/.test(e.message) ? 'サーバー側（Apps Script）がまだ古い版です' : '⚠ 読み込めませんでした：' + e.message);
    }).then(renderFamilies);
  }

  function famOp(action, payload, done) {
    S.famBusy = true;
    setFamStatus('busy', '保存中…');
    renderFamilies();
    api(action, payload).then(function (r) {
      if (r.families) S.families = r.families;
      setFamStatus('ok', '✓ ' + (action === 'familyUrl' ? 'URLを表示しました' : '保存しました'));
      if (done) done(r);
      if (action !== 'familyUrl') refreshBoot();   // 選手の一覧・参加者にも出す
    }, function (e) {
      setFamStatus('ng', '⚠ できませんでした：' + e.message);
    }).then(function () { S.famBusy = false; renderFamilies(); });
  }

  function renderFamilies() {
    if (!S.me || !S.me.isAdmin) return;
    var list = S.families || [];
    var dis = S.famBusy ? ' disabled' : '';
    byId('addFamilyBtn').disabled = !!S.famBusy;
    byId('famList').innerHTML = list.length ? list.map(function (f) {
      var nm = esc(f.name), id = esc(f.familyId);
      var aths = f.athletes.map(function (a) {
        var an = esc(a.name);
        return '<li class="' + (a.active ? '' : 'inactive') + '"><span>' + an + '<small>' + esc(a.athleteId) + '</small></span>' +
          '<button type="button" class="mini ghost" data-fam="rename-ath" data-id="' + id + '" data-ath="' + esc(a.athleteId) + '" data-name="' + an + '"' + dis + '>名前を直す</button>' +
          (a.active ? '<button type="button" class="mini ghost" data-fam="ath-off" data-id="' + id + '" data-ath="' + esc(a.athleteId) + '" data-name="' + an + '"' + dis + '>無効</button>'
            : '<button type="button" class="mini" data-fam="ath-on" data-id="' + id + '" data-ath="' + esc(a.athleteId) + '" data-name="' + an + '"' + dis + '>有効に戻す</button>') + '</li>';
      }).join('');
      return '<li class="fam ' + (f.active ? '' : 'inactive') + '"><div class="who"><b>' + nm + '</b><small>' + id + '</small>' +
        '<span class="badge ' + (f.active ? 'venue' : 'novenue') + '">' + (f.active ? '有効' : '無効') + '</span></div>' +
        '<div class="acts">' + (f.active ? '<button type="button" class="mini" data-fam="url" data-id="' + id + '" data-name="' + nm + '"' + dis + '>URLを表示</button>' : '') +
        '<button type="button" class="mini" data-fam="reissue" data-id="' + id + '" data-name="' + nm + '"' + dis + '>再発行</button>' +
        (f.active ? '<button type="button" class="mini ghost" data-fam="disable" data-id="' + id + '" data-name="' + nm + '"' + dis + '>無効にする</button>'
          : '<button type="button" class="mini" data-fam="enable" data-id="' + id + '" data-name="' + nm + '"' + dis + '>有効に戻す</button>') + '</div>' +
        '<ul class="ath-list">' + (aths || '<li class="muted">選手がまだいません</li>') + '</ul>' +
        '<div class="note-row"><input name="athName" type="text" maxlength="20" placeholder="選手の氏名" autocomplete="off"><button type="button" data-fam="add-ath" data-id="' + id + '"' + dis + '>選手を追加</button></div></li>';
    }).join('') : '<li class="muted">家族はまだ登録されていません</li>';
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

  // ================================================================ AI（管理者・スタッフ・家族。v18〜 右下の丸いボタンで開くチャット）
  //
  // ★ 会話はこの画面の中だけに持つ（端末に保存しない）。×で閉じても、ページを開いている間は残る。
  // ★ 続きの質問のために、直前の3往復だけを文字でサーバーへ渡す。
  // ★ 変更案は表示するだけ。［反映］で案のIDだけを送り、サーバーが置いた案を保存する。
  //   新しい案が出たら、前の未保存の案はボタンを消す（古い案を押し間違えないように）。
  // ★ 家族の案は2種類：○△×（athAvail）と参加の回答（answer）。変えられるのは自分の家族の選手だけ（サーバーで判定）。
  // ★ 大きさは2段階（v19〜）：まず小さめ（スマホは画面下の4割ほど、PCは右下の小窓）で開き、後ろの画面は暗くせずそのまま使える。
  //   ［大きくする］で画面いっぱい、［小さくする］で戻す。最後に選んだ大きさは、その端末だけに覚える（localStorage）。
  //   キーボードが出たら、見えている高さに合わせて縮め、入力欄と［送る］を隠さない。
  // ★ 音声入力（v19〜）：ブラウザの音声認識（ja-JP）で、話した言葉を入力欄に入れるだけ。送るのは［送る］を押したとき。
  //   使えないブラウザではマイクボタンを出さず、キーボードのマイクで話せることを出す。

  var AI_TIMEOUT_MS = 120000;   // Claude を何回か呼ぶので、ふつうの操作より長く待つ
  var AI_EXAMPLES = {
    staff: ['11/7に空いている人は？', '12月に未入力の人は？', '12/13の担当は？'],
    family: ['次の練習会はいつ？', '参加の受付中の予定は？', '12月の土日を○にして']
  };

  function setupAi() {
    S.ai = [];   // { q, a, error, busy, proposal, pstate }
    var fam = !!S.family;
    var title = fam ? 'AIに聞く' : 'AIアシスタント';
    byId('aiTitle').textContent = title;
    byId('aiFab').setAttribute('aria-label', title);
    byId('aiHintAdmin').hidden = !S.me.isAdmin;
    byId('aiHintStaff').hidden = !!S.me.isAdmin || fam;
    byId('aiHintFamily').hidden = !fam;
    byId('aiExamples').innerHTML = AI_EXAMPLES[fam ? 'family' : 'staff'].map(function (q) {
      return '<button type="button" class="chip">' + esc(q) + '</button>';
    }).join('');
    byId('aiSugList').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-sug]');
      if (!b || S.sugBusy) return;
      S.sugBusy = true;
      renderAiSuggestions();
      api('aiSuggestionRead', { id: b.dataset.sug }).then(function (r) {
        S.aiSug = r;
        byId('aiSugStatus').textContent = '';
      }, function (e) {
        byId('aiSugStatus').textContent = '⚠ できませんでした：' + e.message;
      }).then(function () { S.sugBusy = false; renderAiSuggestions(); });
    });
    byId('aiForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      askAi(byId('aiInput').value);
    });
    byId('aiExamples').addEventListener('click', function (ev) {
      var b = ev.target.closest('.chip');
      if (b && !b.disabled) askAi(b.textContent);
    });
    byId('aiLog').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-act]');
      if (!b) return;
      var turn = S.ai[+b.dataset.i];
      if (!turn || !turn.proposal || turn.pstate !== 'pending') return;
      if (b.dataset.act === 'cancel') { turn.pstate = 'cancelled'; renderAi(); return; }
      applyProposal(turn);
    });
    byId('aiClear').addEventListener('click', function () {
      if (S.aiBusy || S.ai.some(function (t) { return t.pstate === 'saving'; })) return;
      S.ai = [];
      renderAi();
    });
    byId('aiFab').addEventListener('click', function () { openAi(true); });
    byId('aiSize').addEventListener('click', function () { setAiSize(S.aiSize === 'large' ? 'small' : 'large', true); });
    // 小さい枠では注意書きを1行に縮める。［ⓘ］で全文を出し入れする（大きくしたときは、いつも全文）
    byId('aiWarnMore').addEventListener('click', function () {
      var open = !byId('aiPanel').classList.contains('warn-open');
      byId('aiPanel').classList.toggle('warn-open', open);
      byId('aiWarnMore').setAttribute('aria-expanded', open ? 'true' : 'false');
      byId('aiWarnMore').setAttribute('aria-label', open ? '注意書きをたたむ' : '注意書きをすべて表示');
    });
    setAiSize(loadAiSize(), false);
    setupMic();
    byId('aiClose').addEventListener('click', function () { openAi(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !byId('aiPanel').hidden) openAi(false);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitAiPanel);
      window.visualViewport.addEventListener('scroll', fitAiPanel);
    }
    window.addEventListener('resize', fitAiPanel);
    byId('aiFab').hidden = false;
    document.body.classList.add('has-ai');   // 右下のボタンが大事なボタンを隠さないよう、ページの下に余白を取る
    renderAi();
  }

  var AI_SIZE_KEY = 'mic_ai_size';   // 最後に選んだ大きさ（small／large）。会話は保存しない
  function loadAiSize() {
    try { return localStorage.getItem(AI_SIZE_KEY) === 'large' ? 'large' : 'small'; } catch (e) { return 'small'; }
  }

  function setAiSize(size, remember) {
    S.aiSize = size === 'large' ? 'large' : 'small';
    var large = S.aiSize === 'large';
    byId('aiPanel').setAttribute('data-size', S.aiSize);
    document.body.classList.toggle('ai-large', large);
    var b = byId('aiSize'), label = large ? '小さくする' : '大きくする';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.querySelector('.ai-size-ic').textContent = large ? '⤡' : '⤢';
    b.querySelector('.ai-size-tx').textContent = label;
    if (remember) { try { localStorage.setItem(AI_SIZE_KEY, S.aiSize); } catch (e) { /* 覚えられなくても動く */ } }
    fitAiPanel();
    var body = byId('aiBody');
    if (S.ai && S.ai.length && !byId('aiPanel').hidden) body.scrollTop = body.scrollHeight;
  }

  function openAi(on) {
    if (S.dead) on = false;
    var panel = byId('aiPanel'), fab = byId('aiFab');
    panel.hidden = !on;
    fab.hidden = !!on || !!S.dead;
    fab.setAttribute('aria-expanded', on ? 'true' : 'false');
    document.body.classList.toggle('ai-open', !!on);
    if (on) {
      fitAiPanel();
      renderAi();
      // スマホでは開いただけでキーボードを出さない（会話を読めるように）。PCは入力欄へ
      if (window.matchMedia && window.matchMedia('(min-width: 700px)').matches) byId('aiInput').focus();
    } else {
      stopMic();
      fab.focus();
    }
  }

  /**
   * キーボードが出たら、見えている高さ（visualViewport）に合わせて画面を縮め、入力欄と［送る］が隠れないようにする（小さい・大きいの両方）。
   * Android の Chrome は interactive-widget=resizes-content で画面ごと縮むので、ここでは何もしなくてよい
   */
  function fitAiPanel() {
    var p = byId('aiPanel');
    if (!p || p.hidden) return;
    var vv = window.visualViewport;
    var wide = window.matchMedia && window.matchMedia('(min-width: 700px)').matches;
    p.style.bottom = ''; p.style.height = ''; p.style.top = '';
    if (!vv || wide) return;
    var kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    if (kb < 60) return;   // キーボードが出ていない
    var room = Math.round(vv.height);
    p.style.top = 'auto';
    p.style.bottom = kb + 'px';
    // 大きい：見えている高さ全部。小さい：今の高さのまま、入りきらなければ見えている高さまで
    p.style.height = (S.aiSize === 'large' ? room : Math.min(p.getBoundingClientRect().height, room - 8)) + 'px';
  }

  // ---------------------------------------------------------------- 音声入力（v19〜）

  function speechApi() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }

  function setupMic() {
    var mic = byId('aiMic');
    if (!speechApi()) {
      mic.hidden = true;
      micStatus('このブラウザでは音声入力ボタンは使えません。キーボードのマイクで話して入力できます', 'note');
      return;
    }
    mic.hidden = false;
    mic.addEventListener('click', function () { if (S.mic) stopMic(); else startMic(); });
  }

  function micStatus(text, kind) {
    var el = byId('aiMicStatus');
    el.textContent = text || '';
    el.className = 'ai-mic-status' + (kind ? ' ' + kind : '');
    el.hidden = !text;
  }

  function startMic() {
    var Rec = speechApi();
    if (!Rec || S.aiBusy) return;
    var rec;
    try { rec = new Rec(); } catch (e) { micStatus('音声入力を始められませんでした', 'ng'); return; }
    var input = byId('aiInput');
    var base = input.value.trim();
    rec.lang = 'ja-JP';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = function (e) {
      var text = '';
      for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      input.value = (base ? base + ' ' : '') + text.trim();   // 入力欄に入れるだけ。送らない
    };
    rec.onerror = function (e) {
      var err = e && e.error;
      S.micErr = err === 'not-allowed' || err === 'service-not-allowed'
        ? 'マイクが許可されていません。ブラウザ（iPhone は「設定」→ Safari →「マイク」）でこのページのマイクを許可してから、もう一度押してください'
        : err === 'no-speech' ? '声が聞き取れませんでした。もう一度マイクを押して話してください'
          : err === 'audio-capture' ? 'マイクが見つかりませんでした'
            : err === 'aborted' ? '' : '音声入力が使えませんでした（' + (err || '不明') + '）。キーボードのマイクでも話せます';
    };
    rec.onend = function () {
      if (S.mic !== rec) return;
      S.mic = null;
      renderMic();
      if (S.micErr) micStatus(S.micErr, 'ng');
      else micStatus(input.value.trim() ? '文字を確かめてから［送る］を押してください' : '', '');
    };
    S.micErr = '';
    S.mic = rec;
    renderMic();
    micStatus('聞いています…（もう一度押すと止まります）', 'on');
    try { rec.start(); } catch (e) { S.mic = null; renderMic(); micStatus('音声入力を始められませんでした', 'ng'); }
  }

  function stopMic() {
    var rec = S.mic;
    if (!rec) return;
    try { rec.stop(); } catch (e) { /* もう止まっている */ }
  }

  function renderMic() {
    var b = byId('aiMic');
    var on = !!S.mic;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.setAttribute('aria-label', on ? '音声入力を止める' : '音声で入力');
  }

  function askAi(text) {
    var q = String(text || '').trim();
    if (!q || S.aiBusy) return;
    stopMic();
    var history = S.ai.filter(function (t) { return t.a && !t.error; }).slice(-3).map(function (t) { return { q: t.q, a: t.a }; });
    var turn = { q: q, a: '', busy: true };
    S.ai.push(turn);
    S.aiBusy = true;
    byId('aiInput').value = '';
    renderAi();
    api('aiAsk', { question: q, history: history }, AI_TIMEOUT_MS).then(function (r) {
      turn.a = r.answer;
      S.aiUsage = r.used + ' / ' + r.limit + '回';
      if (r.suggested) loadAiSuggestions();
      if (r.proposal) {
        S.ai.forEach(function (t) { if (t.pstate === 'pending') t.pstate = 'old'; });
        turn.proposal = r.proposal;
        turn.pstate = 'pending';
      }
    }, function (e) {
      turn.error = true;
      turn.a = e.code === 'forbidden' && S.family ? 'サーバー側（Apps Script）がまだ古い版のため、AIを使えません' : e.message;
    }).then(function () {
      turn.busy = false;
      S.aiBusy = false;
      renderAi();
    });
  }

  /** 管理者：AIからの改善提案の一覧（「管理」タブを開いたとき・提案が増えたときに読み直す） */
  function loadAiSuggestions() {
    if (!S.me || !S.me.isAdmin) return;
    api('aiSuggestions').then(function (r) {
      S.aiSug = r;
      byId('aiSugStatus').textContent = '';
    }, function (e) {
      byId('aiSugStatus').textContent = '⚠ 改善提案を読み込めませんでした：' + e.message;
    }).then(renderAiSuggestions);
  }

  function renderAiSuggestions() {
    var box = byId('aiSugBox');
    box.hidden = !S.me.isAdmin;
    if (box.hidden) return;
    var r = S.aiSug || { unread: 0, items: [] };
    byId('aiSugUnread').textContent = r.unread ? '未読 ' + r.unread + '件' : '未読なし';
    byId('aiSugUnread').className = 'ai-sug-count' + (r.unread ? ' on' : '');
    byId('aiSugList').innerHTML = r.items.length ? r.items.map(function (x) {
      var unread = x.status === '未読';
      return '<li class="' + (unread ? 'unread' : 'read') + '"><div class="ai-sug-meta">' + esc(x.at.slice(5, 16)) + '　' + esc(x.name) + '　<span>' + esc(x.status) + '</span></div>' +
        '<div class="ai-sug-sum">' + esc(x.summary) + '</div>' + (x.reason ? '<div class="ai-sug-why">理由：' + esc(x.reason) + '</div>' : '') +
        (unread ? '<button type="button" class="mini" data-sug="' + esc(x.id) + '"' + (S.sugBusy ? ' disabled' : '') + '>確認済みにする</button>' : '') + '</li>';
    }).join('') : '<li class="read">まだありません</li>';
  }

  function applyProposal(turn) {
    turn.pstate = 'saving';
    turn.perr = '';
    renderAi();
    api('aiApply', { proposalId: turn.proposal.id }).then(function (r) {
      turn.pstate = 'saved';
      turn.savedCount = r.saved.length;
      if (r.kind === 'answer') {
        // 参加の回答：返ってきた「練習会など」で描き直す。同じ予定・選手の下書きは、保存した内容から作り直す
        S.upcoming = { status: 'ok', data: r.upcoming };
        (r.athleteIds || []).forEach(function (x) { if (S.ansDraft) delete S.ansDraft[r.eventKey + '|' + x]; });
        renderUpcoming();
        renderTabsBadge();
      } else {
        refreshBoot();   // 自分の画面の一覧・みんなの予定にも反映する
      }
    }, function (e) {
      turn.pstate = e.code === 'ai_expired' ? 'old' : 'pending';
      turn.perr = e.message;
    }).then(renderAi);
  }

  function proposalHtml(t, i) {
    var p = t.proposal;
    var answer = p.kind === 'answer';
    var rows = p.days.map(function (d) {
      var md = (+d.date.slice(5, 7)) + '/' + (+d.date.slice(8, 10)) + '(' + d.weekday + ')';
      // 今の内容：スタッフの案は { status, note }、家族の案は文字（兄弟なら「太郎：○／花子：未入力」）
      var before = typeof d.before === 'string' ? d.before : d.before ? d.before.status + (d.before.note ? ' ' + d.before.note : '') : '未入力';
      return '<tr><td>' + esc(md) + '</td><td class="muted">' + esc(before) + '</td><td class="to">' + esc(d.status || '未入力に戻す') + '</td><td>' + esc(d.note) + '</td></tr>';
    }).join('');
    var foot;
    if (t.pstate === 'pending') {
      foot = '<div class="ai-prop-acts"><button type="button" class="primary" data-act="apply" data-i="' + i + '">反映</button>' +
        '<button type="button" class="link-btn" data-act="cancel" data-i="' + i + '">やめる</button></div>';
    } else if (t.pstate === 'saving') foot = '<p class="ai-prop-msg busy">保存中…</p>';
    else if (t.pstate === 'saved') foot = '<p class="ai-prop-msg ok">✓ 保存しました（' + (answer ? '参加の回答' : t.savedCount + '日') + '）</p>';
    else if (t.pstate === 'cancelled') foot = '<p class="ai-prop-msg">やめました（保存していません）</p>';
    else foot = '<p class="ai-prop-msg">この案は使えません（保存していません）</p>';
    if (t.perr) foot += '<p class="ai-prop-msg ng">⚠ ' + esc(t.perr) + '</p>';
    var head = answer ? '参加の回答の変更案：' + esc(p.title) + '（' + esc(p.name) + 'さん）'
      : '変更案：' + esc(p.name) + 'さん（' + p.days.length + '日）';
    return '<div class="ai-prop' + (t.pstate === 'pending' || t.pstate === 'saving' ? '' : ' done') + '">' +
      '<b>' + head + '</b>' + (p.summary ? '<div class="muted">' + esc(p.summary) + '</div>' : '') +
      '<table><thead><tr><th>日付</th><th>今</th><th>変更後</th><th>備考</th></tr></thead><tbody>' + rows + '</tbody></table>' + foot + '</div>';
  }

  function renderAi() {
    if (!S.me || !S.ai) return;
    byId('aiLog').innerHTML = S.ai.map(function (t, i) {
      return '<div class="ai-q">' + esc(t.q) + '</div>' +
        (t.busy ? '<div class="ai-a busy">考え中…（10〜30秒ほどかかります）</div>'
          : '<div class="ai-a' + (t.error ? ' ng' : '') + '">' + (t.error ? '⚠ ' : '') + esc(t.a) + '</div>') +
        (t.proposal ? proposalHtml(t, i) : '');
    }).join('');
    byId('aiSend').disabled = !!S.aiBusy;
    byId('aiExamples').querySelectorAll('.chip').forEach(function (b) { b.disabled = !!S.aiBusy; });
    byId('aiExamples').hidden = S.ai.length > 0;   // 会話が始まったら例は隠す（会話を消すとまた出る）
    byId('aiClear').hidden = !S.ai.length;
    byId('aiUsage').textContent = S.aiUsage ? '今日の利用：' + S.aiUsage : '';
    var body = byId('aiBody');
    if (S.ai.length && !byId('aiPanel').hidden) body.scrollTop = body.scrollHeight;
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

  /**
   * アプリの名前（v15〜）：家族URLは「MIC 予定」、スタッフ・管理者URLは「MIC スタッフ予定」。
   * URLの種類が分かるまで（読み込み中・使えないURL）は中立の「MIC 予定」のまま（index.html の初期値）
   */
  var APP_NAME_NEUTRAL = 'MIC 予定';
  function applyAppName() {
    var name = !S.me || S.dead ? APP_NAME_NEUTRAL : S.family ? 'MIC 予定' : 'MIC スタッフ予定';
    byId('appTitle').textContent = name;
    if (document.title !== name) document.title = name;
    var m = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (m) m.setAttribute('content', name);
  }

  function renderAll() {
    applyAppName();
    if (!S.me || !S.uiReady || S.dead) return;
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });
    ['mine', 'all', 'plan', 'events', 'roles', 'staff'].forEach(function (t) { byId('tab-' + t).hidden = S.tab !== t; });
    renderMonthLabels();
    renderMine();
    renderGrid();
    renderEvents();
    renderPlan();
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
