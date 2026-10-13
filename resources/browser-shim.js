#!/bin/sh
//usr/bin/true; for URL do :; done; [ -n "$URL" ] || exit 0
//usr/bin/true; case "$URL" in http://localhost[:/]*|http://127.0.0.1[:/]*|http://0.0.0.0[:/]*|http://\[::1\][:/]*|https://localhost[:/]*|https://127.0.0.1[:/]*) [ -n "$VIBECANVAS_PORT" ] && curl -sf -m 3 -o /dev/null -X POST --data-binary "$URL" "http://127.0.0.1:$VIBECANVAS_PORT/open/$VIBECANVAS_TERMINAL?t=$VIBECANVAS_TOKEN" && exit 0;; esac
//usr/bin/true; exec /usr/bin/open "$URL"
//
// $BROWSER for Claude Code sessions in VibeCanvas: local URLs (a dev server that opens
// itself, `npm run dev -- --open`) become a preview card next to the session's terminal;
// everything else opens in the default browser.
//
// The lines above are a sh/JS polyglot: tools that exec $BROWSER directly (gh, Python's
// webbrowser, xdg-open style) run them as sh, while tools that run a .js $BROWSER with
// node (Vite, Create React App) see comments and run the code below. Keep each of those
// lines starting with `//`.
'use strict'

var http = require('http')
var execFile = require('child_process').execFile

var url = process.argv[process.argv.length - 1] || ''
var env = process.env
var LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i

function openExternally() {
  execFile('/usr/bin/open', [url], function (err) {
    process.exit(err ? 1 : 0)
  })
}

if (!/^[a-z]+:/i.test(url)) {
  process.exit(0)
} else if (!LOCAL.test(url) || !env.VIBECANVAS_PORT) {
  openExternally()
} else {
  var req = http.request(
    {
      host: '127.0.0.1',
      port: Number(env.VIBECANVAS_PORT),
      method: 'POST',
      path: '/open/' + encodeURIComponent(env.VIBECANVAS_TERMINAL || '') + '?t=' + encodeURIComponent(env.VIBECANVAS_TOKEN || ''),
      timeout: 3000
    },
    function (res) {
      res.resume()
      if (res.statusCode >= 200 && res.statusCode < 300) process.exit(0)
      else openExternally()
    }
  )
  req.on('timeout', function () {
    req.destroy()
  })
  req.on('error', openExternally)
  req.end(url)
}
