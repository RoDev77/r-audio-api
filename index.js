const express = require('express');
const cors = require('cors');
const ytDlp = require('yt-dlp-exec');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL kosong!' });

    try {
        console.log(`Extracting: ${url}`);
        
        // Menambahkan opsi agar yt-dlp lebih sulit dideteksi YouTube
        const output = await ytDlp(url, {
            dumpJson: true,
            format: 'bestaudio',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            referer: 'https://www.youtube.com/',
            addHeader: [
                'Referer:https://www.youtube.com/',
                'Accept-Language:en-US,en;q=0.9'
            ],
            noWarnings: true,
            noCallHome: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true
        });

        if (!output.url) throw new Error("Gagal mendapatkan link audio.");

        res.json({
            success: true,
            title: (output.title || 'Sonara_Audio').replace(/[^a-zA-Z0-9 _-]/g, "_"),
            streamUrl: output.url
        });
    } catch (error) {
        console.error("YT-DLP Error:", error.message);
        res.status(500).json({ error: "Gagal mengekstrak: " + error.message });
    }
});

// Proxy (Pastikan Railway mengizinkan fetch eksternal)
app.get('/proxy', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send("Missing URL");
    try {
        const response = await fetch(url, {
            headers: { 
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Referer": "https://www.youtube.com/"
            }
        });
        response.body.pipe(res);
    } catch (e) {
        res.status(500).send("Proxy Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API berjalan di port ${PORT}`));