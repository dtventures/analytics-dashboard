#!/usr/bin/env node

const path = require('path');
const { google } = require('googleapis');
const http = require('http');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

const TOKEN_FILE = path.join(os.homedir(), '.analytics-cli.json');
const CONFIG_FILE = path.join(os.homedir(), '.analytics-cli-config.json');
const CLI_PORT = 3001;
const CLI_REDIRECT = `http://localhost:${CLI_PORT}/callback`;

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days='))?.split('=')[1]
             ?? args[args.indexOf('--days') + 1];
const DAYS = parseInt(daysArg, 10) || 30;

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const bold    = s => `\x1b[1m${s}\x1b[0m`;
const dim     = s => `\x1b[2m${s}\x1b[0m`;
const green   = s => `\x1b[32m${s}\x1b[0m`;
const red     = s => `\x1b[31m${s}\x1b[0m`;
const cyan    = s => `\x1b[36m${s}\x1b[0m`;
const yellow  = s => `\x1b[33m${s}\x1b[0m`;
const gray    = s => `\x1b[90m${s}\x1b[0m`;

// ── Formatting ────────────────────────────────────────────────────────────────

function num(n) {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
}

function pct(n) {
  if (!n && n !== 0) return '—';
  return (n * 100).toFixed(1) + '%';
}

function dur(secs) {
  if (!secs) return '0s';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function change(val) {
  if (val === null || val === undefined) return gray('      —');
  const sign = val > 0 ? '+' : '';
  const str = `${sign}${val}%`;
  return val > 0 ? green(str.padStart(7)) : val < 0 ? red(str.padStart(7)) : gray(str.padStart(7));
}

function bar(val, max, width = 18) {
  const filled = max ? Math.round((val / max) * width) : 0;
  return cyan('█'.repeat(filled)) + gray('░'.repeat(width - filled));
}

function sparkline(points) {
  const chars = ['▁','▂','▃','▄','▅','▆','▇','█'];
  if (!points.length) return '';
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  return points.map(v => {
    const idx = Math.round(((v - min) / range) * (chars.length - 1));
    return cyan(chars[idx]);
  }).join('');
}

function section(title) {
  console.log(`\n${bold(cyan(title))}`);
  console.log(gray('─'.repeat(62)));
}

function header(days) {
  console.log('\n' + bold(cyan('━'.repeat(62))));
  console.log(bold(cyan('  Analytics Dashboard')) + gray(`  ·  last ${days} days  ·  ${new Date().toLocaleDateString()}`));
  console.log(bold(cyan('━'.repeat(62))));
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

const HOSTED_AUTH_URL = 'https://analyticsdash.lighthouselaunch.com/cli-auth';

async function runOAuthFlow() {
  console.log('\n' + bold('🔐 Sign in with Google to get started'));
  console.log(dim('\n  Opening browser...'));
  openBrowser(HOSTED_AUTH_URL);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://localhost:${CLI_PORT}`);
      const encoded = u.searchParams.get('tokens');
      const error = u.searchParams.get('error');

      if (error) {
        res.end(`<h2>Auth failed: ${error}</h2><p>Close this tab and check your terminal.</p>`);
        server.close();
        return reject(new Error('OAuth error: ' + error));
      }

      if (!encoded) { res.end('Waiting...'); return; }

      res.end('<h2 style="font-family:sans-serif">✅ Authenticated! You can close this tab.</h2>');
      server.close();

      try {
        const tokens = JSON.parse(decodeURIComponent(encoded));
        saveTokens(tokens);
        console.log(green('\n✓ Signed in — tokens saved.\n'));
        resolve(tokens);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(CLI_PORT, () =>
      console.log(dim(`  Waiting for login on port ${CLI_PORT}...`))
    );
    server.on('error', reject);
  });
}

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }
  catch { return null; }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return null; }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function openBrowser(url) {
  try { execSync(`open "${url}"`, { stdio: 'ignore' }); }
  catch { console.log(`\nOpen this URL in your browser:\n${url}\n`); }
}

