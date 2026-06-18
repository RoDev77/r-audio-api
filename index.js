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
        const output = await ytDlp(url, {
            dumpJson: true,
            format: 'bestaudio',
            noWarnings: true,
            noCallHome: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true
        });

        if (!output.url) throw new Error("Gagal dapat link.");

        res.json({
            success: true,
            title: (output.title || 'Sonara_Audio').replace(/[^a-zA-Z0-9 _-]/g, "_"),
            streamUrl: output.url
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Gagal mengekstrak video. Mungkin diprivate/terkunci." });
    }
});

// Rute Proxy untuk bypass CORS saat mendownload file audio
app.get('/proxy', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send("Missing URL");
    try {
        const response = await fetch(url);
        response.body.pipe(res);
    } catch (e) {
        res.status(500).send("Proxy Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API berjalan di port ${PORT}`));