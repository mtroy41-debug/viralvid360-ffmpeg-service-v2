// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs/promises"; // ✅ Use promises version
import tmp from "tmp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 8080;

const ENABLE_FFMPEG = (process.env.ENABLE_FFMPEG || "true") === "true";
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const SERVICE_KEY = process.env.SERVICE_KEY || "ffmpeg-test-123";

app.use(cors());
app.use(express.json());

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
  console.log('[R2] Client configured');
} else {
  console.warn('[R2] Missing credentials - uploads will fail');
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ffmpeg-processor",
    ts: new Date().toISOString(),
    port: PORT,
    r2Configured: !!s3,
  });
});

// Helper to download file
async function downloadToBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Helper to run FFmpeg
function processVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .output(outputPath)
      .videoCodec("libx264")
      .preset("ultrafast") // Faster processing
      .size("?x720")
      .on("end", () => {
        console.log('[FFmpeg] Processing complete');
        resolve();
      })
      .on("error", (err) => {
        console.error('[FFmpeg] Error:', err.message);
        reject(err);
      })
      .run();
  });
}

app.post("/process", async (req, res) => {
  const { inputUrl, outputKey, style, intensity } = req.body || {};
  const requestId = Date.now().toString(36);

  console.log(`[${requestId}] Processing request:`, {
    inputUrl: inputUrl?.substring(0, 50) + '...',
    outputKey,
    style,
    intensity
  });

  if (!inputUrl || !outputKey) {
    return res.status(400).json({
      ok: false,
      error: "inputUrl and outputKey are required",
    });
  }

  if (!s3) {
    return res.status(500).json({
      ok: false,
      error: "R2 storage not configured",
    });
  }

  // Create temp files
  const tmpIn = tmp.fileSync({ postfix: ".mp4" });
  const tmpOut = tmp.fileSync({ postfix: ".mp4" });

  try {
    // 1) Download input video to buffer first
    console.log(`[${requestId}] Downloading input...`);
    const inputBuffer = await downloadToBuffer(inputUrl);
    await fs.writeFile(tmpIn.name, inputBuffer);
    console.log(`[${requestId}] Downloaded ${inputBuffer.length} bytes`);

    // 2) Process with FFmpeg (or just copy)
    if (ENABLE_FFMPEG) {
      console.log(`[${requestId}] Processing with FFmpeg...`);
      await processVideo(tmpIn.name, tmpOut.name);
    } else {
      console.log(`[${requestId}] Copying (FFmpeg disabled)...`);
      await fs.copyFile(tmpIn.name, tmpOut.name);
    }

    // 3) Read output file into buffer
    console.log(`[${requestId}] Reading output file...`);
    const outputBuffer = await fs.readFile(tmpOut.name);
    console.log(`[${requestId}] Output size: ${outputBuffer.length} bytes`);

    // 4) Upload to R2 with buffer (not stream!)
    console.log(`[${requestId}] Uploading to R2...`);
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: outputKey,
        Body: outputBuffer, // ✅ Use buffer, not stream!
        ContentType: "video/mp4",
        CacheControl: "public, max-age=31536000",
      })
    );
    console.log(`[${requestId}] Upload complete`);

    // 5) Generate CDN URL
    const cdnUrl = `${R2_PUBLIC_BASE_URL}/${outputKey}`;
    console.log(`[${requestId}] Success! CDN URL: ${cdnUrl}`);

    // 6) Return response (BEFORE cleanup)
    const response = {
      ok: true,
      success: true,
      message: "Processing complete",
      inputUrl,
      outputKey,
      cdnUrl, // ✅ Match what Base44 expects
      requestId,
    };

    res.json(response);

    // 7) Cleanup AFTER response sent
    setImmediate(() => {
      try {
        tmpIn.removeCallback();
        tmpOut.removeCallback();
        console.log(`[${requestId}] Cleanup complete`);
      } catch (cleanupErr) {
        console.warn(`[${requestId}] Cleanup error:`, cleanupErr.message);
      }
    });

  } catch (err) {
    console.error(`[${requestId}] Error:`, err);
    
    // Cleanup on error
    try {
      tmpIn.removeCallback();
      tmpOut.removeCallback();
    } catch {}

    return res.status(500).json({
      ok: false,
      success: false,
      error: err.message,
      requestId,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 FFmpeg service listening on port ${PORT}`);
  console.log(`   R2 Configured: ${!!s3}`);
  console.log(`   FFmpeg Enabled: ${ENABLE_FFMPEG}`);
});