async function runOAuthFlow(clientId, clientSecret) {
  const client = createOAuthClient(clientId, clientSecret);
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  console.log('\n' + bold('🔐 First-time setup — Google authentication required'));
  console.log(dim(`\n  Make sure this redirect URI is added in Google Cloud Console:`));
  console.log(cyan(`  http://localhost:${CLI_PORT}/callback`));
  console.log(dim('\n  Opening browser...'));
  openBrowser(url);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://localhost:${CLI_PORT}`);
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');

      if (error) {
        res.end(`<h2>Auth failed: ${error}</h2><p>Close this tab and check your terminal.</p>`);
        server.close();
        return reject(new Error('OAuth error: ' + error));
      }

      if (!code) { res.end('Waiting...'); return; }

      res.end('<h2 style="font-family:sans-serif">✅ Authenticated! You can close this tab.</h2>');
      server.close();

      try {
        const { tokens } = await client.getToken(code);
        saveTokens(tokens);
        console.log(green('\n✓ Authenticated — tokens saved to ~/.analytics-cli.json\n'));
        resolve(tokens);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(CLI_PORT, () =>
      console.log(dim(`\n  Waiting for OAuth callback on port ${CLI_PORT}...`))
    );
    server.on('error', reject);
  });
}

const HOSTED_REFRESH_URL = 'https://analyticsdash.lighthouselaunch.com/cli-refresh';

async function refreshTokens(tokens) {
  const res = await fetch(HOSTED_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: tokens.refresh_token }),
  });
  if (!res.ok) throw new Error('Token refresh failed — run analytics-dash --reauth');
  const data = await res.json();
  return { ...tokens, access_token: data.access_token, expiry_date: data.expiry_date };
}

async function getAuthClient() {
  let tokens = loadTokens();
  if (!tokens) tokens = await runOAuthFlow();

  // Refresh if expired (with 60s buffer)
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - 60000) {
    try {
      tokens = await refreshTokens(tokens);
      saveTokens(tokens);
    } catch (e) {
      console.error(yellow('\n⚠ Token refresh failed — re-authenticating...\n'));
      tokens = await runOAuthFlow();
    }
  }

  const { google: g } = require('googleapis');
  const client = new g.auth.OAuth2();
  client.setCredentials(tokens);
  return client;
}

// ── Property / site selection ─────────────────────────────────────────────────

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function selectConfig(auth) {
  console.log(dim('\nFetching your GA4 properties and GSC sites...\n'));

  const [gaRes, gscRes] = await Promise.allSettled([
    google.analyticsadmin({ version: 'v1beta', auth }).accountSummaries.list(),
    google.webmasters({ version: 'v3', auth }).sites.list(),
  ]);

  // GA4 properties
  const properties = [];
  if (gaRes.status === 'fulfilled') {
    for (const account of gaRes.value.data.accountSummaries || []) {
      for (const prop of account.propertySummaries || []) {
        properties.push({
          id: prop.property.replace('properties/', ''),
          name: prop.displayName,
          account: account.displayName,
        });
      }
    }
  }

  let propertyId;
  if (properties.length === 0) {
    console.log(yellow('⚠ No GA4 properties found.'));
    propertyId = await ask('  Enter GA4 property ID manually: ');
  } else if (properties.length === 1) {
    propertyId = properties[0].id;
    console.log(green(`✓ GA4 property: ${properties[0].name}`) + gray(` (${propertyId})`));
  } else {
    console.log(bold('GA4 Properties:'));
    properties.forEach((p, i) =>
      console.log(`  ${gray(String(i + 1).padStart(2))}  ${p.name}  ${gray(p.id)}`)
    );
    const pick = await ask(`\nSelect [1–${properties.length}]: `);
    const idx = Math.max(0, Math.min(parseInt(pick, 10) - 1, properties.length - 1));
    propertyId = properties[idx].id;
  }

  // GSC sites
  const sites = gscRes.status === 'fulfilled'
    ? (gscRes.value.data.siteEntry || []).map(s => s.siteUrl)
    : [];

  let siteUrl = '';
  if (sites.length === 0) {
    console.log(yellow('\n⚠ No GSC sites found.'));
    siteUrl = await ask('  Enter GSC site URL (or leave blank to skip): ');
  } else if (sites.length === 1) {
    siteUrl = sites[0];
    console.log(green(`✓ GSC site: ${siteUrl}`));
  } else {
    console.log(bold('\nGSC Sites:'));
    sites.forEach((s, i) => console.log(`  ${gray(String(i + 1).padStart(2))}  ${s}`));
    const pick = await ask(`\nSelect [1–${sites.length}]: `);
    const idx = Math.max(0, Math.min(parseInt(pick, 10) - 1, sites.length - 1));
    siteUrl = sites[idx];
  }

  const config = { propertyId, siteUrl };
  saveConfig(config);
  console.log(green('\n✓ Config saved to ~/.analytics-cli-config.json\n'));
  return config;
}

