#!/bin/bash
# Makes the app's icons (static/icons) from the Entropicide brand SVGs here:
#   logo.svg, logo-name.svg, symbol.svg, favicon.svg   adapt to dark mode (navy turns light)
#   icon-*.png, maskable, apple-touch    the symbol on white, for home screens and the Android app
#   badge-96.png, monochrome-512.png     white silhouettes, for Android's status bar
#   relief.svg                           the symbol in bas-relief, the app's background
# Needs inkscape and ImageMagick. Run it after changing the SVGs: ./static/brand/make-icons.sh
set -euo pipefail
cd "$(dirname "$0")"
OUT=../icons
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Dark mode: the navy (and the tagline's grey) turn light; images follow the system theme.
DARK='<style>@media (prefers-color-scheme: dark) {
  [fill="#09254A"] { fill: #D7E3F3 } [stroke="#09254A"] { stroke: #D7E3F3 } [fill="#3D5167"] { fill: #9FB0C4 }
}</style>'
# The name is set to a fixed width (as drawn in DejaVu Serif), so it fits whichever serif font
# the device has (Georgia's is wider).
NAME_WIDTH='font-size="76" textLength="446" lengthAdjust="spacingAndGlyphs"'
adapt() { sed "0,/<title>/s||${DARK//$'\n'/ }<title>|; s|font-size=\"76\"|$NAME_WIDTH|" "$1" > "$2"; }
adapt logo-tagline.svg "$OUT/logo.svg"
# The sidebar's logo (no tagline), without the room above and below the drawing. Only the
# height is cropped: the name's width depends on which serif font the viewer's device has.
box=$(for q in x y width height; do inkscape --query-$q logo.svg 2>/dev/null; done | tr '\n' ' ')
adapt logo.svg "$TMP/logo-name.svg"
python3 - "$TMP/logo-name.svg" "$OUT/logo-name.svg" $box <<'PY'
import re, sys
src, out, x, y, w, h = sys.argv[1], sys.argv[2], *map(float, sys.argv[3:])
svg = open(src).read()
page_w = float(re.search(r'<svg[^>]* width="([\d.]+)"', svg)[1])
vb = [float(n) for n in re.search(r'viewBox="([^"]+)"', svg)[1].split()]
s = vb[2] / page_w  # inkscape measures in page pixels; the drawing is in viewBox units
crop = f"{vb[0]:g} {y * s - 6:.1f} {vb[2]:g} {h * s + 16:.1f}"  # (more below, for descenders)
svg = re.sub(r'(<svg[^>]*?) width="[\d.]+" height="[\d.]+"', r"\1", svg, count=1)
open(out, "w").write(re.sub(r'viewBox="[^"]+"', f'viewBox="{crop}"', svg, count=1))
PY
adapt symbol.svg "$OUT/symbol.svg"
adapt icon-small.svg "$OUT/favicon.svg"

# The app's background: the symbol in bas-relief, in greys only (the page fades it). Each part is
# raised on its own, lit from the top left; the gold faces are the lit ones, the blue ones shaded.
python3 - symbol.svg "$OUT/relief.svg" <<'PY'
import re, sys
svg = open(sys.argv[1]).read()
body = re.search(r"<g>(.*)</g>", svg, re.S)[1]
body = re.sub(r'<path d="M99 5 L99 193"[^>]*/>', "", body)  # (the faint centre line)
grey = {"#F5AB13": "#d4d4d4", "#D88A00": "#a8a8a8", "#45A9D8": "#9c9c9c",
        "#0866A8": "#7c7c7c", "#09254A": "#8c8c8c"}
body = re.sub(r'(fill|stroke)="(#[0-9A-Fa-f]{6})"',
              lambda m: f'{m[1]}="{grey[m[2].upper()]}" filter="url(#r)"', body)
relief = """<filter id="r" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
<feGaussianBlur in="SourceAlpha" stdDeviation=".5" result="b"/>
<feOffset in="b" dx=".8" dy=".8" result="d"/><feOffset in="b" dx="-.8" dy="-.8" result="u"/>
<feComposite in="b" in2="d" operator="arithmetic" k2="1" k3="-1" result="hi"/>
<feComposite in="b" in2="u" operator="arithmetic" k2="1" k3="-1" result="lo"/>
<feFlood flood-color="#fff" flood-opacity=".8"/><feComposite in2="hi" operator="in" result="hi"/>
<feFlood flood-color="#222" flood-opacity=".8"/><feComposite in2="lo" operator="in" result="lo"/>
<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="lo"/><feMergeNode in="hi"/></feMerge>
</filter>"""
open(sys.argv[2], "w").write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
                             f'<defs>{relief}</defs><g>{body}</g></svg>\n')
PY

render() { inkscape "$1" -o "$2" -w "$3" -h "$3" >/dev/null 2>&1; }
render symbol.svg "$TMP/symbol.png" 1024
# Any purpose: a white rounded square (so the navy shows on dark launchers too).
magick -size 512x512 xc:none -fill white -draw "roundrectangle 0,0 511,511 100,100" \
  \( "$TMP/symbol.png" -resize 420x420 \) -gravity center -composite "$OUT/icon-512.png"
magick "$OUT/icon-512.png" -resize 192x192 "$OUT/icon-192.png"
# Maskable (Android's shaped icons): full bleed, the symbol inside the middle 80% circle.
magick -size 512x512 xc:white \( "$TMP/symbol.png" -resize 310x310 \) -gravity center -composite "$OUT/maskable-512.png"
# iOS rounds the corners itself.
magick -size 180x180 xc:white \( "$TMP/symbol.png" -resize 146x146 \) -gravity center -composite "$OUT/apple-touch-icon.png"
# Status bar icons are drawn from the shape alone: all white.
sed -E 's/(fill|stroke)="#[0-9A-Fa-f]{6}"/\1="#FFFFFF"/g' icon-small.svg > "$TMP/mono.svg"
render "$TMP/mono.svg" "$OUT/badge-96.png" 96
render "$TMP/mono.svg" "$OUT/monochrome-512.png" 512
render icon-small.svg "$OUT/favicon-32.png" 32
echo "Icons written to static/icons."
