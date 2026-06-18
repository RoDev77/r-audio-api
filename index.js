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

function getCookiesOpt() {
  if (process.env.COOKIES_BASE64) {
    const tmpPath = '/tmp/yt_cookies.txt';
    const decoded = Buffer.from(process.env.COOKIES_BASE64, 'base64').toString('utf8');
    fs.writeFileSync(tmpPath, decoded);
    const lines = decoded.split('\n').filter(l => l && !l.startsWith('#'));
    console.log(`[cookies] COOKIES_BASE64: ${decoded.length} bytes, ${lines.length} entries`);
    // Log beberapa domain untuk verifikasi (jangan log value cookie)
    const domains = [...new Set(lines.map(l => l.split('\t')[0]).filter(Boolean))];
    console.log('[cookies] Domains:', domains.slice(0, 10));
    return { cookies: tmpPath };
  }
  if (fs.existsSync(COOKIES_PATH)) {
    console.log('[cookies] File:', COOKIES_PATH);
    return { cookies: COOKIES_PATH };
  }
  console.warn('[cookies] ⚠️  Tidak ada cookies');
  return {};
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

  const platform   = detectPlatform(url);
  const cookiesOpt = getCookiesOpt();
  const hasCookies = !!cookiesOpt.cookies;
  console.log(`[extract] platform=${platform} cookies=${hasCookies}`);

  const baseOpts = {
    dumpJson:           true,
    noWarnings:         true,
    noCallHome:         true,
    noCheckCertificate: true,
    preferFreeFormats:  true,
    ...cookiesOpt,
    addHeader: [
      'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept-Language:en-US,en;q=0.9',
    ],
  };

  // ── Strategi: coba 3 player client secara berurutan ──────────────────────
  // tv_embedded paling jarang kena bot-check, tidak butuh login untuk video publik
  const clientStrategies = platform === 'youtube'
    ? [
        'youtube:player_client=tv_embedded',   // ← tidak butuh login, paling bebas
        'youtube:player_client=android',
        'youtube:player_client=web',
      ]
    : [null]; // TikTok tidak pakai extractorArgs

  let lastError = null;

  for (const strategy of clientStrategies) {
    const opts = {
      ...baseOpts,
      ...(platform === 'youtube' ? {
        format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        addHeader: [...baseOpts.addHeader, 'Referer:https://www.youtube.com/'],
        youtubeSkipDashManifest: true,
        ...(strategy ? { extractorArgs: strategy } : {}),
      } : {
        format: 'bestaudio/best',
        addHeader: [...baseOpts.addHeader, 'Referer:https://www.tiktok.com/'],
      }),
    };

    try {
      console.log(`[extract] Mencoba strategy: ${strategy || 'default'}`);
      const output = await ytDlp(url, opts);
      if (!output?.url) throw new Error('Tidak ada URL di output');

      const safeTitle = (output.title || 'Sonara_Audio')
        .replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').substring(0, 80);

      console.log(`[extract] ✅ "${safeTitle}" via ${strategy || 'default'}`);
      return res.json({
        success: true, title: safeTitle,
        streamUrl: output.url, duration: output.duration || null, ext: output.ext || 'mp3',
      });
    } catch (err) {
      lastError = err;
      console.warn(`[extract] ❌ ${strategy}: ${err.message.substring(0, 150)}`);
      // Jika bukan masalah player client, jangan coba strategy lain
      if (!err.message.includes('Sign in') && !err.message.includes('bot') && !err.message.includes('age')) {
        break;
      }
    }
  }

  // Semua strategy gagal
  const msg = lastError?.message || '';
  console.error('[extract] Semua strategy gagal:', msg.substring(0, 300));

  let userMsg = 'Gagal mengekstrak audio. Coba video lain.';
  if (msg.includes('Sign in') || msg.includes('login') || msg.includes('age') || msg.includes('confirm your age'))
    userMsg = hasCookies
      ? 'Cookies kedaluwarsa — export ulang cookies.txt lalu update COOKIES_BASE64 di Railway.'
      : 'Video butuh login. Pasang COOKIES_BASE64 di Railway.';
  else if (msg.includes('copyright') || msg.includes('blocked') || msg.includes('not available'))
    userMsg = 'Video diblokir hak cipta atau tidak tersedia di wilayah server.';
  else if (msg.includes('private'))
    userMsg = 'Video diprivate.';
  else if (msg.includes('unavailable') || msg.includes('removed'))
    userMsg = 'Video tidak tersedia atau sudah dihapus.';

  res.status(500).json({ error: userMsg, detail: msg.substring(0, 500) });
});

// ── GET /api/debug-cookies — cek status cookies tanpa expose nilainya ─────────
app.get('/api/debug-cookies', (req, res) => {
  const result = { hasCookiesBase64: !!process.env.COOKIES_BASE64, hasCookiesFile: fs.existsSync(COOKIES_PATH) };
  if (process.env.COOKIES_BASE64) {
    const decoded = Buffer.from(process.env.COOKIES_BASE64, 'base64').toString('utf8');
    const lines   = decoded.split('\n').filter(l => l && !l.startsWith('#'));
    const domains = [...new Set(lines.map(l => l.split('\t')[0]).filter(Boolean))];
    result.cookieEntries = lines.length;
    result.domains       = domains;
    result.byteLength    = decoded.length;
    // Cek apakah ada .youtube.com cookie
    result.hasYoutubeCookie = domains.some(d => d.includes('youtube') || d.includes('google'));
  }
  res.json(result);
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
    const pass    = ['content-type','content-length','content-range','accept-ranges','cache-control'];
    const outH    = { 'Access-Control-Allow-Origin': '*' };
    pass.forEach(h => { if (upRes.headers[h]) outH[h] = upRes.headers[h]; });
    res.writeHead(upRes.statusCode, outH);
    upRes.pipe(res);
  });
  upstream.on('error', e => { if (!res.headersSent) res.status(502).send('Proxy error'); });
  req.on('close', () => upstream.destroy());
});

app.get('/', (_, res) => res.json({
  status: 'ok', service: 'Sonara Studio API',
  cookies: fs.existsSync(COOKIES_PATH) || !!process.env.COOKIES_BASE64,
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Sonara API di port ${PORT}`));