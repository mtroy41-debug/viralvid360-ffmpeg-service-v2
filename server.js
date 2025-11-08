import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { promises as fs } from "fs";
import tmp from "tmp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 8080;

const ENABLE_FFMPEG = (process.env.ENABLE_FFMPEG || "true") === "true";
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

let s3 = null;
if (R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  s3 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('[R2] ✅ Client configured');
} else {
  console.error('[R2] ❌ Missing credentials!');
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ffmpeg-processor",
    version: "2.0-bulletproof-docker",
    timestamp: new Date().toISOString(),
    r2Configured: !!s3
  });
});

async function downloadToBuffer(url) {
  console.log('[Download] Starting...');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`[Download] ✅ ${buffer.length} bytes`);
  return buffer;
}

function processVideo(inputPath, outputPath, style = 'cinematic') {
  return new Promise((resolve, reject) => {
    const filters = {
      cinematic: 'eq=contrast=1.2:brightness=0.1:saturation=1.1',
      vibrant: 'eq=contrast=1.3:saturation=1.5',
      vintage: 'curves=vintage,vignette',
      bw: 'hue=s=0'
    };
    
    ffmpeg(inputPath)
      .output(outputPath)
      .videoCodec("libx264")
      .preset("ultrafast")
      .videoFilters(filters[style] || 'scale=1920:1080')
      .audioCodec("copy")
      .on("end", () => {
        console.log('[FFmpeg] ✅ Complete');
        resolve();
      })
      .on("error", (err) => {
        console.error('[FFmpeg] ❌ Error:', err.message);
        reject(err);
      })
      .run();
  });
}

app.post("/process", async (req, res) => {
  const { inputUrl, outputKey, style = 'cinematic' } = req.body || {};
  const requestId = Date.now().toString(36);

  console.log(`\n[${requestId}] ========== NEW REQUEST ==========`);
  console.log(`[${requestId}] Output: ${outputKey}`);

  if (!inputUrl || !outputKey) {
    return res.status(400).json({ success: false, error: "Missing inputUrl or outputKey" });
  }

  if (!s3) {
    return res.status(500).json({ success: false, error: "R2 not configured" });
  }

  let tmpIn = null;
  let tmpOut = null;

  try {
    tmpIn = tmp.fileSync({ postfix: ".mp4" });
    tmpOut = tmp.fileSync({ postfix: ".mp4" });

    console.log(`[${requestId}] Downloading...`);
    const inputBuffer = await downloadToBuffer(inputUrl);
    await fs.writeFile(tmpIn.name, inputBuffer);

    if (ENABLE_FFMPEG) {
      console.log(`[${requestId}] Processing with FFmpeg (${style})...`);
      await processVideo(tmpIn.name, tmpOut.name, style);
    } else {
      console.log(`[${requestId}] Copying (FFmpeg disabled)...`);
      await fs.copyFile(tmpIn.name, tmpOut.name);
    }

    console.log(`[${requestId}] Reading output...`);
    const outputBuffer = await fs.readFile(tmpOut.name);
    console.log(`[${requestId}] Output: ${outputBuffer.length} bytes`);

    console.log(`[${requestId}] Uploading to R2...`);
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: outputKey,
        Body: outputBuffer,
        ContentType: "video/mp4",
        CacheControl: "public, max-age=31536000",
      })
    );

    const cdnUrl = `${R2_PUBLIC_BASE_URL}/${outputKey}`;
    console.log(`[${requestId}] ✅ SUCCESS! ${cdnUrl}`);

    res.json({
      success: true,
      cdnUrl,
      outputKey,
      requestId
    });

    setImmediate(() => {
      try {
        tmpIn.removeCallback();
        tmpOut.removeCallback();
        console.log(`[${requestId}] 🧹 Cleanup done`);
      } catch {}
    });

  } catch (error) {
    console.error(`[${requestId}] ❌ ERROR:`, error.message);
    
    try {
      if (tmpIn) tmpIn.removeCallback();
      if (tmpOut) tmpOut.removeCallback();
    } catch {}

    return res.status(500).json({
      success: false,
      error: error.message,
      requestId
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 FFmpeg Service BULLETPROOF v2.0 (Docker)`);
  console.log(`   Port: ${PORT}`);
  console.log(`   R2: ${s3 ? 'YES ✅' : 'NO ❌'}`);
  console.log(`   Bucket: ${R2_BUCKET || 'NOT SET'}\n`);
});
