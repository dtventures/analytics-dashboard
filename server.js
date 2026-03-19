const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── OAuth client ───────────────────────────────────────────────────────────

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
}

const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

// ─── Middleware ──────────────────────────────────────────────────────────────

app.set('trust proxy', 1); // trust Railway's load balancer


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Article routes before express.static so they're matched first
app.get('/articles/:slug', (req, res) => {
  const slug = req.params.slug.replace(/[^a-z0-9-]/g, '');
  res.sendFile(path.join(__dirname, 'public', 'articles', slug + '.html'), (err) => {
    if (err) res.status(404).send('Article not found');
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ─── Auth helpers ────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function getAuthClient(req) {
  const client = createOAuthClient();
  client.setCredentials(req.session.tokens);

  // Auto-refresh: merge new tokens back into session
  client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      req.session.tokens = { ...req.session.tokens, ...tokens };
    } else {
      req.session.tokens.access_token = tokens.access_token;
      req.session.tokens.expiry_date = tokens.expiry_date;
    }
  });

  return client;
}

// ─── Auth routes ─────────────────────────────────────────────────────────────

app.get('/auth/login', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send(`
      <h2>Missing .env configuration</h2>
      <p>Copy <code>.env.example</code> to <code>.env</code> and fill in your Google OAuth credentials.</p>
      <p>See the <a href="/">setup guide</a> on the dashboard.</p>
    `);
  }
  const client = createOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=' + encodeURIComponent(error));

  try {
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user info
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: user } = await oauth2.userinfo.get();

    req.session.tokens = tokens;
    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
    };

    res.redirect('/app?signed_in=1');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  if (!req.session.tokens) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    user: req.session.user || null,
    selectedProperty: req.session.selectedProperty || null,
    selectedSite: req.session.selectedSite || null,
  });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { propertyId, siteUrl } = req.body;
  if (propertyId) req.session.selectedProperty = propertyId;
  if (siteUrl) req.session.selectedSite = siteUrl;
  res.json({ ok: true });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── Page routes ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/app', (req, res) => {
  if (!req.session.tokens) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});


// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ─── Property discovery ──────────────────────────────────────────────────────

