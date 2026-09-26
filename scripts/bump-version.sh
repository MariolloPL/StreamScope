#!/bin/sh
# Stamp script/style URLs in index.html with a fresh ?v= so browsers drop cached JS/CSS after a release.
# GitHub Pages serves files with max-age=600; without this, a new index.html can run with stale scripts.
cd "$(dirname "$0")/.." || exit 1
v=$(date +%Y%m%d%H%M)
sed -i -E "s#(src=\"js/[^\"?]+\.js)(\?v=[0-9]+)?\"#\1?v=$v\"#g; s#(href=\"css/app\.css)(\?v=[0-9]+)?\"#\1?v=$v\"#" index.html
echo "version $v"
