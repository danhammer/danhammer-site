# danham.me

Personal site, served by GitHub Pages from the `gh-pages` branch at https://www.danham.me.

- `r/index.html`: the terminal-style home page at `/r/`. Commands live in its `COMMANDS` table.
- `r/<name>/index.html`: a side project at `/r/<name>/`. `/projects` lists these on its own (folders starting with `_` are skipped).
- `r/cv.pdf`: built from `cv-tex/main.tex` by `cv-tex/build.sh` (needs `tectonic`).
- `index.html`: sends the bare domain to `/r/`.

To preview locally, serve the repo root and open http://localhost:8765/r/:

    python3 -m http.server 8765