// ── Data fetching ─────────────────────────────────────────────────────────────

function ga4Client(auth) {
  return google.analyticsdata({ version: 'v1beta', auth });
}

function gaDateRange(days, endDays = 0) {
  return { startDate: `${days}daysAgo`, endDate: endDays === 0 ? 'today' : `${endDays}daysAgo` };
}

function gscDateRange(days) {
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
  };
}

async function fetchAll(auth, propertyId, siteUrl, days) {
  const ga = ga4Client(auth);
  const prop = `properties/${propertyId}`;
  const dr = [gaDateRange(days)];
  const gscRange = gscDateRange(days);
  const sc = google.webmasters({ version: 'v3', auth });

  return Promise.allSettled([
    // 0 — realtime
    ga.properties.runRealtimeReport({
      property: prop,
      requestBody: {
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'activeUsers' }],
      },
    }),

    // 1 — overview (two date ranges for period comparison)
    ga.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: [gaDateRange(days), gaDateRange(days * 2, days + 1)],
        metrics: [
          { name: 'totalUsers' }, { name: 'sessions' }, { name: 'conversions' },
          { name: 'engagementRate' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' },
        ],
      },
    }),

    // 2 — channels
    ga.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: dr,
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 8,
      },
    }),

    // 3 — top pages
    ga.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: dr,
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'userEngagementDuration' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10,
      },
    }),

    // 4 — daily trend
    ga.properties.runReport({
      property: prop,
      requestBody: {
        dateRanges: dr,
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      },
    }),

    // 5 — GSC trend (for totals)
    siteUrl ? sc.searchanalytics.query({
      siteUrl,
      requestBody: { ...gscRange, dimensions: ['date'], rowLimit: 90 },
    }) : Promise.resolve(null),

    // 6 — GSC top queries
    siteUrl ? sc.searchanalytics.query({
      siteUrl,
      requestBody: {
        ...gscRange,
        dimensions: ['query'],
        rowLimit: 15,
        orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
      },
    }) : Promise.resolve(null),

    // 7 — GSC top pages
    siteUrl ? sc.searchanalytics.query({
      siteUrl,
      requestBody: {
        ...gscRange,
        dimensions: ['page'],
        rowLimit: 8,
        orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
      },
    }) : Promise.resolve(null),
  ]);
}

// ── Render sections ───────────────────────────────────────────────────────────

function renderRealtime(result) {
  section('⚡ Realtime');
  if (result.status !== 'fulfilled') {
    console.log(red('  Error: ') + result.reason?.message); return;
  }
  const rows = result.value.data.rows || [];
  const total = rows.reduce((s, r) => s + parseInt(r.metricValues[0].value, 10), 0);
  console.log(`  ${bold(cyan(String(total)))} active users right now`);
  rows.slice(0, 6).forEach(r => {
    const src = r.dimensionValues[0].value;
    const u = parseInt(r.metricValues[0].value, 10);
    console.log(`  ${gray('·')} ${src.padEnd(30)} ${gray(num(u) + ' users')}`);
  });
}

