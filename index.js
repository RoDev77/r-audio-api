const express = require('express');
const cors    = require('cors');
const ytDlp   = require('yt-dlp-exec');
const https   = require('https');
const http    = require('http');

const app = express();
app.use(cors());
app.use(express.json());

// ── Helper: pilih extractor berdasarkan URL ──────────────────────────────────
function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('tiktok.com')) return 'tiktok';
  return 'unknown';
}

// ── /api/extract — ekstrak audio stream URL via yt-dlp ──────────────────────
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL kosong!' });

  const platform = detectPlatform(url);
  console.log(`[extract] platform=${platform} url=${url}`);

  // Opsi dasar yt-dlp — berlaku untuk semua platform
  const baseOpts = {
    dumpJson:             true,
    noWarnings:           true,
    noCallHome:           true,
    noCheckCertificate:   true,
    preferFreeFormats:    true,
    // Spoofing browser — penting untuk YouTube & TikTok
    addHeader: [
      'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept-Language:en-US,en;q=0.9',
    ],
  };

  // Format yang diutamakan per platform
  // YouTube: bestaudio non-DRM (biasanya opus/m4a)
  // TikTok : audio saja (format 0 = mp3 langsung)
  const platformOpts = platform === 'youtube'
    ? {
        format: 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        addHeader: [
          ...baseOpts.addHeader,
          'Referer:https://www.youtube.com/',
        ],
        youtubeSkipDashManifest: true,
        // Extractor args untuk bypass throttle & bot check
        extractorArgs: 'youtube:player_client=web,android',
      }
    : {
        format: 'bestaudio/best',
        addHeader: [
          ...baseOpts.addHeader,
          'Referer:https://www.tiktok.com/',
        ],
      };

  const opts = { ...baseOpts, ...platformOpts };

  try {
    const output = await ytDlp(url, opts);

    if (!output || !output.url) {
      throw new Error('yt-dlp tidak mengembalikan stream URL. Coba video lain.');
    }

    const safeTitle = (output.title || 'Sonara_Audio')
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 80);

    console.log(`[extract] ✅ ${safeTitle}`);
    res.json({
      success:   true,
      title:     safeTitle,
      streamUrl: output.url,
      duration:  output.duration || null,
      ext:       output.ext || 'mp3',
    });
  } catch (err) {
    console.error('[extract] ❌', err.message);

    // Pesan error yang lebih informatif untuk user
    let userMsg = 'Gagal mengekstrak audio.';
    if (err.message.includes('Sign in')  || err.message.includes('age'))
      userMsg = 'Video butuh login / verifikasi umur — tidak bisa diakses.';
    else if (err.message.includes('copyright') || err.message.includes('blocked'))
      userMsg = 'Video diblokir hak cipta di server.';
    else if (err.message.includes('private'))
      userMsg = 'Video diprivate — tidak bisa diakses.';
    else if (err.message.includes('unavailable'))
      userMsg = 'Video tidak tersedia / sudah dihapus.';

    res.status(500).json({ error: userMsg, detail: err.message });
  }
});

// ── /proxy — stream file audio ke browser (hindari CORS) ────────────────────
// Dipakai setelah /api/extract memberikan streamUrl
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing URL');

  // Safety check — hanya izinkan domain audio yang dikenal
  const ALLOWED = [
    'googlevideo.com', 'youtube.com', 'ytimg.com',
    'tiktokcdn.com', 'tiktokcdn-us.com', 'bytedance.com',
    'akamaized.net', 'cloudfront.net', 'cdn-pea.me',
    'vreden.my.id', 'siputzx.my.id', 'agatz.xyz',
  ];
  let allowed = false;
  try {
    const parsed = new URL(targetUrl);
    allowed = ALLOWED.some(d => parsed.hostname.endsWith(d));
    // Izinkan juga URL data stream dari yt-dlp (googlevideo, dll)
    if (!allowed && parsed.hostname.includes('googlevideo')) allowed = true;
  } catch (_) {}

  if (!allowed) {
    // Jika tidak ada di whitelist, tetap coba tapi log warning
    console.warn('[proxy] ⚠️  Domain tidak dikenal:', targetUrl.slice(0, 80));
  }

  const headers = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    'Accept':          'audio/*, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         'https://www.youtube.com/',
  };

  // Teruskan Range header jika ada (untuk seek di browser)
  if (req.headers.range) headers['Range'] = req.headers.range;

  try {
    const lib      = targetUrl.startsWith('https') ? https : http;
    const upstream = lib.get(targetUrl, { headers }, (upstreamRes) => {
      // Teruskan status dan content headers
      const passthroughHeaders = [
        'content-type', 'content-length', 'content-range',
        'accept-ranges', 'cache-control',
      ];
      const responseHeaders = { 'Access-Control-Allow-Origin': '*' };
      passthroughHeaders.forEach(h => {
        if (upstreamRes.headers[h]) responseHeaders[h] = upstreamRes.headers[h];
      });

      res.writeHead(upstreamRes.statusCode, responseHeaders);
      upstreamRes.pipe(res);
    });

    upstream.on('error', (e) => {
      console.error('[proxy] upstream error:', e.message);
      if (!res.headersSent) res.status(502).send('Proxy upstream error');
    });

    req.on('close', () => upstream.destroy());
  } catch (e) {
    console.error('[proxy] error:', e.message);
    if (!res.headersSent) res.status(500).send('Proxy Error: ' + e.message);
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Sonara Studio API' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Sonara API berjalan di port ${PORT}`));