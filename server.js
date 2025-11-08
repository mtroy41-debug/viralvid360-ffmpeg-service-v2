// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const app = express();
const PORT = process.env.PORT || 8080;

// --- envs we need ---
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;         // e.g. "123456789abcdef"
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;                 // e.g. "viralvid360"
const CDN_BASE = process.env.CDN_BASE || "https://cdn.viralvid360.com";

// S3 client for Cloudflare R2
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

app.use(cors());
app.use(express.json());

// health
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// real process
app.post("/process", async (req, res) => {
  try {
    const { inputUrl, outputKey } = req.body || {};

    if (!inputUrl || !outputKey) {
      return res.status(400).json({
        ok: false,
        error: "inputUrl and outputKey are required",
      });
    }

    // 1) download source video
    const resp = await fetch(inputUrl);
    if (!resp.ok) {
      return res.status(500).json({
        ok: false,
        error: `failed to download input: ${resp.status} ${resp.statusText}`,
      });
    }
    const fileBuffer = Buffer.from(await resp.arrayBuffer());

    // 2) upload to R2 at exactly the key your frontend expects
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: outputKey, // e.g. "processed/17625296521279-cinematic.mp4"
        Body: fileBuffer,
        ContentType: "video/mp4",
      })
    );

    // 3) respond with same shape you already wired in Base44
    return res.json({
      ok: true,
      message: "process endpoint reached",
      inputUrl,
      outputKey,
      cdnUrl: `${CDN_BASE}/${outputKey}`,
    });
  } catch (err) {
    console.error("process error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
