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

// ── Cookies setup ─────────────────────────────────────────────────────────────
// Cara pasang cookies (pilih salah satu):
//
// OPSI A — File (lokal/Railway volume):
//   1. Install ekstensi Chrome: "Get cookies.txt LOCALLY"
//   2. Buka youtube.com saat login, klik ekstensi → Export
//   3. Simpan sebagai cookies.txt di root project
//   4. Set env: COOKIES_PATH=/app/cookies.txt  (atau biarkan default)
//
// OPSI B — Base64 env variable (lebih aman, tidak perlu file):
//   1. Export cookies.txt seperti di atas
//   2. Encode: base64 -w 0 cookies.txt   (Linux/Mac)
//              [Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt"))  (Windows PS)
//   3. Set env di Railway: COOKIES_BASE64=<hasil encode>
//
const COOKIES_PATH = process.env.COOKIES_PATH || path.join(__dirname, 'cookies.txt');

function getCookiesOpt() {
  if (process.env.COOKIES_BASE64) {
    const tmpPath = '/tmp/yt_cookies.txt';
    // Tulis ulang hanya jika env berubah (cek ukuran)
    const encoded = process.env.COOKIES_BASE64;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    fs.writeFileSync(tmpPath, decoded);
    console.log('[cookies] Dimuat dari env COOKIES_BASE64 (' + decoded.length + ' bytes)');
    return { cookies: tmpPath };
  }
  if (fs.existsSync(COOKIES_PATH)) {
    console.log('[cookies] Dimuat dari file:', COOKIES_PATH);
    return { cookies: COOKIES_PATH };
  }
  console.warn('[cookies] ⚠️  Tidak ada cookies — video yang butuh login akan gagal.');
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

  const platform    = detectPlatform(url);
  const cookiesOpt  = getCookiesOpt();
  const hasCookies  = !!cookiesOpt.cookies;
  console.log(`[extract] platform=${platform} cookies=${hasCookies} url=${url}`);

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

  const platformOpts = platform === 'youtube'
    ? {
        format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        addHeader: [...baseOpts.addHeader, 'Referer:https://www.youtube.com/'],
        youtubeSkipDashManifest: true,
        // android client jarang kena bot-check, web sebagai fallback
        extractorArgs: 'youtube:player_client=android,web',
      }
    : {
        format: 'bestaudio/best',
        addHeader: [...baseOpts.addHeader, 'Referer:https://www.tiktok.com/'],
      };

  try {
    const output = await ytDlp(url, { ...baseOpts, ...platformOpts });

    if (!output?.url) throw new Error('yt-dlp tidak mengembalikan stream URL.');

    const safeTitle = (output.title || 'Sonara_Audio')
      .replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').substring(0, 80);

    console.log(`[extract] ✅ "${safeTitle}"`);
    res.json({ success: true, title: safeTitle, streamUrl: output.url, duration: output.duration || null, ext: output.ext || 'mp3' });

  } catch (err) {
    const msg = err.message || '';
    console.error('[extract] ❌', msg.substring(0, 300));

    let userMsg = 'Gagal mengekstrak audio. Coba video lain.';
    if (msg.includes('Sign in') || msg.includes('login') || msg.includes('age') || msg.includes('confirm your age'))
      userMsg = hasCookies
        ? 'Cookies sudah kedaluwarsa — perbarui cookies.txt di server lalu redeploy.'
        : 'Video ini butuh login YouTube. Pasang cookies.txt di server (lihat README).';
    else if (msg.includes('copyright') || msg.includes('blocked') || msg.includes('not available in your country'))
      userMsg = 'Video diblokir hak cipta atau tidak tersedia di wilayah server.';
    else if (msg.includes('private'))
      userMsg = 'Video diprivate — tidak dapat diakses.';
    else if (msg.includes('unavailable') || msg.includes('removed') || msg.includes('This video is no longer'))
      userMsg = 'Video tidak tersedia atau sudah dihapus.';
    else if (msg.includes('network') || msg.includes('timed out') || msg.includes('connect'))
      userMsg = 'Timeout koneksi ke YouTube. Coba lagi sebentar.';

    res.status(500).json({ error: userMsg, detail: msg.substring(0, 500) });
  }
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

  const lib = targetUrl.startsWith('https') ? https : http;
  const upstream = lib.get(targetUrl, { headers: reqHeaders }, (upRes) => {
    const passHeaders = ['content-type','content-length','content-range','accept-ranges','cache-control'];
    const outHeaders  = { 'Access-Control-Allow-Origin': '*' };
    passHeaders.forEach(h => { if (upRes.headers[h]) outHeaders[h] = upRes.headers[h]; });
    res.writeHead(upRes.statusCode, outHeaders);
    upRes.pipe(res);
  });
  upstream.on('error', e => { console.error('[proxy]', e.message); if (!res.headersSent) res.status(502).send('Proxy error'); });
  req.on('close', () => upstream.destroy());
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ status: 'ok', service: 'Sonara Studio API', cookies: fs.existsSync(COOKIES_PATH) || !!process.env.COOKIES_BASE64 }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Sonara API di port ${PORT}`));