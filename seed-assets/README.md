# Seed assets — Sept 2026 intake handouts

Real lecturer handouts, seeded into the demo accounts by `scripts/seed-demo.mjs`
(subject showcase section). Three subjects, mirrored under all three lecturers:

| Subject | Files | Notes |
|---|---|---|
| Principle of Economics | `economics/ECO-Chapter01..03.pdf` | Full chapters, each under the 25 MB bucket cap |
| Risk & Insurance | `risk-insurance/RISK-Chapter01-p01-10.pdf` | First 10 of 41 pages only |
| Public Speaking Skills | `public-speaking/APS-Chapter01..02.pptx` | Full chapters |

## Why Risk is truncated

The source scan (`CHAPTER 1 pdf.pdf`, 41 pages, 32,211,853 bytes) exceeds the
`quiz-sources` bucket cap of 25 MB (`supabase/migrations/0007_ai_generation.sql`),
so uploads would be rejected by storage. Only pages 1–10 (~15 MB) are committed.

## Regenerating the Risk excerpt

From the original zip in Downloads (poppler ships with the repo's PDF tooling):

```powershell
tar -xf "$env:USERPROFILE\Downloads\RISK AND INSURANCE -20260928T124944Z-1-001.zip" -C $env:TEMP\risk --strip-components=1
pdfseparate.exe -f 1 -l 10 "$env:TEMP\risk\CHAPTER 1 pdf.pdf" "$env:TEMP\risk\page-%d.pdf"
pdfunite.exe (1..10 | ForEach-Object { "$env:TEMP\risk\page-$_.pdf" }) seed-assets\risk-insurance\RISK-Chapter01-p01-10.pdf
```

Original zips (not committed): `PRINCIPLE OF ECONOMICS -20260928T125037Z-1-001.zip`,
`RISK AND INSURANCE -20260928T124944Z-1-001.zip`,
`PUBLIC SPEAKING SKILLS-20260928T124944Z-1-001.zip`.
