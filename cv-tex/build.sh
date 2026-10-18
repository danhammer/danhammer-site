#!/usr/bin/env bash
# Build the CV: compile cv-tex/main.tex with tectonic and copy the PDF to r/cv.pdf.
#
#   cv-tex/build.sh           one-shot build
#   cv-tex/build.sh --watch   rebuild every time main.tex is saved (Ctrl-C to stop)
#
# Requires tectonic (brew install tectonic). Build output goes to cv-tex/build/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/main.tex"
OUT_DIR="$HERE/build"
DEST="$HERE/../r/cv.pdf"

command -v tectonic >/dev/null || { echo "tectonic not found: brew install tectonic" >&2; exit 1; }

build() {
  mkdir -p "$OUT_DIR"
  if tectonic --chatter minimal --keep-logs --outdir "$OUT_DIR" "$SRC"; then
    cp "$OUT_DIR/main.pdf" "$DEST"
    echo "[$(date +%H:%M:%S)] built -> r/cv.pdf"
  else
    echo "[$(date +%H:%M:%S)] build FAILED (see $OUT_DIR/main.log); r/cv.pdf unchanged" >&2
    return 1
  fi
}

mtime() { stat -f %m "$SRC" 2>/dev/null || stat -c %Y "$SRC"; }

if [[ "${1:-}" == "--watch" ]]; then
  build || true
  echo "Watching $SRC (Ctrl-C to stop)..."
  if command -v fswatch >/dev/null; then
    fswatch -o "$SRC" | while read -r _; do build || true; done
  else
    last="$(mtime)"
    while true; do
      sleep 1
      now="$(mtime)"
      if [[ "$now" != "$last" ]]; then last="$now"; build || true; fi
    done
  fi
else
  build
fi
