"""Build the standalone Easy2U manual from docs/user-manual Markdown.

Requires Python-Markdown 3.x. No app server or database is used.
Run: python scripts/build-user-manual.py
"""

from __future__ import annotations

import html
import json
import re
import shutil
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote

import markdown


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "user-manual"
OUTPUT = SOURCE / "dist"
ASSETS = SOURCE / "site-assets"
PAGES = [
    ("README.md", "Start here"),
    ("student.md", "Student guide"),
    ("lecturer.md", "Lecturer guide"),
    ("during-quiz.md", "During a quiz"),
    ("troubleshooting.md", "Troubleshooting"),
    ("glossary.md", "Glossary"),
    ("support.md", "Get more help"),
    ("CHANGELOG.md", "Change log"),
]
NAV_GROUPS = [
    ("Start", ["README.md"]),
    ("Guides", ["student.md", "lecturer.md", "during-quiz.md"]),
    ("Help and reference", ["troubleshooting.md", "glossary.md", "support.md", "CHANGELOG.md"]),
]


class HeadingReader(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.headings: list[tuple[int, str, str]] = []
        self.current: tuple[int, str] | None = None
        self.buffer: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"h1", "h2", "h3"}:
            anchor = dict(attrs).get("id")
            if anchor:
                self.current = (int(tag[1]), anchor)
                self.buffer = []

    def handle_endtag(self, tag: str) -> None:
        if self.current and tag == f"h{self.current[0]}":
            level, anchor = self.current
            self.headings.append((level, anchor, "".join(self.buffer).strip()))
            self.current = None

    def handle_data(self, data: str) -> None:
        if self.current:
            self.buffer.append(data)


def render_markdown(source: str) -> tuple[str, list[tuple[int, str, str]]]:
    body = markdown.markdown(
        source,
        extensions=["extra", "toc", "sane_lists"],
        output_format="html5",
    )
    body = re.sub(r'href="([A-Za-z0-9_-]+)\.md(#[^"]*)?"',
                  lambda m: f'href="{("index" if m.group(1) == "README" else m.group(1))}.html{m.group(2) or ""}"',
                  body)
    figure_number = 0

    def label_figure(match: re.Match[str]) -> str:
        nonlocal figure_number
        figure_number += 1
        return f'<figcaption><span class="figure-number">Figure {figure_number}.</span> '

    body = re.sub(r"<figcaption>", label_figure, body)
    reader = HeadingReader()
    reader.feed(body)
    return body, reader.headings


def validate_links(source_name: str, source: str,
                   anchors: dict[str, set[str]]) -> list[str]:
    errors: list[str] = []
    for target in re.findall(r"\]\(([^)]+)\)", source):
        if target.startswith(("https://", "http://", "mailto:")):
            continue
        path, _, fragment = target.partition("#")
        destination = path or source_name
        if destination.startswith("screenshots/figures/"):
            if not (SOURCE / destination).is_file():
                errors.append(f"{source_name}: missing figure {destination}")
            continue
        if destination.startswith("downloads/"):
            if not (SOURCE / destination).is_file():
                errors.append(f"{source_name}: missing download {destination}")
            continue
        if destination not in anchors:
            errors.append(f"{source_name}: missing local target {destination}")
        elif fragment and unquote(fragment) not in anchors[destination]:
            errors.append(f"{source_name}: missing anchor {destination}#{fragment}")
    for target in re.findall(r'(?:src|href)="(screenshots/figures/[^\"]+)"', source):
        if not (SOURCE / target).is_file():
            errors.append(f"{source_name}: missing figure {target}")
    return errors


