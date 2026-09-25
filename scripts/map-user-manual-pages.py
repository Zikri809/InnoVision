"""Return chapter start pages from Chromium's PDF heading outline."""

from __future__ import annotations

import json
import sys

from pypdf import PdfReader


pdf_path, chapter_count_text = sys.argv[1:3]
chapter_count = int(chapter_count_text)
reader = PdfReader(pdf_path)
top_level = [item for item in reader.outline if not isinstance(item, list)]
if len(top_level) < chapter_count + 2:
    raise SystemExit("PDF outline is missing cover, contents, or chapter headings")
chapters = top_level[-chapter_count:]
print(json.dumps([reader.get_destination_page_number(item) + 1 for item in chapters]))
