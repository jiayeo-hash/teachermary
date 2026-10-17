/* Shared bits for Mary's pages: element helper, header, toasts, dates. */
(function () {
  'use strict';
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v === true ? '' : v);
    });
    [].concat(kids == null ? [] : kids).forEach(function (c) {
      if (c == null || c === false) return;
      e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    });
    return e;
  }
  function toast(msg, isErr) {
    var t = h('div', { class: 'toast' + (isErr ? ' err' : ''), role: 'status' }, msg);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, isErr ? 5000 : 2200);
  }
  function fail(e) { toast((e && e.message) || 'Something went wrong', true); }
  function header(sub) {
    var top = h('div', { class: 'top' }, [
      h('a', { class: 'brand', href: '/teacher/' }, [h('span', { class: 'logo' }, 'TM'), 'Teacher Mary']),
      h('span', { class: 'who', id: 'who' }, sub || ''),
    ]);
    document.body.insertBefore(top, document.body.firstChild);
    TM.api('/api/teacher/me').then(function (m) { document.getElementById('who').textContent = m.email; }).catch(function () {});
  }
  function qs(name) { return new URLSearchParams(location.search).get(name); }
  function pill(status) { return h('span', { class: 'pill ' + status }, status === 'open' ? 'Open' : status === 'closed' ? 'Closed' : 'Draft'); }
  function dl(iso) { return TM.dateLabel(iso, 'en'); }
  function copyBtn(path, label) {
    var b = h('button', { class: 'btn small', type: 'button', onclick: function () {
      TM.copyText(TM.absUrl(path)); toast('Link copied');
    } }, label || 'Copy link');
    return b;
  }
  window.TMT = { h: h, toast: toast, fail: fail, header: header, qs: qs, pill: pill, dl: dl, copyBtn: copyBtn };
})();