app.get('/api/properties', requireAuth, async (req, res) => {
  const auth = getAuthClient(req);
  try {
    const [analyticsRes, gscRes] = await Promise.allSettled([
      google.analyticsadmin({ version: 'v1beta', auth }).accounts.list(),
      google.webmasters({ version: 'v3', auth }).sites.list(),
    ]);

    // GA4 — use accountSummaries for a flat list of properties
    let properties = [];
    try {
      const { data } = await google.analyticsadmin({ version: 'v1beta', auth }).accountSummaries.list();
      for (const account of data.accountSummaries || []) {
        for (const prop of account.propertySummaries || []) {
          properties.push({
            id: prop.property.replace('properties/', ''),
            name: prop.displayName,
            account: account.displayName,
          });
        }
      }
    } catch (e) {
      console.error('GA4 properties error:', e.message);
    }

    // GSC sites
    let sites = [];
    if (gscRes.status === 'fulfilled') {
      sites = (gscRes.value.data.siteEntry || []).map(s => ({
        url: s.siteUrl,
        permissionLevel: s.permissionLevel,
      }));
    } else {
      console.error('GSC sites error:', gscRes.reason?.message);
    }

    res.json({ properties, sites });
  } catch (err) {
    console.error('Properties error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GA4 helpers ─────────────────────────────────────────────────────────────

function ga4Client(auth) {
  return google.analyticsdata({ version: 'v1beta', auth });
}

function dateRange(daysAgo, daysEnd = 0) {
  return {
    startDate: `${daysAgo}daysAgo`,
    endDate: daysEnd === 0 ? 'today' : `${daysEnd}daysAgo`,
  };
}

// ─── GA4: Realtime ────────────────────────────────────────────────────────────

app.get('/api/ga4/realtime', requireAuth, async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const auth = getAuthClient(req);
  const ga4 = ga4Client(auth);
  const property = `properties/${propertyId}`;

  try {
    const [bySource, byPage] = await Promise.all([
      ga4.properties.runRealtimeReport({
        property,
        requestBody: {
          dimensions: [{ name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'activeUsers' }],
        },
      }),
      ga4.properties.runRealtimeReport({
        property,
        requestBody: {
          dimensions: [{ name: 'unifiedScreenName' }],
          metrics: [{ name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
          limit: 5,
        },
      }),
    ]);

    const sources = (bySource.data.rows || []).map(r => ({
      source: r.dimensionValues[0].value,
      users: parseInt(r.metricValues[0].value, 10),
    }));

    const pages = (byPage.data.rows || []).map(r => ({
      page: r.dimensionValues[0].value,
      users: parseInt(r.metricValues[0].value, 10),
    }));

    const totalUsers = sources.reduce((s, r) => s + r.users, 0);

    res.json({ totalUsers, sources, topPage: pages[0]?.page || '—', pages });
  } catch (err) {
    console.error('Realtime error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GA4: Overview ────────────────────────────────────────────────────────────

app.get('/api/ga4/overview', requireAuth, async (req, res) => {
  const { propertyId, days = 30 } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const auth = getAuthClient(req);
  const ga4 = ga4Client(auth);
  const property = `properties/${propertyId}`;
  const d = parseInt(days, 10);

  try {
    const { data } = await ga4.properties.runReport({
      property,
      requestBody: {
        dateRanges: [
          dateRange(d),
          dateRange(d * 2, d + 1), // previous period
        ],
        metrics: [
          { name: 'totalUsers' },
          { name: 'sessions' },
          { name: 'conversions' },
          { name: 'engagementRate' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
        ],
      },
    });

    function extract(rows, rangeIndex) {
      const row = (rows || []).find(r => r.dimensionValues?.[0]?.value === `date_range_${rangeIndex}`)
        || rows?.[rangeIndex];
      if (!row) return null;
      return {
        users: parseInt(row.metricValues[0].value, 10),
        sessions: parseInt(row.metricValues[1].value, 10),
        conversions: parseInt(row.metricValues[2].value, 10),
        engagementRate: parseFloat(row.metricValues[3].value),
        bounceRate: parseFloat(row.metricValues[4].value),
        avgDuration: parseFloat(row.metricValues[5].value),
      };
    }

    // runReport with 2 dateRanges returns rows with dateRange dimension
    const rows = data.rows || [];
    const curr = {
      users: 0, sessions: 0, conversions: 0,
      engagementRate: 0, bounceRate: 0, avgDuration: 0,
    };
    const prev = { ...curr };

    for (const row of rows) {
      const rangeIdx = row.dimensionValues?.[0]?.value; // 'date_range_0' or 'date_range_1'
      const target = rangeIdx === 'date_range_1' ? prev : curr;
      target.users += parseInt(row.metricValues[0].value, 10);
      target.sessions += parseInt(row.metricValues[1].value, 10);
      target.conversions += parseInt(row.metricValues[2].value, 10);
      target.engagementRate += parseFloat(row.metricValues[3].value);
      target.bounceRate += parseFloat(row.metricValues[4].value);
      target.avgDuration += parseFloat(row.metricValues[5].value);
    }

    function pctChange(curr, prev) {
      if (!prev) return null;
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    }

    res.json({
      current: curr,
      previous: prev,
      changes: {
        users: pctChange(curr.users, prev.users),
        sessions: pctChange(curr.sessions, prev.sessions),
        conversions: pctChange(curr.conversions, prev.conversions),
        engagementRate: pctChange(curr.engagementRate, prev.engagementRate),
        bounceRate: pctChange(curr.bounceRate, prev.bounceRate),
        avgDuration: pctChange(curr.avgDuration, prev.avgDuration),
      },
    });
  } catch (err) {
    console.error('Overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GA4: Channels ───────────────────────────────────────────────────────────

app.get('/api/ga4/channels', requireAuth, async (req, res) => {
  const { propertyId, days = 30 } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const auth = getAuthClient(req);
  const ga4 = ga4Client(auth);

  try {
    const { data } = await ga4.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [dateRange(parseInt(days, 10))],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'conversions' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      },
    });

    const rows = (data.rows || []).map(r => ({
      channel: r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value, 10),
      users: parseInt(r.metricValues[1].value, 10),
      conversions: parseInt(r.metricValues[2].value, 10),
    }));

    const total = rows.reduce((s, r) => s + r.sessions, 0);
    const result = rows.map(r => ({ ...r, pct: total ? Math.round((r.sessions / total) * 100) : 0 }));

    res.json({ channels: result, total });
  } catch (err) {
    console.error('Channels error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GA4: Pages ──────────────────────────────────────────────────────────────

app.get('/api/ga4/pages', requireAuth, async (req, res) => {
  const { propertyId, days = 30 } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const auth = getAuthClient(req);
  const ga4 = ga4Client(auth);

  try {
    const { data } = await ga4.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [dateRange(parseInt(days, 10))],
        dimensions: [{ name: 'pagePath' }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'userEngagementDuration' },
          { name: 'bounceRate' },
        ],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 20,
      },
    });

    const pages = (data.rows || []).map(r => ({
      path: r.dimensionValues[0].value,
      views: parseInt(r.metricValues[0].value, 10),
      avgDuration: Math.round(parseFloat(r.metricValues[1].value)),
      bounceRate: Math.round(parseFloat(r.metricValues[2].value) * 100),
    }));

    res.json({ pages });
  } catch (err) {
    console.error('Pages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GA4: Audience ───────────────────────────────────────────────────────────

app.get('/api/ga4/audience', requireAuth, async (req, res) => {
  const { propertyId, days = 30 } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const auth = getAuthClient(req);
  const ga4 = ga4Client(auth);
  const property = `properties/${propertyId}`;
  const d = parseInt(days, 10);
  const dateRanges = [dateRange(d)];

  try {
    const [countriesRes, devicesRes, newVsRetRes, agesRes] = await Promise.allSettled([
      ga4.properties.runReport({
        property,
        requestBody: {
          dateRanges,
          dimensions: [{ name: 'country' }],
          metrics: [{ name: 'totalUsers' }],
          orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
          limit: 10,
        },
      }),
      ga4.properties.runReport({
        property,
        requestBody: {
          dateRanges,
          dimensions: [{ name: 'deviceCategory' }],
          metrics: [
            { name: 'totalUsers' },
            { name: 'sessions' },
            { name: 'conversions' },
          ],
        },
      }),
      ga4.properties.runReport({
        property,
        requestBody: {
          dateRanges,
          dimensions: [{ name: 'newVsReturning' }],
          metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
        },
      }),
      ga4.properties.runReport({
        property,
        requestBody: {
          dateRanges,
          dimensions: [{ name: 'userAgeBracket' }],
          metrics: [{ name: 'totalUsers' }],
          orderBys: [{ dimension: { dimensionName: 'userAgeBracket' } }],
        },
      }),
    ]);

    function safeRows(result) {
      return result.status === 'fulfilled' ? (result.value.data.rows || []) : [];
    }

    const countries = safeRows(countriesRes).map(r => ({
      country: r.dimensionValues[0].value,
      users: parseInt(r.metricValues[0].value, 10),
    }));

    const devices = safeRows(devicesRes).map(r => ({
      device: r.dimensionValues[0].value,
      users: parseInt(r.metricValues[0].value, 10),
      sessions: parseInt(r.metricValues[1].value, 10),
      conversions: parseInt(r.metricValues[2].value, 10),
    }));

    const newVsReturning = safeRows(newVsRetRes).map(r => ({
      type: r.dimensionValues[0].value,
      users: parseInt(r.metricValues[0].value, 10),
      sessions: parseInt(r.metricValues[1].value, 10),
    }));

    const ages = safeRows(agesRes).map(r => ({
      bracket: r.dimensionValues[0].value,
      users: parseInt(r.metricValues[0].value, 10),
    }));

    res.json({ countries, devices, newVsReturning, ages });
  } catch (err) {
    console.error('Audience error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GA4: Trend ──────────────────────────────────────────────────────────────

app.get('/api/ga4/trend', requireAuth, async (req, res) => {
  const { propertyId, days = 30 } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const auth = getAuthClient(req);
  const ga4 = ga4Client(auth);

  try {
    const { data } = await ga4.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [dateRange(parseInt(days, 10))],
        dimensions: [{ name: 'date' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
        ],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      },
    });

    const points = (data.rows || []).map(r => ({
      date: r.dimensionValues[0].value, // YYYYMMDD
      sessions: parseInt(r.metricValues[0].value, 10),
      users: parseInt(r.metricValues[1].value, 10),
    }));

    res.json({ points });
  } catch (err) {
    console.error('Trend error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GA4: Events ─────────────────────────────────────────────────────────────

app.get('/api/ga4/events', requireAuth, async (req, res) => {
  const { propertyId, days = 30 } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const auth = getAuthClient(req);
  const ga4 = ga4Client(auth);

  try {
    const { data } = await ga4.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [dateRange(parseInt(days, 10))],
        dimensions: [{ name: 'eventName' }],
        metrics: [
          { name: 'eventCount' },
          { name: 'conversions' },
        ],
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit: 20,
      },
    });

    const events = (data.rows || []).map(r => ({
      name: r.dimensionValues[0].value,
      count: parseInt(r.metricValues[0].value, 10),
      conversions: parseInt(r.metricValues[1].value, 10),
    }));

    res.json({ events });
  } catch (err) {
    console.error('Events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GA4: Referrers ──────────────────────────────────────────────────────────

app.get('/api/ga4/referrers', requireAuth, async (req, res) => {
  const { propertyId, days = 30 } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const auth = getAuthClient(req);
  const ga4 = ga4Client(auth);

  try {
    const { data } = await ga4.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [dateRange(parseInt(days, 10))],
        dimensions: [{ name: 'sessionSource' }],
        metrics: [
          { name: 'sessions' },
          { name: 'conversions' },
        ],
        dimensionFilter: {
          filter: {
            fieldName: 'sessionMedium',
            stringFilter: { matchType: 'EXACT', value: 'referral' },
          },
        },
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 20,
      },
    });

    const referrers = (data.rows || []).map(r => {
      const sessions = parseInt(r.metricValues[0].value, 10);
      const conversions = parseInt(r.metricValues[1].value, 10);
      return {
        domain: r.dimensionValues[0].value,
        sessions,
        conversions,
        rate: sessions ? Math.round((conversions / sessions) * 1000) / 10 : 0,
      };
    });

    res.json({ referrers });
  } catch (err) {
    console.error('Referrers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GSC helpers ─────────────────────────────────────────────────────────────

function gscDateRange(days) {
  const end = new Date();
  // GSC data has ~3 day lag; shift back slightly
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
  };
}

async function gscQuery(auth, siteUrl, body) {
  const sc = google.webmasters({ version: 'v3', auth });
  const { data } = await sc.searchanalytics.query({
    siteUrl,
    requestBody: body,
  });
  return data;
}

// ─── GSC: Overview ───────────────────────────────────────────────────────────

app.get('/api/gsc/overview', requireAuth, async (req, res) => {
  const { siteUrl, days = 30 } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl required' });

  const auth = getAuthClient(req);
  const range = gscDateRange(parseInt(days, 10));

  try {
    const [totals, byDevice, byDate] = await Promise.all([
      gscQuery(auth, siteUrl, { ...range, rowLimit: 1 }),
      gscQuery(auth, siteUrl, { ...range, dimensions: ['device'], rowLimit: 10 }),
      gscQuery(auth, siteUrl, { ...range, dimensions: ['date'], rowLimit: 90 }),
    ]);

    // totals — GSC returns aggregate in totals field when no dimensions
    const t = {
      clicks: totals.rows?.[0]?.clicks ?? 0,
      impressions: totals.rows?.[0]?.impressions ?? 0,
      ctr: totals.rows?.[0]?.ctr ?? 0,
      position: totals.rows?.[0]?.position ?? 0,
    };

    // Recalculate totals by summing byDate rows (more accurate)
    if (byDate.rows?.length) {
      t.clicks = byDate.rows.reduce((s, r) => s + r.clicks, 0);
      t.impressions = byDate.rows.reduce((s, r) => s + r.impressions, 0);
      t.ctr = t.impressions ? t.clicks / t.impressions : 0;
      const totalImpr = byDate.rows.reduce((s, r) => s + r.impressions, 0);
      t.position = totalImpr
        ? byDate.rows.reduce((s, r) => s + r.position * r.impressions, 0) / totalImpr
        : 0;
    }

    const devices = (byDevice.rows || []).map(r => ({
      device: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Math.round(r.ctr * 10000) / 100,
      position: Math.round(r.position * 10) / 10,
    }));

    const dates = (byDate.rows || []).map(r => ({
      date: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Math.round(r.ctr * 10000) / 100,
      position: Math.round(r.position * 10) / 10,
    }));

    res.json({
      totals: {
        clicks: Math.round(t.clicks),
        impressions: Math.round(t.impressions),
        ctr: Math.round(t.ctr * 10000) / 100,
        position: Math.round(t.position * 10) / 10,
      },
      devices,
      dates,
    });
  } catch (err) {
    console.error('GSC overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GSC: Queries ────────────────────────────────────────────────────────────

app.get('/api/gsc/queries', requireAuth, async (req, res) => {
  const { siteUrl, days = 30 } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl required' });

  const auth = getAuthClient(req);
  const range = gscDateRange(parseInt(days, 10));

  try {
    const data = await gscQuery(auth, siteUrl, {
      ...range,
      dimensions: ['query'],
      rowLimit: 25,
      orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
    });

    const queries = (data.rows || []).map(r => ({
      query: r.keys[0],
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: Math.round(r.ctr * 10000) / 100,
      position: Math.round(r.position * 10) / 10,
    }));

    res.json({ queries });
  } catch (err) {
    console.error('GSC queries error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GSC: Pages ──────────────────────────────────────────────────────────────

app.get('/api/gsc/pages', requireAuth, async (req, res) => {
  const { siteUrl, days = 30 } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl required' });

  const auth = getAuthClient(req);
  const range = gscDateRange(parseInt(days, 10));

  try {
    const data = await gscQuery(auth, siteUrl, {
      ...range,
      dimensions: ['page'],
      rowLimit: 20,
      orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
    });

    const pages = (data.rows || []).map(r => ({
      page: r.keys[0],
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: Math.round(r.ctr * 10000) / 100,
      position: Math.round(r.position * 10) / 10,
    }));

    res.json({ pages });
  } catch (err) {
    console.error('GSC pages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GSC: Sitemaps ───────────────────────────────────────────────────────────

app.get('/api/gsc/sitemaps', requireAuth, async (req, res) => {
  const { siteUrl } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl required' });

  const auth = getAuthClient(req);
  const sc = google.webmasters({ version: 'v3', auth });

  try {
    const { data } = await sc.sitemaps.list({ siteUrl });
    const sitemaps = (data.sitemap || []).map(s => ({
      path: s.path,
      lastSubmitted: s.lastSubmitted,
      lastDownloaded: s.lastDownloaded,
      warnings: s.warnings || 0,
      errors: s.errors || 0,
      submitted: (s.contents || []).reduce((sum, c) => sum + (parseInt(c.submitted, 10) || 0), 0),
      indexed: (s.contents || []).reduce((sum, c) => sum + (parseInt(c.indexed, 10) || 0), 0),
    }));
    res.json({ sitemaps });
  } catch (err) {
    console.error('Sitemaps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GSC: URL Inspection ─────────────────────────────────────────────────────

app.get('/api/gsc/inspect', requireAuth, async (req, res) => {
  const { siteUrl, inspectionUrl } = req.query;
  if (!siteUrl || !inspectionUrl) return res.status(400).json({ error: 'siteUrl and inspectionUrl required' });

  const auth = getAuthClient(req);
  const sc = google.searchconsole({ version: 'v1', auth });

  try {
    const { data } = await sc.urlInspection.index.inspect({
      requestBody: { inspectionUrl, siteUrl },
    });
    const r = data.inspectionResult?.indexStatusResult || {};
    res.json({
      verdict: r.verdict,
      coverageState: r.coverageState,
      robotsTxtState: r.robotsTxtState,
      indexingState: r.indexingState,
      lastCrawlTime: r.lastCrawlTime,
      pageFetchState: r.pageFetchState,
      googleCanonical: r.googleCanonical,
      sitemap: r.sitemap || [],
    });
  } catch (err) {
    console.error('Inspect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GA4: Landing Pages ──────────────────────────────────────────────────────

app.get('/api/ga4/landing-pages', requireAuth, async (req, res) => {
  const { propertyId, days = 30 } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  const auth = getAuthClient(req);
  const ga4 = ga4Client(auth);

  try {
    const { data } = await ga4.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [dateRange(parseInt(days, 10))],
        dimensions: [{ name: 'landingPage' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'bounceRate' },
          { name: 'conversions' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 15,
      },
    });
    const pages = (data.rows || []).map(r => ({
      path: r.dimensionValues[0].value,
      sessions: parseInt(r.metricValues[0].value, 10),
      users: parseInt(r.metricValues[1].value, 10),
      bounceRate: Math.round(parseFloat(r.metricValues[2].value) * 100),
      conversions: parseInt(r.metricValues[3].value, 10),
    }));
    res.json({ pages });
  } catch (err) {
    console.error('Landing pages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PageSpeed ───────────────────────────────────────────────────────────────

app.get('/api/pagespeed', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile`;
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`PageSpeed API returned ${response.status}`);
    const json = await response.json();

    const cats = json.lighthouseResult?.categories;
    const audits = json.lighthouseResult?.audits;

    res.json({
      score: Math.round((cats?.performance?.score || 0) * 100),
      lcp: audits?.['largest-contentful-paint']?.displayValue || '—',
      cls: audits?.['cumulative-layout-shift']?.displayValue || '—',
      fcp: audits?.['first-contentful-paint']?.displayValue || '—',
      ttfb: audits?.['server-response-time']?.displayValue || '—',
      tbt: audits?.['total-blocking-time']?.displayValue || '—',
      lcpRating: audits?.['largest-contentful-paint']?.score >= 0.9 ? 'ok' : audits?.['largest-contentful-paint']?.score >= 0.5 ? 'wn' : 'er',
      clsRating: audits?.['cumulative-layout-shift']?.score >= 0.9 ? 'ok' : audits?.['cumulative-layout-shift']?.score >= 0.5 ? 'wn' : 'er',
      fcpRating: audits?.['first-contentful-paint']?.score >= 0.9 ? 'ok' : audits?.['first-contentful-paint']?.score >= 0.5 ? 'wn' : 'er',
      ttfbRating: audits?.['server-response-time']?.score >= 0.9 ? 'ok' : audits?.['server-response-time']?.score >= 0.5 ? 'wn' : 'er',
    });
  } catch (err) {
    console.error('PageSpeed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅ Analytics Dashboard running at http://localhost:${PORT}\n`);
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.log('⚠️  No .env file found — copy .env.example to .env and add your credentials.\n');
  }
});
