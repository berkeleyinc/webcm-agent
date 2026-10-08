#!/bin/sh
# Fetch the browser libraries into server/public/vendor (no runtime CDN needed).
set -eu
dir="$(dirname "$0")/../server/public/vendor"
mkdir -p "$dir"
fetch() { curl -sSL -o "$dir/$2" "https://cdn.jsdelivr.net/npm/$1"; }
fetch "@xterm/xterm@5.5.0/lib/xterm.min.js" xterm.min.js
fetch "@xterm/xterm@5.5.0/css/xterm.min.css" xterm.min.css
fetch "@xterm/addon-fit@0.10.0/lib/addon-fit.min.js" addon-fit.min.js
fetch "@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js" addon-web-links.min.js
fetch "xterm-pty@0.11.1/index.js" xterm-pty.js
echo "vendored into $dir"