def page_html(title: str, body: str, headings: list[tuple[int, str, str]],
              current: str) -> str:
    labels = dict(PAGES)
    nav_items = "\n".join(
        f'<div class="nav-group"><p class="nav-group-label">{html.escape(group)}</p>'
        + "".join(
            f'<a href="{("index" if name == "README.md" else Path(name).stem)}.html"'
            f'{" aria-current=\"page\"" if name == current else ""}>'
            f'{html.escape(labels[name])}</a>'
            for name in names
        ) + "</div>"
        for group, names in NAV_GROUPS
    )
    toc = "\n".join(
        f'<a class="toc-level-{level}" href="#{html.escape(anchor)}">'
        f'{html.escape(text)}</a>'
        for level, anchor, text in headings if level in {2, 3}
    )
    local_toc = (
        f'<details class="page-toc"><summary>On this page '
        f'<span>{sum(level == 2 for level, _, _ in headings)} topics</span></summary>'
        f'<nav aria-label="On this page">{toc}</nav></details>'
        if toc else ""
    )
    article_body = body.replace("</h1>", f"</h1>{local_toc}", 1)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>{html.escape(title)} · Easy2U manual</title>
  <meta name="description" content="Task-based help for Easy2U students and lecturers.">
  <link rel="stylesheet" href="style.css">
  <script src="search.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#article">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="index.html" aria-label="Easy2U manual home"><span class="brand-mark" aria-hidden="true">E2</span><span>Easy2U <small>User manual</small></span></a>
    <a class="back-app" href="support.html">Get help</a>
  </header>
  <div class="mobile-tools">
    <details class="mobile-menu"><summary>Manual sections</summary><nav aria-label="Manual sections">{nav_items}</nav></details>
  </div>
  <div class="layout">
    <aside class="sidebar" aria-label="Manual navigation">
      <label class="search-label" for="manual-search">Search the manual</label>
      <input id="manual-search" class="search-input" type="search" placeholder="Search tasks and problems…" autocomplete="off" aria-controls="search-results">
      <div id="search-results" class="search-results" role="status" aria-live="polite" hidden></div>
      <nav class="section-nav" aria-label="Manual sections">{nav_items}</nav>
    </aside>
    <main id="article" class="article-card" tabindex="-1">
      <article>{article_body}</article>
      <footer class="article-footer"><a href="support.html">Need more help?</a><span>English internal edition · 25 September 2026</span></footer>
    </main>
    <aside class="on-page" aria-label="On this page"><p>On this page</p><nav>{toc}</nav></aside>
  </div>
  <div class="mobile-search" aria-label="Search this manual">
    <label for="manual-search-mobile">Search the manual</label>
    <input id="manual-search-mobile" type="search" placeholder="Search tasks and problems…" autocomplete="off" aria-controls="mobile-search-results">
    <div id="mobile-search-results" role="status" aria-live="polite" hidden></div>
  </div>
</body>
</html>
"""


def print_html(rendered: dict[str, tuple[str, list[tuple[int, str, str]]]]) -> str:
    chapters: list[str] = []
    contents: list[str] = []
    for name, label in PAGES:
        slug = "index" if name == "README.md" else Path(name).stem
        subtopics = "".join(
            f'<li><a href="#{slug}--{html.escape(anchor)}">'
            f'{html.escape(text)}</a></li>'
            for level, anchor, text in rendered[name][1]
            if level == 2 and slug in {"student", "lecturer", "troubleshooting"}
        )
        contents.append(
            f'<li class="contents-chapter"><div class="contents-row">'
            f'<a href="#chapter-{slug}">{html.escape(label)}</a>'
            f'<span class="toc-page" data-chapter="{slug}">--</span></div>'
            + (f'<ul class="contents-subtopics">{subtopics}</ul>' if subtopics else "")
            + '</li>'
        )
        body = rendered[name][0]
        body = re.sub(r'id="([^"]+)"',
                      lambda m: f'id="{slug}--{m.group(1)}"', body)

        def print_href(match: re.Match[str]) -> str:
            target = match.group(1)
            if target.startswith("#"):
                return f'href="#{slug}--{target[1:]}"'
            page, _, anchor = target.partition("#")
            if page.endswith(".html"):
                destination = Path(page).stem
                return (f'href="#{destination}--{anchor}"' if anchor
                        else f'href="#chapter-{destination}"')
            return match.group(0)

        body = re.sub(r'href="([^"]+)"', print_href, body)
        body = body.replace('loading="lazy"', 'loading="eager"')
        body = body.replace(" Select the image to enlarge it.", "")
        body = re.sub(r'<a href="screenshots/figures/[^\"]+">(<img[^>]+>)</a>',
                      r'\1', body)
        chapters.append(
            f'<section class="print-chapter" id="chapter-{slug}">{body}</section>'
        )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Easy2U user manual - English internal edition</title>
<link rel="stylesheet" href="print.css"></head><body>
<section class="print-cover"><p class="eyebrow">EASY2U - USER MANUAL</p>
<h1>Learn Easy2U</h1><p class="subtitle">Student and lecturer guide</p>
<p>English internal edition - 25 September 2026</p>
<p class="notice">For internal use. Confirm support details, live recovery flows, and reader testing before public distribution.</p></section>
<section class="print-contents"><h1>Contents</h1><ol>{''.join(contents)}</ol></section>
{''.join(chapters)}
</body></html>"""


