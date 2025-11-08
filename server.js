// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const app = express();
const PORT = process.env.PORT || 8080;

// use the envs you already have
const R2_ENDPOINT = process.env.R2_ENDPOINT;               // you have this
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;                   // "viralvid360"
const CDN_BASE =
  process.env.R2_PUBLIC_BASE_URL || "https://cdn.viralvid360.com";

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
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

// main endpoint your Deno function calls
app.post("/process", async (req, res) => {
  try {
    const { inputUrl, outputKey } = req.body || {};

    if (!inputUrl || !outputKey) {
      return res.status(400).json({
        ok: false,
        error: "inputUrl and outputKey are required",
      });
    }

    // 1. download source
    const resp = await fetch(inputUrl);
    if (!resp.ok) {
      return res.status(500).json({
        ok: false,
        error: `failed to download input: ${resp.status} ${resp.statusText}`,
      });
    }
    const fileBuffer = Buffer.from(await resp.arrayBuffer());

    // 2. upload to R2 at the exact key your frontend expects
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: outputKey,
        Body: fileBuffer,
        ContentType: "video/mp4",
      })
    );

    // 3. answer in the format your Base44 function is already expecting
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
