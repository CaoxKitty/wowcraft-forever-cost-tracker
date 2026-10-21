/**
 * Record Forever profession leveling totals from wowcraft.io (sidebar footer "Total").
 *
 * Writes four CSV files (one per spreadsheet tab):
 *   Horde PvP, Horde PvE (Forever Normal), Alliance PvP, Alliance PvE (Forever Normal)
 *
 * Usage:
 *   npm run record
 *   npm run record -- --force
 *   npm run record -- --dry-run
 *   npm run record -- --only=horde_pvp,alliance_pve
 *
 * Env (optional):
 *   WOWCRAFT_BASE_URL        default https://wowcraft.io
 *   WOWCRAFT_TARGET          default 225
 *   WOWCRAFT_SKILL           default 1
 *   WOWCRAFT_TIMEZONE        default UTC
 *   WOWCRAFT_SCHEDULE_HOURS  default "5,13,21" (UTC)
 *   WOWCRAFT_OUTPUT_DIR      default data/history
 *   WOWCRAFT_BROWSER_EXECUTABLE  Browser binary (local); on Windows defaults to Brave if installed
 *
 * Puppeteer also respects PUPPETEER_EXECUTABLE_PATH and PUPPETEER_BROWSER.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_SCHEDULE_HOURS = '5,13,21';

/** Standard Brave install locations on Windows (Chromium; works with Puppeteer CDP). */
const BRAVE_EXECUTABLE_PATHS_WIN32 = [
  path.join(
    process.env.ProgramFiles || 'C:\\Program Files',
    'BraveSoftware',
    'Brave-Browser',
    'Application',
    'brave.exe',
  ),
  path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'BraveSoftware',
    'Brave-Browser',
    'Application',
    'brave.exe',
  ),
  path.join(
    process.env.LOCALAPPDATA || '',
    'BraveSoftware',
    'Brave-Browser',
    'Application',
    'brave.exe',
  ),
];

const PROFESSIONS = [
  'alchemy',
  'blacksmithing',
  'cooking',
  'enchanting',
  'engineering',
  'leatherworking',
  'tailoring',
];

const MARKET_TABS = [
  {
    id: 'horde_pvp',
    tab: 'Horde PvP',
    realm: 'Forever PvP',
    faction: 'Horde',
    file: 'forever_costs_horde_pvp.csv',
  },
  {
    id: 'horde_pve',
    tab: 'Horde PvE',
    realm: 'Forever Normal',
    faction: 'Horde',
    file: 'forever_costs_horde_pve.csv',
  },
  {
    id: 'alliance_pvp',
    tab: 'Alliance PvP',
    realm: 'Forever PvP',
    faction: 'Alliance',
    file: 'forever_costs_alliance_pvp.csv',
  },
  {
    id: 'alliance_pve',
    tab: 'Alliance PvE',
    realm: 'Forever Normal',
    faction: 'Alliance',
    file: 'forever_costs_alliance_pve.csv',
  },
];

const CSV_COLUMNS = [
  'recorded_at',
  'skill',
  'target',
  'realm',
  'faction',
  ...PROFESSIONS.map((p) => `${p}_copper`),
  'notes',
];