def main() -> None:
    content: dict[str, str] = {}
    rendered: dict[str, tuple[str, list[tuple[int, str, str]]]] = {}
    for name, _ in PAGES:
        path = SOURCE / name
        if not path.exists():
            raise SystemExit(f"Missing manual page: {path}")
        content[name] = path.read_text(encoding="utf-8")
        rendered[name] = render_markdown(content[name])

    anchors = {
        name: {anchor for _, anchor, _ in headings}
        for name, (_, headings) in rendered.items()
    }
    errors = [error for name, source in content.items()
              for error in validate_links(name, source, anchors)]
    for name, source in content.items():
        if source.count('<figure class="manual-shot"') != source.count("<figcaption>"):
            errors.append(f"{name}: every manual figure needs a caption")
    if errors:
        raise SystemExit("Manual links need repair:\n" + "\n".join(errors))

    OUTPUT.mkdir(parents=True, exist_ok=True)
    index: list[dict[str, str]] = []
    for name, label in PAGES:
        body, headings = rendered[name]
        output_name = "index.html" if name == "README.md" else f"{Path(name).stem}.html"
        (OUTPUT / output_name).write_text(
            page_html(label, body, headings, name), encoding="utf-8"
        )
        source = content[name]
        section_starts = list(re.finditer(r"(?m)^#{1,3}\s+", source))
        for position, (level, anchor, title) in enumerate(headings):
            if level not in {1, 2, 3}:
                continue
            if position < len(section_starts):
                section_end = (section_starts[position + 1].start()
                               if position + 1 < len(section_starts) else len(source))
                section_text = source[section_starts[position].end():section_end]
            else:
                section_text = title
            section_text = re.sub(r"\[[^]]+\]\([^)]+\)", " ", section_text)
            section_text = re.sub(r"<[^>]+>", " ", section_text)
            section_text = re.sub(r"[#*_`|>]", " ", section_text)
            section_text = re.sub(r"\s+", " ", section_text).strip()[:900]
            index.append({"title": title, "page": label,
                          "url": f"{output_name}#{anchor}", "text": section_text})

    shutil.copyfile(ASSETS / "style.css", OUTPUT / "style.css")
    shutil.copyfile(ASSETS / "search.js", OUTPUT / "search.js")
    shutil.copyfile(ASSETS / "print.css", OUTPUT / "print.css")
    figure_output = (OUTPUT / "screenshots" / "figures").resolve()
    if OUTPUT.resolve() not in figure_output.parents:
        raise SystemExit("Unsafe figure output path")
    if figure_output.exists():
        shutil.rmtree(figure_output)
    figure_output.mkdir(parents=True)
    figure_names = {
        filename
        for source in content.values()
        for filename in re.findall(r"screenshots/figures/([A-Za-z0-9_.-]+\.png)", source)
    }
    for filename in sorted(figure_names):
        shutil.copyfile(SOURCE / "screenshots" / "figures" / filename,
                        figure_output / filename)
    download_output = (OUTPUT / "downloads").resolve()
    if OUTPUT.resolve() not in download_output.parents:
        raise SystemExit("Unsafe download output path")
    if download_output.exists():
        shutil.rmtree(download_output)
    shutil.copytree(SOURCE / "downloads", download_output)
    (OUTPUT / "print.html").write_text(print_html(rendered), encoding="utf-8")
    (OUTPUT / "search-index.json").write_text(
        json.dumps(index, ensure_ascii=False), encoding="utf-8"
    )
    print(f"Built {len(PAGES)} manual pages in {OUTPUT}")


if __name__ == "__main__":
    main()
