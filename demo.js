/*
 * デモ用の擬似サーバー（config.js の apiUrl が空のときだけ使う）。
 * 名前はすべて架空。保存はこの端末の localStorage だけ。本物の Apps Script と同じ形で応答する。
 *
 *   #t=demo        … スタッフA（自分）として開く
 *   #t=demo-admin  … 管理者として開く
 *   ?fail=1        … 保存を必ず失敗させる（失敗の表示を確かめる用）
 */
(function () {
  'use strict';
  var KEY = 'mic-ops-demo-v2';
  var NAMES = 'ABCDEFGHIJKL'.split('').map(function (c, i) {
    return { staffId: 'S' + String(i + 1).padStart(3, '0'), name: 'スタッフ' + c };
  });
  var PERIOD = { start: '2026-11', end: '2027-03' };
  var STATUSES = ['○', '△', '×'];
  var VENUES = ['O-air', 'S-air', '佐野坂', '白馬'];

  function load() {
    try { var s = JSON.parse(localStorage.getItem(KEY)); if (s && s.availability) return s; } catch (e) { /* 使えない環境でも動かす */ }
    return seed();
  }
  function store(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* 保存できなくても表示は続ける */ } }

  /** 他のスタッフの架空の回答（毎回同じになるよう固定の乱数） */
  function seed() {
    var x = 7;
    function rnd() { x = (x * 48271) % 2147483647; return x / 2147483647; }
    var availability = {}, roles = {};
    var choices = ['積極的にやりたい', '可能', '希望しない'];
    NAMES.slice(1).forEach(function (st) {
      var m = availability[st.staffId] = {};
      for (var d = 1; d <= 30; d++) {
        var date = '2026-11-' + String(d).padStart(2, '0');
        var w = new Date(Date.UTC(2026, 10, d)).getUTCDay();
        if ((w === 0 || w === 6 || d === 3 || d === 23) && rnd() < 0.85) {
          var r = rnd();
          m[date] = r < 0.6 ? { s: '○', n: '' } : r < 0.8 ? { s: '△', n: rnd() < 0.5 ? '午後のみ' : '10時から' } : { s: '×', n: '' };
        }
      }
      if (rnd() < 0.8) {
        roles[st.staffId] = {
          coaching: choices[Math.floor(rnd() * 3)], lesson: choices[Math.floor(rnd() * 3)],
          escort: ['可能', '条件付き', '難しい'][Math.floor(rnd() * 3)], escort_note: '', updated: ''
        };
        if (roles[st.staffId].escort === '条件付き') roles[st.staffId].escort_note = '日帰りのみ';
        roles[st.staffId].venues = VENUES.filter(function () { return rnd() < 0.6; });
      }
    });
    return { availability: availability, roles: roles };
  }

  // 架空の予定（本物のカレンダーとは無関係）
  var EVENTS = [
    { key: 'd1', title: 'O-air練習会', start: '2026-11-07 09:00', end: '2026-11-07 12:00', allDay: false, dates: ['2026-11-07'] },
    { key: 'd2', title: '練習会 S-air', start: '2026-11-08', end: '2026-11-08', allDay: true, dates: ['2026-11-08'] },
    { key: 'd3', title: '（仮）海外合宿', start: '2026-11-20', end: '2026-11-23', allDay: true, dates: ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'] },
    { key: 'd4', title: 'ウォータージャンプ体験', location: 'O-air', start: '2026-11-15 10:00', end: '2026-11-15 12:00', allDay: false, dates: ['2026-11-15'], lesson: true },
    { key: 'd5', title: 'ミーティング', start: '2026-11-28 19:00', end: '2026-11-28 20:00', allDay: false, dates: ['2026-11-28'] }
  ];
  var ROLES_FOR_TYPE = { '練習': ['coaching'], '一般レッスン': ['lesson'], '大会': ['escort'], '合宿': ['coaching', 'escort'], '未分類': ['coaching', 'lesson', 'escort'] };

  function guessType(e) {
    if (e.lesson) return '一般レッスン';
    if (/大会/.test(e.title)) return '大会';
    if (/合宿/.test(e.title)) return '合宿';
    if (/練習/.test(e.title)) return '練習';
    return '未分類';
  }
  function guessVenue(e) {
    var t = (e.title + ' ' + (e.location || '')).toLowerCase().replace(/[\s-]/g, '');
    var hits = VENUES.filter(function (v) { return t.indexOf(v.toLowerCase().replace(/[\s-]/g, '')) >= 0; });
    return hits.length === 1 ? hits[0] : '';
  }
  function eventsOf(db, month) {
    var meta = db.meta || {}, asg = db.assign || [];
    var list = month === '2026-11' ? EVENTS : [];
    return {
      ok: true, month: month, orphans: [],
      events: list.map(function (e) {
        var m = meta[e.key] || {}, type = guessType(e), venue = guessVenue(e);
        var ev = {
          key: e.key, cal: e.lesson ? 'レッスン' : 'スケジュール', title: e.title, location: e.location || '',
          start: e.start, end: e.end, allDay: e.allDay, dates: e.dates, tentative: /（仮）/.test(e.title),
          typeAuto: type, venueAuto: venue, type: m.type || type, venue: m.venue ? (m.venue === 'なし' ? '' : m.venue) : venue,
          typeFixed: !!m.type, venueFixed: !!m.venue
        };
        ev.roles = ROLES_FOR_TYPE[ev.type];
        ev.assigned = asg.filter(function (a) { return a.key === e.key; }).map(function (a) { return { staffId: a.staffId, role: a.role }; });
        return ev;
      })
    };
  }

  function respond(obj) {
    return new Promise(function (resolve) { setTimeout(function () { resolve(JSON.parse(JSON.stringify(obj))); }, 350); });
  }

  function call(req) {
    var me = req.token === 'demo-admin' ? { staffId: null, name: '管理者', isAdmin: true }
      : req.token === 'demo' ? { staffId: 'S001', name: 'スタッフA', isAdmin: false } : null;
    if (!me) return respond({ ok: false, error: 'auth', message: 'このURLは使えません' });
    var failing = /[?&]fail=1/.test(location.search);
    var db = load();

    if (req.action === 'events') return respond(eventsOf(db, req.month));
    if (req.action === 'assign' || req.action === 'setEventMeta') {
      if (!me.isAdmin) return respond({ ok: false, error: 'forbidden', message: 'この操作は管理者のURLだけでできます' });
      if (failing) return respond({ ok: false, error: 'server', message: 'デモ：わざと失敗させています（?fail=1）' });
      if (req.action === 'assign') {
        db.assign = (db.assign || []).filter(function (a) { return !(a.key === req.eventKey && a.staffId === req.staffId && a.role === req.role); });
        if (req.on) db.assign.push({ key: req.eventKey, staffId: req.staffId, role: req.role });
      } else {
        db.meta = db.meta || {};
        if (!req.type && !req.venue) delete db.meta[req.eventKey]; else db.meta[req.eventKey] = { type: req.type, venue: req.venue };
      }
      store(db);
      return respond(eventsOf(db, req.month));
    }
    if (/^(staffList|staffUrl|reissueToken|setActive|addStaff|reissueAdmin)$/.test(req.action)) {
      if (!me.isAdmin) return respond({ ok: false, error: 'forbidden', message: 'この操作は管理者のURLだけでできます' });
      var fake = 'demo' + Math.random().toString(16).slice(2);
      if (req.action === 'staffList' || req.action === 'setActive') return respond({ ok: true, staff: NAMES.map(function (n) { return { staffId: n.staffId, name: n.name, active: true }; }) });
      if (req.action === 'addStaff') return respond({ ok: true, staffId: 'S013', name: req.name, token: fake });
      return respond({ ok: true, staffId: req.staffId, token: fake });
    }
    if (req.action === 'aiAsk') return respond({ ok: false, error: 'ai_no_key', message: 'デモではAIは使えません' });
    if (req.action === 'bootstrap') {
      return respond({ ok: true, me: me, staff: NAMES, roles: db.roles, availability: db.availability, period: PERIOD, venues: VENUES });
    }
    if (!me.staffId) return respond({ ok: false, error: 'forbidden', message: '管理者のURLでは入力できません' });
    if (failing) return respond({ ok: false, error: 'server', message: 'デモ：わざと失敗させています（?fail=1）' });

    if (req.action === 'saveDays') {
      var mine = db.availability[me.staffId] || (db.availability[me.staffId] = {});
      var saved = [];
      for (var i = 0; i < req.days.length; i++) {
        var d = req.days[i];
        if (d.status && STATUSES.indexOf(d.status) < 0) return respond({ ok: false, error: 'bad_request', message: '状態が正しくありません' });
        var note = d.status === '△' ? String(d.note || '').trim().slice(0, 100) : '';
        if (d.status) mine[d.date] = { s: d.status, n: note }; else delete mine[d.date];
        saved.push({ date: d.date, status: d.status || '', note: note });
      }
      store(db);
      return respond({ ok: true, saved: saved });
    }
    if (req.action === 'saveRoles') {
      var r = req.roles;
      db.roles[me.staffId] = {
        coaching: r.coaching, lesson: r.lesson, escort: r.escort,
        escort_note: r.escort === '条件付き' ? String(r.escort_note || '').trim().slice(0, 100) : '',
        venues: VENUES.filter(function (v) { return (r.venues || []).indexOf(v) >= 0; })
      };
      store(db);
      return respond({ ok: true, roles: db.roles[me.staffId] });
    }
    return respond({ ok: false, error: 'bad_request', message: '不明な操作です' });
  }

  window.MicDemo = { call: call };
})();
