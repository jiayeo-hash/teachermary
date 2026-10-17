/*
 * dc-lite.js - a tiny renderer for the Homeroom mockup pages.
 *
 * Each page keeps its markup inside <x-dc> and its data/logic in a
 * <script type="text/x-dc"> block. This file reads both, renders the markup
 * with the data ({{holes}}, <sc-for>, <sc-if>, onClick handlers) and redraws
 * whenever setState() is called. No build step, no dependencies.
 */
(function () {
  'use strict';

  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
    this._rerender = null;
  }
  DCLogic.prototype.setState = function (patch) {
    var next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = Object.assign({}, this.state, next);
    if (this._rerender) this._rerender();
  };
  DCLogic.prototype.forceUpdate = function () {
    if (this._rerender) this._rerender();
  };
  window.DCLogic = DCLogic;

  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  var WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

  function lookup(path, scope) {
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var cur = scope;
    var keys = path.split('.');
    for (var i = 0; i < keys.length; i++) {
      if (cur == null) return undefined;
      cur = cur[keys[i]];
    }
    return cur;
  }

  function str(v) {
    return v == null || v === false ? '' : String(v);
  }

  function interpolate(text, scope) {
    return text.replace(HOLE, function (_, p) {
      return str(lookup(p, scope));
    });
  }

  function renderNodes(nodes, scope, out) {
    for (var i = 0; i < nodes.length; i++) renderNode(nodes[i], scope, out);
  }

  function renderNode(node, scope, out) {
    if (node.nodeType === 3) {
      out.push(document.createTextNode(interpolate(node.nodeValue, scope)));
      return;
    }
    if (node.nodeType !== 1) return;

    var tag = node.localName;

    if (tag === 'sc-for') {
      var m = WHOLE.exec(node.getAttribute('list') || '');
      var list = m ? lookup(m[1], scope) : [];
      var as = node.getAttribute('as') || 'item';
      (list || []).forEach(function (item, i) {
        var child = Object.create(scope);
        child[as] = item;
        child.$index = i;
        renderNodes(node.childNodes, child, out);
      });
      return;
    }

    if (tag === 'sc-if') {
      var mi = WHOLE.exec(node.getAttribute('value') || '');
      if (mi && lookup(mi[1], scope)) renderNodes(node.childNodes, scope, out);
      return;
    }

    var el = document.createElementNS(node.namespaceURI, node.localName);
    var attrs = Array.prototype.slice.call(node.attributes);
    for (var a = 0; a < attrs.length; a++) {
      var name = attrs[a].name;
      var value = attrs[a].value;
      if (name.indexOf('hint-') === 0) continue;
      var whole = WHOLE.exec(value);
      if (/^on[a-z]+$/i.test(name) && whole) {
        var fn = lookup(whole[1], scope);
        if (typeof fn === 'function') el.addEventListener(name.slice(2).toLowerCase(), fn);
        continue;
      }
      el.setAttribute(name, whole ? str(lookup(whole[1], scope)) : interpolate(value, scope));
    }
    var kids = [];
    renderNodes(node.childNodes, scope, kids);
    for (var k = 0; k < kids.length; k++) el.appendChild(kids[k]);
    out.push(el);
  }

  function boot() {
    var host = document.querySelector('x-dc');
    var scriptEl = document.querySelector('script[type="text/x-dc"]');
    if (!host || !scriptEl) return;

    var template = Array.prototype.map.call(host.childNodes, function (n) {
      return n.cloneNode(true);
    });

    var declared = {};
    try {
      declared = JSON.parse(scriptEl.getAttribute('data-props') || '{}');
    } catch (e) {
      declared = {};
    }
    var props = {};
    Object.keys(declared).forEach(function (key) {
      if (key.charAt(0) !== '$' && declared[key] && 'default' in declared[key]) {
        props[key] = declared[key].default;
      }
    });

    var Component = new Function('DCLogic', scriptEl.textContent + '\nreturn Component;')(DCLogic);
    var inst = new Component(props);
    if (!inst.state) inst.state = {};

    function draw() {
      // keep anything the visitor typed into fields that have an id
      var saved = {};
      Array.prototype.forEach.call(host.querySelectorAll('textarea[id], input[id]'), function (f) {
        saved[f.id] = f.value;
      });

      var out = [];
      renderNodes(template, inst.renderVals(), out);

      while (host.firstChild) host.removeChild(host.firstChild);
      out.forEach(function (n) {
        host.appendChild(n);
      });

      Object.keys(saved).forEach(function (id) {
        var f = document.getElementById(id);
        if (f) f.value = saved[id];
      });
      host.setAttribute('data-ready', '');
    }

    inst._rerender = draw;
    draw();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