function renderOverview(result) {
  section('📊 Overview');
  if (result.status !== 'fulfilled') {
    console.log(red('  Error: ') + result.reason?.message); return;
  }
  const rows = result.value.data.rows || [];
  const curr = { users: 0, sessions: 0, conversions: 0, engagementRate: 0, bounceRate: 0, avgDuration: 0 };
  const prev = { ...curr };
  let currCount = 0, prevCount = 0;

  for (const row of rows) {
    const isRange1 = row.dimensionValues?.[0]?.value === 'date_range_1';
    const target = isRange1 ? prev : curr;
    target.users        += parseInt(row.metricValues[0].value, 10);
    target.sessions     += parseInt(row.metricValues[1].value, 10);
    target.conversions  += parseInt(row.metricValues[2].value, 10);
    target.engagementRate += parseFloat(row.metricValues[3].value);
    target.bounceRate   += parseFloat(row.metricValues[4].value);
    target.avgDuration  += parseFloat(row.metricValues[5].value);
    isRange1 ? prevCount++ : currCount++;
  }

  function chg(a, b) {
    if (!b) return null;
    return Math.round(((a - b) / b) * 1000) / 10;
  }

  const avgDiv = n => currCount > 0 ? n / currCount : 0;

  [
    ['Users',           num(curr.users),                 chg(curr.users, prev.users)],
    ['Sessions',        num(curr.sessions),              chg(curr.sessions, prev.sessions)],
    ['Conversions',     num(curr.conversions),           chg(curr.conversions, prev.conversions)],
    ['Engagement Rate', pct(avgDiv(curr.engagementRate)), chg(curr.engagementRate, prev.engagementRate)],
    ['Bounce Rate',     pct(avgDiv(curr.bounceRate)),    chg(curr.bounceRate, prev.bounceRate)],
    ['Avg Duration',    dur(avgDiv(curr.avgDuration)),   null],
  ].forEach(([label, val, chgVal]) => {
    console.log(`  ${label.padEnd(22)} ${bold(val.padStart(10))}   ${change(chgVal)}`);
  });
}

function renderChannels(result) {
  section('📣 Channels');
  if (result.status !== 'fulfilled') {
    console.log(red('  Error: ') + result.reason?.message); return;
  }
  const rows = result.value.data.rows || [];
  const total = rows.reduce((s, r) => s + parseInt(r.metricValues[0].value, 10), 0);
  rows.forEach(r => {
    const ch = r.dimensionValues[0].value;
    const sess = parseInt(r.metricValues[0].value, 10);
    const pctVal = total ? Math.round((sess / total) * 100) : 0;
    console.log(`  ${ch.padEnd(28)} ${bar(sess, total, 16)}  ${num(sess).padStart(8)}  ${gray(pctVal + '%')}`);
  });
}

function renderTrend(result) {
  section('📈 Session Trend');
  if (result.status !== 'fulfilled') {
    console.log(red('  Error: ') + result.reason?.message); return;
  }
  const rows = result.value.data.rows || [];
  const points = rows.map(r => parseInt(r.metricValues[0].value, 10));
  if (!points.length) { console.log(gray('  No data')); return; }

  const max = Math.max(...points);
  const min = Math.min(...points);
  const avg = Math.round(points.reduce((a, b) => a + b, 0) / points.length);

  console.log(`  ${sparkline(points)}`);
  console.log(gray(`  min ${num(min)}  ·  avg ${num(avg)}  ·  max ${num(max)}`));
}

function renderPages(result) {
  section('📄 Top Pages');
  if (result.status !== 'fulfilled') {
    console.log(red('  Error: ') + result.reason?.message); return;
  }
  const rows = result.value.data.rows || [];
  console.log(gray(`  ${'Path'.padEnd(42)} ${'Views'.padStart(8)}  Avg Time`));
  rows.forEach(r => {
    const pg = r.dimensionValues[0].value;
    const views = parseInt(r.metricValues[0].value, 10);
    const avgDurSec = Math.round(parseFloat(r.metricValues[1].value));
    const label = pg.length > 42 ? pg.slice(0, 39) + '...' : pg;
    console.log(`  ${label.padEnd(42)} ${num(views).padStart(8)}  ${dur(avgDurSec)}`);
  });
}

