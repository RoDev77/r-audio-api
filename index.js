const express = require('express');
const cors    = require('cors');
const ytDlp   = require('yt-dlp-exec');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const COOKIES_PATH = process.env.COOKIES_PATH || path.join(__dirname, 'cookies.txt');

function writeCookies() {
  if (process.env.COOKIES_BASE64) {
    const tmpPath = '/tmp/yt_cookies.txt';
    const decoded = Buffer.from(process.env.COOKIES_BASE64, 'base64').toString('utf8');
    fs.writeFileSync(tmpPath, decoded);
    return tmpPath;
  }
  if (fs.existsSync(COOKIES_PATH)) return COOKIES_PATH;
  return null;
}

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('tiktok.com')) return 'tiktok';
  return 'unknown';
}

// ── POST /api/extract ─────────────────────────────────────────────────────────
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL kosong!' });

  const platform    = detectPlatform(url);
  const cookiesFile = writeCookies();
  console.log(`[extract] platform=${platform} cookies=${!!cookiesFile}`);

  const base = {
    dumpJson:           true,
    noWarnings:         true,
    noCallHome:         true,
    noCheckCertificate: true,
    preferFreeFormats:  true,
    ...(cookiesFile ? { cookies: cookiesFile } : {}),
  };

  if (platform === 'tiktok') {
    try {
      const out = await ytDlp(url, {
        ...base,
        format: 'bestaudio/best',
        addHeader: [
          'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
          'Referer:https://www.tiktok.com/',
        ],
      });
      if (!out?.url) throw new Error('Tidak ada URL');
      const title = (out.title || 'TikTok_Audio').replace(/[^\w\s-]/g,'').replace(/\s+/g,'_').substring(0,80);
      return res.json({ success: true, title, streamUrl: out.url, duration: out.duration||null, ext: out.ext||'mp3' });
    } catch (e) {
      return res.status(500).json({ error: 'Gagal ekstrak TikTok.', detail: e.message.substring(0,300) });
    }
  }

  // YouTube — 4 strategy fallback
  const strategies = [
    'youtube:player_client=tv_embedded',
    'youtube:player_client=mweb',
    'youtube:player_client=android',
    'youtube:player_client=web',
  ];

  let lastErr = null;
  for (const strategy of strategies) {
    try {
      console.log(`[extract] Trying ${strategy}`);
      const out = await ytDlp(url, {
        ...base,
        format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        extractorArgs: strategy,
        youtubeSkipDashManifest: true,
        addHeader: [
          'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
          'Accept-Language:en-US,en;q=0.9',
          'Referer:https://www.youtube.com/',
        ],
      });
      if (!out?.url) throw new Error('Tidak ada URL di output');
      const title = (out.title||'Sonara_Audio').replace(/[^\w\s-]/g,'').replace(/\s+/g,'_').substring(0,80);
      console.log(`[extract] ✅ "${title}" via ${strategy}`);
      return res.json({ success: true, title, streamUrl: out.url, duration: out.duration||null, ext: out.ext||'mp3' });
    } catch (err) {
      lastErr = err;
      const m = err.message || '';
      console.warn(`[extract] ❌ ${strategy}: ${m.substring(0,120)}`);
      if (m.includes('private') || m.includes('removed') || m.includes('unavailable') || m.includes('copyright')) break;
    }
  }

  const msg = lastErr?.message || '';
  let userMsg = 'Gagal mengekstrak. Coba video lain.';
  if (msg.includes('private'))                                             userMsg = 'Video diprivate.';
  else if (msg.includes('unavailable') || msg.includes('removed'))        userMsg = 'Video tidak tersedia atau dihapus.';
  else if (msg.includes('copyright') || msg.includes('not available'))    userMsg = 'Video diblokir hak cipta di wilayah server.';
  else if (msg.includes('Sign in') || msg.includes('bot') || msg.includes('age')) userMsg = 'YouTube memblokir server. Perbarui cookies atau coba video lain.';

  res.status(500).json({ error: userMsg, detail: msg.substring(0,400) });
});

// ── GET /api/debug ────────────────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  const cookiesFile = writeCookies();
  const info = {
    node: process.version,
    cookies: {
      hasBase64: !!process.env.COOKIES_BASE64,
      hasFile:   fs.existsSync(COOKIES_PATH),
      loaded:    !!cookiesFile,
    },
  };

  if (cookiesFile) {
    try {
      const content = fs.readFileSync(cookiesFile, 'utf8');
      const lines   = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      const domains = [...new Set(lines.map(l => l.split('\t')[0]).filter(Boolean))];
      info.cookies.entries        = lines.length;
      info.cookies.domains        = domains;
      info.cookies.hasYT          = domains.some(d => d.includes('youtube') || d.includes('google'));
      info.cookies.hasLoginToken  = content.includes('LOGIN_INFO') || content.includes('SSID') || content.includes('SID');
      info.cookies.byteLength     = content.length;
    } catch (e) {
      info.cookies.readError = e.message;
    }
  }

  // Live test (opsional, tambah ?test=1)
  if (req.query.test === '1' && cookiesFile) {
    try {
      const out = await ytDlp('https://www.youtube.com/watch?v=BaW_jenozKc', {
        dumpJson: true, noWarnings: true, noCallHome: true,
        format: 'bestaudio',
        extractorArgs: 'youtube:player_client=tv_embedded',
        cookies: cookiesFile,
      });
      info.liveTest = { ok: true, title: out.title };
    } catch (e) {
      info.liveTest = { ok: false, error: e.message.substring(0,300) };
    }
  }

  res.json(info);
});

// ── GET /proxy ────────────────────────────────────────────────────────────────
app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing URL');

  const reqHeaders = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    'Accept':          'audio/*, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         'https://www.youtube.com/',
  };
  if (req.headers.range) reqHeaders['Range'] = req.headers.range;

  const lib      = targetUrl.startsWith('https') ? https : http;
  const upstream = lib.get(targetUrl, { headers: reqHeaders }, (upRes) => {
    const pass = ['content-type','content-length','content-range','accept-ranges','cache-control'];
    const outH = { 'Access-Control-Allow-Origin': '*' };
    pass.forEach(h => { if (upRes.headers[h]) outH[h] = upRes.headers[h]; });
    res.writeHead(upRes.statusCode, outH);
    upRes.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.status(502).send('Proxy error'); });
  req.on('close', () => upstream.destroy());
});

app.get('/', (_, res) => res.json({ status: 'ok', service: 'Sonara Studio API' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Sonara API di port ${PORT}`));