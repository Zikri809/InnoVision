# Build the manual website

The Markdown files one directory above are the canonical content. The
standalone HTML website and print HTML are generated in
`docs/user-manual/dist/`; do not edit generated HTML by hand. This is the
finalized internal edition. Public distribution requires the gates in
`IMPLEMENTATION_STATUS.md`.

```powershell
python -m pip install -r docs/user-manual/site-assets/requirements.txt
python scripts/build-user-manual.py
```

The builder validates relative page and heading links before writing output.
It validates figure references, copies only figures used in the pages, and
creates a lightweight client search index from page headings and section text.
It also checks that every screenshot has a caption and numbers the figures.

For local review, serve the generated directory and print the PDF from the
same content:

```powershell
python -m http.server 8765 --directory docs/user-manual/dist
node scripts/check-user-manual.mjs
node scripts/build-user-manual-pdf.mjs
```

The PDF is written to `output/pdf/easy2u-user-manual-en-internal.pdf`. After visual
review, copy it to `docs/user-manual/downloads/` and rebuild the website so the
download matches the latest source. The PDF builder uses `pypdf` to fill the
contents page with chapter start pages from the generated outline.
`scripts/capture-user-manual.mjs` repeats
the synthetic English desktop and phone captures against a local release build
on port 3100; its manifest records the commit and viewport. Do not run it
against a live institution deployment.

Publication still needs a real support contact and docs URL, final deployed
release verification, reader testing, Bahasa Malaysia review, and formal PDF
accessibility review. The user asked to keep the current artifacts internal.
