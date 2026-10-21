# WoWCraft Forever profession cost tracker

Small standalone tool: reads the **Total** cost on [wowcraft.io](https://wowcraft.io) for Forever professions (1→target) and appends rows to four CSV files (Horde/Alliance × PvP/PvE).

This repo is **not** the WoWCraft website—only the scraper, history CSVs, and GitHub Action.

## Local setup

Install [Brave](https://brave.com/) (or set `PUPPETEER_EXECUTABLE_PATH` / `WOWCRAFT_BROWSER_EXECUTABLE` to another Chromium browser). On **Windows**, the recorder auto-uses Brave when it is installed—Google Chrome is not required.

```powershell
cd wowcraft-forever-cost-tracker
npm install
npm run record -- --force --dry-run
```

Remove `--dry-run` to write CSVs under `data/history/`.

GitHub Actions uses Puppeteer’s bundled Chrome on Linux; no Brave install there.

## Schedule (GitHub Actions)

Automatic runs use **UTC** hours **5, 13, and 21** (about 06:00 / 14:00 / 22:00 CET in winter).

After push, enable **Actions** on the repo and set workflow permissions to **Read and write** so commits to the CSV files succeed.

Manual test in Actions: **Record Forever profession costs → Run workflow** (still respects the hour check unless you add `--force` to the workflow for dispatch only).

## When Forever max skill becomes 300

Set `WOWCRAFT_TARGET` to `300` in `.github/workflows/record-forever-costs.yml` (and locally via env if needed).

## CSV files (spreadsheet tabs)

| File | Market |
|------|--------|
| `data/history/forever_costs_horde_pvp.csv` | Horde PvP |
| `data/history/forever_costs_horde_pve.csv` | Horde PvE (Forever Normal) |
| `data/history/forever_costs_alliance_pvp.csv` | Alliance PvP |
| `data/history/forever_costs_alliance_pve.csv` | Alliance PvE |
