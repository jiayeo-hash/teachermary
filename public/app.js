/* Shared helpers for the Teacher Mary pages (loaded before each page's script). */
(function () {
  'use strict';

  function ApiError(status, message) {
    var e = new Error(message);
    e.status = status;
    return e;
  }

  // JSON request to our own server. Throws an Error with .status on failure.
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = null;
        }
        if (!res.ok) throw ApiError(res.status, (data && data.error) || 'Something went wrong');
        return data;
      });
    });
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  // Upload one chunk. XHR (not fetch) so we can show progress on slow phone connections.
  function putPart(url, blob, onBytes) {
    if (TM.testMode || typeof XMLHttpRequest === 'undefined') {
      return fetch(url, { method: 'PUT', body: blob, credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' } }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw ApiError(res.status, data.error);
          return data;
        });
      });
    }
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) onBytes(e.loaded);
      };
      xhr.onload = function () {
        var data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          data = null;
        }
        if (xhr.status === 200 && data) resolve(data);
        else reject(ApiError(xhr.status, (data && data.error) || 'Upload failed'));
      };
      xhr.onerror = function () {
        reject(ApiError(0, 'Network problem'));
      };
      xhr.send(blob);
    });
  }

  // Chunked upload through the server: base is e.g. /api/l/<token>/upload
  // onProgress(0..1). Each chunk is retried up to 3 times on network trouble.
  function upload(base, file, onProgress) {
    onProgress = onProgress || function () {};
    var info;
    return api(base + '/start', { method: 'POST', body: { filename: file.name, size: file.size } })
      .then(function (start) {
        info = start;
        var parts = [];
        var sent = 0;
        var count = Math.ceil(file.size / start.partSize);
        var i = 0;
        function next() {
          if (i >= count) return Promise.resolve(parts);
          var blob = file.slice(i * start.partSize, (i + 1) * start.partSize);
          var n = i + 1;
          var url = base + '/part?uploadId=' + encodeURIComponent(start.uploadId) + '&key=' + encodeURIComponent(start.key) + '&n=' + n;
          function attempt(tries) {
            return putPart(url, blob, function (loaded) {
              onProgress((sent + loaded) / file.size);
            }).catch(function (err) {
              var retryable = err.status === 0 || err.status >= 500 || err.status === 429;
              if (retryable && tries < 3) return sleep(800 * tries).then(function () { return attempt(tries + 1); });
              throw err;
            });
          }
          return attempt(1).then(function (part) {
            sent += blob.size;
            onProgress(sent / file.size);
            parts.push(part);
            i++;
            return next();
          });
        }
        return next();
      })
      .then(function (parts) {
        return api(base + '/complete', {
          method: 'POST',
          body: { key: info.key, uploadId: info.uploadId, parts: parts, filename: file.name, size: file.size },
        });
      })
      .catch(function (err) {
        if (info) api(base + '/abort', { method: 'POST', body: { key: info.key, uploadId: info.uploadId } }).catch(function () {});
        throw err;
      });
  }

  function fmtSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  }

  // SQLite gives "YYYY-MM-DD HH:MM:SS" in UTC
  function parseUtc(s) {
    return new Date(String(s).replace(' ', 'T') + (String(s).indexOf('Z') === -1 ? 'Z' : ''));
  }

  var EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var VI_DAYS = ['CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

  // "2026-10-19" -> "Mon 19 Oct"  or  "Thứ 2, 19/10"
  function dateLabel(iso, lang) {
    var p = String(iso).split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    var dow = d.getUTCDay();
    if (lang === 'vi') return VI_DAYS[dow] + ', ' + d.getUTCDate() + '/' + (d.getUTCMonth() + 1);
    return EN_DAYS[dow] + ' ' + d.getUTCDate() + ' ' + EN_MONTHS[d.getUTCMonth()];
  }

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function addDays(iso, n) {
    var p = iso.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
    return d.toISOString().slice(0, 10);
  }

  function ago(sqlTime, lang) {
    var mins = Math.max(0, Math.round((Date.now() - parseUtc(sqlTime).getTime()) / 60000));
    var vi = lang === 'vi';
    if (mins < 1) return vi ? 'vừa xong' : 'just now';
    if (mins < 60) return vi ? mins + ' phút trước' : mins + (mins === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.round(mins / 60);
    if (h < 24) return vi ? h + ' giờ trước' : h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.round(h / 24);
    return vi ? d + ' ngày trước' : d + (d === 1 ? ' day ago' : ' days ago');
  }

  function absUrl(path) {
    return location.origin + path;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) {
      return null;
    }
  }

  window.TM = {
    api: api, upload: upload, fmtSize: fmtSize, parseUtc: parseUtc, dateLabel: dateLabel, todayIso: todayIso,
    addDays: addDays, ago: ago, absUrl: absUrl, copyText: copyText, store: store, testMode: false,
  };
})();