function renderGscOverview(result) {
  section('🔍 Search Console');
  if (!result || result.status !== 'fulfilled' || !result.value) {
    console.log(gray('  No GSC data')); return;
  }
  const rows = result.value.data.rows || [];
  if (!rows.length) { console.log(gray('  No data for this period')); return; }

  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const ctr = impressions ? clicks / impressions : 0;
  const totalImpr = rows.reduce((s, r) => s + r.impressions, 0);
  const position = totalImpr
    ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / totalImpr
    : 0;

  [
    ['Clicks',       num(clicks)],
    ['Impressions',  num(impressions)],
    ['CTR',          (ctr * 100).toFixed(2) + '%'],
    ['Avg Position', position.toFixed(1)],
  ].forEach(([label, val]) => {
    console.log(`  ${label.padEnd(22)} ${bold(val.padStart(10))}`);
  });
}

function renderGscQueries(result) {
  section('🔎 Top Search Queries');
  if (!result || result.status !== 'fulfilled' || !result.value) {
    console.log(gray('  No GSC data')); return;
  }
  const rows = result.value.data.rows || [];
  console.log(gray(`  ${'Query'.padEnd(38)} ${'Impr'.padStart(7)}  ${'Clicks'.padStart(7)}  ${'CTR'.padStart(6)}  Pos`));
  rows.forEach(r => {
    const q = r.keys[0];
    const label = q.length > 38 ? q.slice(0, 35) + '...' : q;
    console.log(
      `  ${label.padEnd(38)} ${num(r.impressions).padStart(7)}  ${num(r.clicks).padStart(7)}` +
      `  ${((r.ctr || 0) * 100).toFixed(1).padStart(5)}%  ${(r.position || 0).toFixed(1)}`
    );
  });
}

function renderGscPages(result) {
  section('📑 Top GSC Pages');
  if (!result || result.status !== 'fulfilled' || !result.value) {
    console.log(gray('  No GSC data')); return;
  }
  const rows = result.value.data.rows || [];
  console.log(gray(`  ${'Page'.padEnd(52)} ${'Impr'.padStart(7)}  Clicks`));
  rows.forEach(r => {
    const pg = r.keys[0];
    const label = pg.length > 52 ? pg.slice(0, 49) + '...' : pg;
    console.log(`  ${label.padEnd(52)} ${num(r.impressions).padStart(7)}  ${num(r.clicks)}`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (args.includes('--reauth')) {
    fs.rmSync(TOKEN_FILE, { force: true });
    console.log(dim('Cleared saved tokens — re-authenticating...\n'));
  }

  const auth = await getAuthClient();

  let config = loadConfig() || {};
  if (!config.propertyId || !config.siteUrl || args.includes('--reconfigure')) {
    config = await selectConfig(auth);
  }

  const { propertyId, siteUrl } = config;
  console.log(dim(`\nFetching ${DAYS}-day report for property ${propertyId}${siteUrl ? ` · ${siteUrl}` : ''}...`));

  const [realtime, overview, channels, pages, trend, gscOverview, gscQueries, gscPages] =
    await fetchAll(auth, propertyId, siteUrl, DAYS);

  header(DAYS);
  renderRealtime(realtime);
  renderOverview(overview);
  renderChannels(channels);
  renderTrend(trend);
  renderPages(pages);
  renderGscOverview(gscOverview);
  renderGscQueries(gscQueries);
  renderGscPages(gscPages);

  console.log('\n' + gray('─'.repeat(62)) + '\n');
}

main().catch(err => {
  console.error(red('\nError: ') + err.message);
  if (err.message.includes('invalid_grant') || err.message.includes('Token has been expired')) {
    console.error(dim('  Run with --reconfigure to re-authenticate, or delete ~/.analytics-cli.json'));
  }
  process.exit(1);
});