function parseArgs(argv) {
  const flags = new Set();
  let only = null;
  for (const arg of argv) {
    if (arg.startsWith('--only=')) {
      only = arg
        .slice('--only='.length)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
    if (arg.startsWith('--')) flags.add(arg.replace(/^--/, ''));
  }
  return {
    force: flags.has('force'),
    dryRun: flags.has('dry-run'),
    help: flags.has('help'),
    only,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Local runs on Windows use Brave when present; CI/Linux keeps Puppeteer's bundled Chrome. */
async function resolvePuppeteerLaunchOptions() {
  const launch = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH?.trim()) {
    return launch;
  }

  const override = process.env.WOWCRAFT_BROWSER_EXECUTABLE?.trim();
  if (override) {
    if (!(await pathExists(override))) {
      throw new Error(`WOWCRAFT_BROWSER_EXECUTABLE not found: ${override}`);
    }
    launch.executablePath = override;
    return launch;
  }

  if (process.platform === 'win32') {
    for (const candidate of BRAVE_EXECUTABLE_PATHS_WIN32) {
      if (await pathExists(candidate)) {
        launch.executablePath = candidate;
        return launch;
      }
    }
  }

  return launch;
}

function getRecordingTimeZone() {
  return process.env.WOWCRAFT_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
}

function zoneOffsetLabel(timeZone, date = new Date()) {
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName');
  const raw = tzPart?.value ?? 'GMT';
  const m = raw.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/i);
  if (!m) return '+00:00';
  return `${m[1]}${m[2].padStart(2, '0')}:${(m[3] ?? '00').padStart(2, '0')}`;
}

function zonedNowParts(timeZone = getRecordingTimeZone()) {
  const date = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const local = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  const offset = zoneOffsetLabel(timeZone, date);
  return {
    stamp: `${local} ${offset}`,
    hour: Number(get('hour')),
    timeZone,
  };
}

function shouldRunNow(force) {
  if (force) return true;
  const schedule = (process.env.WOWCRAFT_SCHEDULE_HOURS ?? DEFAULT_SCHEDULE_HOURS)
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isFinite(h));
  const { hour } = zonedNowParts();
  return schedule.includes(hour);
}

