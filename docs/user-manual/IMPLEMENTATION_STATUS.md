# User manual implementation status

## Completed in this internal edition

- Student and lecturer task guides, quick help for an active quiz, common
  troubleshooting, glossary, support outline, entry page, and change log.
- Desktop and phone instructions where the code shows different navigation or
  controls, including the lecturer builder and gradebook.
- Standalone static HTML manual with responsive navigation and client search,
  generated from the Markdown source by `scripts/build-user-manual.py`.
- Build-time validation of local page links and heading anchors.
- English desktop and phone screenshots from a local release build with
  synthetic accounts, including class joining, the practice player, lecturer
  builder, results, and gradebook. The capture manifest records their source.
- Tagged, bookmarked English PDF from the same Markdown source, with
  page render checks and a website download copy.

Luna completed the student guide and initial troubleshooting draft as a
bounded subtask, then checked student procedures in the local production UI.
The primary agent reviewed and integrated those files, captured the selected
screens, and built the site and PDF. No E2E suite was started for this work.

## Required before publication

1. Verify every critical procedure against the deployed release and complete
   live camera, assessment gate, pause/recovery, and AI workflow captures.
   The present figures cover the accessible local UI and practice player;
   they do not depict real face capture or a verified assessment interruption.
2. Audit selected desktop and phone figures against the final release. The
   older repository screenshots remain excluded.
3. Obtain the institution's real support contact and decide the docs-site URL.
   Replace the internal-edition notice in `support.md` with the real contact.
4. Arrange first-time student and lecturer testing on desktop and phone;
   revise confusing steps and retest.
5. Translate and review the Bahasa Malaysia edition, including localized
   screenshots and small-phone layouts.
6. Perform formal PDF accessibility checks (tags, reading order, keyboard and
   link behavior), then publish the approved static site and PDF with the
   matching app version.

The user approved this as the finalized internal edition. The static output in
`docs/user-manual/dist/` and the English PDF are ready for internal use and are
not publicly hosted. The gates above still apply before public distribution.
