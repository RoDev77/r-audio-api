const express = require('express');
const cors    = require('cors');
const ytDlp   = require('yt-dlp-exec');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');

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
  console.log(`[extract] platform=${platform} cookies=${cookiesFile}`);

  // Opsi dasar
  const base = {
    dumpJson:           true,
    noWarnings:         true,
    noCallHome:         true,
    noCheckCertificate: true,
    preferFreeFormats:  true,
    ...(cookiesFile ? { cookies: cookiesFile } : {}),
  };

  // Untuk YouTube coba beberapa kombinasi client + format
  // tv_embedded = tidak perlu login untuk video publik
  // mweb       = mobile web, juga sering lolos
  const ytStrategies = [
    { extractorArgs: 'youtube:player_client=tv_embedded', format: 'bestaudio[ext=m4a]/bestaudio' },
    { extractorArgs: 'youtube:player_client=mweb',        format: 'bestaudio[ext=m4a]/bestaudio' },
    { extractorArgs: 'youtube:player_client=android',     format: 'bestaudio[ext=m4a]/bestaudio' },
    { extractorArgs: 'youtube:player_client=web',         format: 'bestaudio' },
  ];

  const tiktokOpts = {
    ...base,
    format: 'bestaudio/best',
    addHeader: [
      'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Referer:https://www.tiktok.com/',
    ],
  };

  if (platform === 'tiktok') {
    try {
      const out = await ytDlp(url, tiktokOpts);
      if (!out?.url) throw new Error('Tidak ada URL');
      const title = (out.title || 'TikTok_Audio').replace(/[^\w\s-]/g,'').replace(/\s+/g,'_').substring(0,80);
      return res.json({ success: true, title, streamUrl: out.url, duration: out.duration || null, ext: out.ext || 'mp3' });
    } catch (e) {
      return res.status(500).json({ error: 'Gagal ekstrak TikTok: ' + e.message.substring(0,200) });
    }
  }

  // YouTube — coba semua strategy
  let lastErr = null;
  for (const strategy of ytStrategies) {
    const opts = {
      ...base,
      ...strategy,
      addHeader: [
        'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language:en-US,en;q=0.9',
        'Referer:https://www.youtube.com/',
      ],
      youtubeSkipDashManifest: true,
    };

    try {
      console.log(`[extract] Trying ${strategy.extractorArgs}`);
      const out = await ytDlp(url, opts);
      if (!out?.url) throw new Error('Tidak ada URL di output');

      const title = (out.title || 'Sonara_Audio').replace(/[^\w\s-]/g,'').replace(/\s+/g,'_').substring(0,80);
      console.log(`[extract] ✅ "${title}" via ${strategy.extractorArgs}`);
      return res.json({ success: true, title, streamUrl: out.url, duration: out.duration || null, ext: out.ext || 'mp3' });

    } catch (err) {
      lastErr = err;
      const m = err.message || '';
      console.warn(`[extract] ❌ ${strategy.extractorArgs}: ${m.substring(0,120)}`);
      // Error non-recoverable — tidak perlu coba strategy lain
      if (m.includes('private') || m.includes('removed') || m.includes('unavailable') || m.includes('copyright'))
        break;
    }
  }

  // Semua gagal — kembalikan error terbaik
  const msg = lastErr?.message || '';
  let userMsg;
  if (msg.includes('private'))
    userMsg = 'Video diprivate.';
  else if (msg.includes('unavailable') || msg.includes('removed'))
    userMsg = 'Video tidak tersedia atau sudah dihapus.';
  else if (msg.includes('copyright') || msg.includes('not available'))
    userMsg = 'Video diblokir hak cipta atau tidak tersedia di wilayah server.';
  else if (msg.includes('Sign in') || msg.includes('login') || msg.includes('bot') || msg.includes('age'))
    userMsg = cookiesFile
      ? 'YouTube memblokir server ini. Coba video lain atau perbarui cookies.'
      : 'Video butuh login. Pasang COOKIES_BASE64 di Railway.';
  else
    userMsg = 'Gagal mengekstrak. Coba video lain.';

  res.status(500).json({ error: userMsg, detail: msg.substring(0,400) });
});

// ── GET /api/debug — info lengkap untuk troubleshooting ──────────────────────
app.get('/api/debug', async (req, res) => {
  const info = {
    node:     process.version,
    platform: process.platform,
    cookies: {
      hasBase64: !!process.env.COOKIES_BASE64,
      hasFile:   fs.existsSync(COOKIES_PATH),
    },
  };

  // Info versi yt-dlp
  try {
    info.ytdlpVersion = execSync('yt-dlp --version', { timeout: 5000 }).toString().trim();
  } catch (_) { info.ytdlpVersion = 'unknown'; }

  // Analisis cookies
  const cookiesFile = writeCookies();
  if (cookiesFile) {
    const content = fs.readFileSync(cookiesFile, 'utf8');
    const lines   = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const domains = [...new Set(lines.map(l => l.split('\t')[0]).filter(Boolean))];
    info.cookies.entries    = lines.length;
    info.cookies.domains    = domains;
    info.cookies.hasYT      = domains.some(d => d.includes('youtube') || d.includes('google'));
    info.cookies.byteLength = content.length;
    // Cek apakah ada cookie VISITOR_INFO atau LOGIN_INFO (tanda login)
    info.cookies.hasLoginToken = content.includes('LOGIN_INFO') || content.includes('SID') || content.includes('HSID');
    // Sample baris pertama non-sensitif
    info.cookies.firstDomains = lines.slice(0,5).map(l => l.split('\t')[0]);
  }

  // Test cepat yt-dlp tanpa download (video pendek publik)
  if (req.query.test === '1') {
    try {
      const testUrl = 'https://www.youtube.com/watch?v=BaW_jenozKc'; // video test YouTube
      const out = await ytDlp(testUrl, {
        dumpJson: true, noWarnings: true, noCallHome: true,
        format: 'bestaudio',
        extractorArgs: 'youtube:player_client=tv_embedded',
        ...(cookiesFile ? { cookies: cookiesFile } : {}),
      });
      info.ytdlpTest = { ok: true, title: out.title };
    } catch (e) {
      info.ytdlpTest = { ok: false, error: e.message.substring(0, 300) };
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