function parseMoneyText(text) {
  const cleaned = String(text ?? '')
    .replace(/[−+\u2212]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const goldMatch = cleaned.match(/(\d+)\s*g/);
  const silverMatch = cleaned.match(/(\d+)\s*s/);
  const copperMatch = cleaned.match(/(\d+)\s*c/);
  const gold = goldMatch ? Number(goldMatch[1]) : 0;
  const silver = silverMatch ? Number(silverMatch[1]) : 0;
  const copper = copperMatch ? Number(copperMatch[1]) : 0;
  if (!goldMatch && !silverMatch && copperMatch) return copper;
  return gold * 10000 + silver * 100 + copper;
}

function buildPlannerUrl(baseUrl, profession, { skill, target, realm, faction }) {
  const params = new URLSearchParams();
  params.set('version', 'Forever');
  params.set('realm', realm);
  params.set('faction', faction);
  if (skill > 1) params.set('skill', String(skill));
  if (target) params.set('target', String(target));
  return `${baseUrl.replace(/\/$/, '')}/${profession}?${params.toString()}`;
}

async function dismissForeverAnnouncement(page) {
  await page.evaluate(() => {
    document.cookie = 'wowcraft-forever-announced=1; path=/; max-age=31536000; SameSite=Lax';
  });
  const closeBtn = await page.$('[aria-labelledby="forever-announcement-title"] button');
  if (closeBtn) {
    await closeBtn.click().catch(() => {});
    await sleep(300);
  }
}

async function readSidebarTotalText(page) {
  return page.evaluate(() => {
    const totalSpan = [...document.querySelectorAll('span.text-neutral-400')].find(
      (el) => el.textContent?.trim() === 'Total',
    );
    if (!totalSpan?.parentElement) return '';
    return totalSpan.parentElement.innerText ?? '';
  });
}

async function waitForTotalCopper(page, timeoutMs = 120_000) {
  const started = Date.now();
  let lastFooter = '';
  while (Date.now() - started < timeoutMs) {
    lastFooter = await readSidebarTotalText(page);
    const copper = parseMoneyText(lastFooter);
    const loading = await page.evaluate(() => /Loading planner/i.test(document.body.innerText));
    if (!loading && Number.isFinite(copper) && copper > 0) {
      return copper;
    }
    await sleep(750);
  }
  throw new Error(`Timed out waiting for route total. Last footer: ${JSON.stringify(lastFooter.slice(0, 200))}`);
}

async function scrapeProfession(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120_000 });
  await dismissForeverAnnouncement(page);
  await sleep(500);
  return waitForTotalCopper(page);
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function appendCsvRow(outputPath, row) {
  const line = row.map(csvEscape).join(',');
  let exists = false;
  try {
    await fs.access(outputPath);
    exists = true;
  } catch {
    /* new file */
  }
  const header = CSV_COLUMNS.join(',');
  if (!exists) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${header}\n${line}\n`, 'utf8');
    return;
  }
  const prev = await fs.readFile(outputPath, 'utf8');
  const needsHeader = !prev.trim();
  await fs.appendFile(outputPath, `${needsHeader ? `${header}\n` : ''}${line}\n`, 'utf8');
}

function resolveMarkets(onlyIds) {
  if (!onlyIds?.length) return MARKET_TABS;
  const set = new Set(onlyIds);
  const picked = MARKET_TABS.filter((m) => set.has(m.id));
  if (!picked.length) {
    const valid = MARKET_TABS.map((m) => m.id).join(', ');
    throw new Error(`No markets matched --only. Valid ids: ${valid}`);
  }
  return picked;
}

function printHelp() {
  console.log(`Record Forever profession totals from wowcraft.io (four CSV tabs)

Options:
  --force              Run even outside scheduled UTC hours (${DEFAULT_SCHEDULE_HOURS})
  --dry-run            Print values without writing CSV
  --only=id1,id2       Subset of: ${MARKET_TABS.map((m) => m.id).join(', ')}
  --help               Show this message

Output files (under WOWCRAFT_OUTPUT_DIR):
${MARKET_TABS.map((m) => `  ${m.tab.padEnd(14)} → ${m.file}  (${m.realm}, ${m.faction})`).join('\n')}
`);
}

async function recordMarket(page, baseUrl, market, { skill, target, recordedAt, dryRun, outputDir }) {
  const opts = { skill, target, realm: market.realm, faction: market.faction };
  const totals = {};

  console.log(`\n[${market.tab}] ${market.realm} / ${market.faction}`);

  for (const profession of PROFESSIONS) {
    const url = buildPlannerUrl(baseUrl, profession, opts);
    process.stdout.write(`  ${profession}… `);
    try {
      totals[profession] = await scrapeProfession(page, url);
      console.log(`${totals[profession]} copper`);
    } catch (err) {
      totals[profession] = '';
      console.log(`FAILED (${err.message})`);
    }
  }

  const row = [
    recordedAt,
    skill,
    target,
    market.realm,
    market.faction,
    ...PROFESSIONS.map((p) => totals[p] ?? ''),
    '',
  ];

  const outputPath = path.join(outputDir, market.file);

  if (dryRun) {
    console.log(`  Dry run → ${market.file}:`, Object.fromEntries(CSV_COLUMNS.map((k, i) => [k, row[i]])));
    return;
  }

  await appendCsvRow(outputPath, row);
  console.log(`  Appended row → ${outputPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const timeZone = getRecordingTimeZone();

  if (!shouldRunNow(args.force)) {
    const { hour, stamp } = zonedNowParts(timeZone);
    const schedule = process.env.WOWCRAFT_SCHEDULE_HOURS ?? DEFAULT_SCHEDULE_HOURS;
    console.log(
      `Skipping: ${timeZone} hour is ${hour} (${stamp}), not in WOWCRAFT_SCHEDULE_HOURS (${schedule}). Use --force to run anyway.`,
    );
    return;
  }

  const baseUrl = process.env.WOWCRAFT_BASE_URL ?? 'https://wowcraft.io';
  const target = Number(process.env.WOWCRAFT_TARGET ?? '225');
  const skill = Number(process.env.WOWCRAFT_SKILL ?? '1');
  const outputDir = path.resolve(root, process.env.WOWCRAFT_OUTPUT_DIR ?? 'data/history');
  const markets = resolveMarkets(args.only);

  const { stamp: recordedAt } = zonedNowParts(timeZone);

  console.log(`Recording Forever costs at ${recordedAt} (${timeZone})`);
  console.log(`  ${baseUrl}  skill=${skill}  target=${target}  markets=${markets.map((m) => m.id).join(', ')}`);

  const launchOptions = await resolvePuppeteerLaunchOptions();
  if (launchOptions.executablePath) {
    console.log(`  Browser: ${launchOptions.executablePath}`);
  } else if (process.env.PUPPETEER_EXECUTABLE_PATH?.trim()) {
    console.log(`  Browser: ${process.env.PUPPETEER_EXECUTABLE_PATH.trim()}`);
  }

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setCookie({
      name: 'wowcraft-forever-announced',
      value: '1',
      domain: new URL(baseUrl).hostname,
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    });

    for (const market of markets) {
      await recordMarket(page, baseUrl, market, {
        skill,
        target,
        recordedAt,
        dryRun: args.dryRun,
        outputDir,
      });
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
