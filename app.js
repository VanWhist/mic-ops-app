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
    noteDates: [], weekendOnly: true, selectedDay: null
  };

  // ================================================================ 通信

  function api(action, body) {
    var payload = Object.assign({ action: action, token: token }, body || {});
    if (DEMO) return window.MicDemo.call(payload);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 30000);
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
        var p = S.pending[x.date];
        if (p && p.s === x.status && p.n === (x.note || '')) delete S.pending[x.date];   // 送信中に変えた日は残す
        delete S.failed[x.date];
      });
      S.lastSaved = new Date();
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
    api('bootstrap').then(function (r) {
      S.me = r.me; S.staff = r.staff; S.roles = r.roles || {}; S.avail = r.availability || {}; S.period = r.period;
      var t = todayJst().slice(0, 7);
      var months = monthsOf(S.period);
      S.month = months.indexOf(t) >= 0 ? t : months[0];
      S.tab = S.me.isAdmin ? 'all' : 'mine';
      hide('loading');
      byId('who').textContent = S.me.isAdmin ? '管理者' : S.me.name + 'さん';
      setupTabs();
      setupMine();
      setupAll();
      setupRoles();
      renderAll();
    }).catch(function (e) {
      fatal(e.code === 'auth' ? 'このURLは使えません。管理者に新しいURLをもらってください。' : '読み込めませんでした：' + e.message + '（時間をおいて開き直してください）');
    });

    window.addEventListener('beforeunload', function (ev) {
      if (pendingCount() || S.inflight) { ev.preventDefault(); ev.returnValue = ''; }
    });
    byId('retryBtn').addEventListener('click', function () { S.error = null; flush(); });
  }

  function fatal(msg) {
    hide('loading');
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
      b.addEventListener('click', function () { S.tab = b.dataset.tab; renderAll(); });
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
    renderAll();
  }

  // ================================================================ 自分の予定

  function setupMine() {
    if (S.me.isAdmin) return;
    document.querySelectorAll('.pen').forEach(function (b) {
      b.addEventListener('click', function () { S.pen = b.dataset.pen; S.rangeStart = null; renderMine(); });
    });
    byId('rangeMode').addEventListener('change', function (e) { S.range = e.target.checked; S.rangeStart = null; renderMine(); });
    byId('cal').addEventListener('click', function (e) {
      var cell = e.target.closest('.day');
      if (cell) onDayTap(cell.dataset.date);
    });
    byId('noteSave').addEventListener('click', saveNote);
    byId('noteInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveNote(); } });
  }

  function onDayTap(date) {
    if (S.range) {
      if (!S.rangeStart) { S.rangeStart = date; renderMine(); return; }
      var a = S.rangeStart;
      S.rangeStart = null;
      paint(between(a, date).filter(inPeriod));
    } else {
      paint([date]);
    }
  }

  function paint(dates) {
    var pen = S.pen;
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
      : '印を選んで日付をタップ。もう一度タップしても同じ印のままです（変えるときは印を選び直す）';

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
      return '<li>' + md(x[0]) + '（' + WD[weekday(x[0])] + '）△ ' + (x[1].n ? esc(x[1].n) : '<span class="muted">備考なし</span>') + '</li>';
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
    var days = daysOf(S.month).filter(function (d) { return !S.weekendOnly || isOff(d); });
    var h = '<thead><tr><th class="corner">' + (+S.month.slice(5, 7)) + '月</th>';
    days.forEach(function (d) {
      var w = weekday(d);
      var c = (w === 0 || HOLIDAYS[d]) ? 'sun' : (w === 6 ? 'sat' : '');
      h += '<th class="dh ' + c + (S.selectedDay === d ? ' sel' : '') + '"><button type="button" data-day="' + d + '">' +
        parts(d)[2] + '<small>' + WD[w] + '</small></button></th>';
    });
    h += '</tr></thead><tbody>';
    S.staff.forEach(function (st) {
      var self = S.me.staffId === st.staffId;
      h += '<tr' + (self ? ' class="self"' : '') + '><th class="nm">' + esc(st.name) + '</th>';
      days.forEach(function (d) {
        var v = valueOf(st.staffId, d);
        h += '<td class="' + STATUS_CLASS[v.s] + (S.selectedDay === d ? ' sel' : '') + '"' + (v.n ? ' title="' + esc(v.n) + '"' : '') + '>' +
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
    form.addEventListener('change', function () {
      toggleEscortNote();
      setRolesMsg('', '');
    });
    toggleEscortNote();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var roles = {};
      ROLE_DEF.forEach(function (rd) {
        var c = form.querySelector('input[name="' + rd.key + '"]:checked');
        roles[rd.key] = c ? c.value : '';
      });
      roles.escort_note = roles.escort === '条件付き' ? byId('escortNote').value : '';
      var btn = byId('rolesSave');
      btn.disabled = true;
      setRolesMsg('保存中…', 'busy');
      api('saveRoles', { roles: roles }).then(function (r) {
        S.roles[S.me.staffId] = r.roles;
        byId('escortNote').value = r.roles.escort_note || '';
        setRolesMsg('✓ 保存しました', 'ok');
        renderRolesTable();
      }, function (err) {
        setRolesMsg('⚠ 保存できませんでした：' + err.message, 'ng');
      }).then(function () { btn.disabled = false; });
    });
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
    var h = '<thead><tr><th></th>' + ROLE_DEF.map(function (rd) { return '<th>' + rd.short + '</th>'; }).join('') + '</tr></thead><tbody>';
    S.staff.forEach(function (st) {
      var r = S.roles[st.staffId];
      h += '<tr' + (st.staffId === S.me.staffId ? ' class="self"' : '') + '><th class="nm">' + esc(st.name) + '</th>';
      ROLE_DEF.forEach(function (rd) {
        var v = r ? r[rd.key] : '';
        var cls = v === '積極的にやりたい' ? 'r-hi' : (v === '可能' ? 'r-ok' : (v === '条件付き' ? 'r-cond' : (v ? 'r-no' : 'r-none')));
        var label = v === '積極的にやりたい' ? '積極的' : (v || '未登録');
        h += '<td class="' + cls + '">' + esc(label) + (rd.key === 'escort' && r && r.escort_note ? '<small>' + esc(r.escort_note) + '</small>' : '') + '</td>';
      });
      h += '</tr>';
    });
    byId('rolesTable').innerHTML = h + '</tbody>';
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
    if (!S.me) return;
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });
    ['mine', 'all', 'roles'].forEach(function (t) { byId('tab-' + t).hidden = S.tab !== t; });
    renderMonthLabels();
    renderMine();
    renderGrid();
    renderRolesTable();
    renderSaveState();
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

  start();
})();
