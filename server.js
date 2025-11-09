// server.js
import express from "express";
import { execFile } from "child_process";
import { createWriteStream, promises as fsp } from "fs";
import { pipeline } from "stream";
import { promisify } from "util";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const app = express();
const PORT = process.env.PORT || 8080;

const ENABLE_FFMPEG = (process.env.ENABLE_FFMPEG || "true") === "true";
const SERVICE_KEY = process.env.SERVICE_KEY || "ffmpeg-test-123";

// these are the ones from your screenshot
const R2_ENDPOINT = (process.env.R2_ENDPOINT || "").trim();
const R2_BUCKET = (process.env.R2_BUCKET || "").trim();
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "").trim();
const R2_ACCESS_KEY_ID = (process.env.R2_ACCESS_KEY_ID || "").trim();
const R2_SECRET_ACCESS_KEY = (process.env.R2_SECRET_ACCESS_KEY || "").trim();

const streamPipeline = promisify(pipeline);

// S3 client for Cloudflare R2
const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT, // e.g. https://xxxx.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

app.use(express.json());

app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    ts: new Date().toISOString(),
    ffmpegEnabled: ENABLE_FFMPEG,
  });
});

// helper to run ffmpeg
function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // simple transcode — you can change this later
    const args = ["-y", "-i", inputPath, "-c:v", "copy", "-c:a", "copy", outputPath];
    const child = execFile("ffmpeg", args, (err, stdout, stderr) => {
      if (err) {
        console.error("ffmpeg error:", err);
        console.error("ffmpeg stderr:", stderr);
        return reject(err);
      }
      resolve();
    });
  });
}

// POST /process
app.post("/process", async (req, res) => {
  // 1. service key
  const headerKey = req.headers["x-service-key"];
  if (SERVICE_KEY && headerKey !== SERVICE_KEY) {
    return res.status(401).json({ ok: false, error: "invalid service key" });
  }

  const { inputUrl, outputKey } = req.body || {};

  if (!inputUrl || !outputKey) {
    return res.status(400).json({
      ok: false,
      error: "inputUrl and outputKey are required",
    });
  }

  // tmp paths
  const ts = Date.now();
  const inputPath = `/tmp/input-${ts}.mp4`;
  const outputPath = `/tmp/output-${ts}.mp4`;

  try {
    // 2. download source video
    console.log("downloading", inputUrl);
    const resp = await fetch(inputUrl);
    if (!resp.ok) {
      return res.status(500).json({
        ok: false,
        error: `failed to download input: ${resp.status} ${resp.statusText}`,
      });
    }
    const fileStream = createWriteStream(inputPath);
    await streamPipeline(resp.body, fileStream);

    // 3. run ffmpeg (if enabled)
    if (ENABLE_FFMPEG) {
      await runFfmpeg(inputPath, outputPath);
    } else {
      // fallback: just re-upload original if ffmpeg off
      await fsp.copyFile(inputPath, outputPath);
    }

    // 4. upload to R2
    const fileBuffer = await fsp.readFile(outputPath);

    const putCmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: outputKey, // e.g. processed/test-output.mp4
      Body: fileBuffer,
      ContentType: "video/mp4",
      ACL: "public-read", // CF R2 usually allows this
    });

    await s3.send(putCmd);

    // 5. build public URL
    const base = R2_PUBLIC_BASE_URL.replace(/\/$/, "");
    const publicUrl = `${base}/${outputKey}`;

    return res.json({
      ok: true,
      message: "processed and uploaded",
      inputUrl,
      outputKey,
      cdnUrl: publicUrl,
    });
  } catch (err) {
    console.error("process error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "processing failed",
    });
  } finally {
    // best-effort cleanup
    try {
      await fsp.unlink(inputPath);
    } catch (_) {}
    try {
      await fsp.unlink(outputPath);
    } catch (_) {}
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
