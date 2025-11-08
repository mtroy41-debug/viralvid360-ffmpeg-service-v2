// server.js
import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import tmp from "tmp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const app = express();
const PORT = process.env.PORT || 8080;

// allow JSON
app.use(express.json());

// tell fluent-ffmpeg where ffmpeg is
ffmpeg.setFfmpegPath(ffmpegStatic);

// ---- R2 CONFIG (you already have these envs in Railway) ----
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT; // like https://xxxx.r2.cloudflarestorage.com
const R2_BUCKET = process.env.R2_BUCKET;     // like "viralvid360"
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL; // like https://cdn.viralvid360.com
const MAX_DURATION_SEC = Number(process.env.MAX_DURATION_SEC || "6"); // keep it low for Railway

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  }
});

// health
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// main process endpoint
app.post("/process", async (req, res) => {
  try {
    const { inputUrl, outputKey } = req.body || {};

    if (!inputUrl || !outputKey) {
      return res.status(400).json({
        ok: false,
        error: "inputUrl and outputKey are required",
      });
    }

    // 1) download source video to temp file
    const tmpIn = tmp.fileSync({ postfix: ".mp4" });
    const tmpOut = tmp.fileSync({ postfix: ".mp4" });

    await downloadToFile(inputUrl, tmpIn.name);

    // 2) run ffmpeg (trim/process)
    await runFfmpeg(tmpIn.name, tmpOut.name, MAX_DURATION_SEC);

    // 3) read processed file
    const fileBuffer = await fsp.readFile(tmpOut.name);

    // 4) upload to R2
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: outputKey,
      Body: fileBuffer,
      ContentType: "video/mp4"
    }));

    // 5) respond with public URL
    const publicUrl = R2_PUBLIC_BASE_URL
      ? `${R2_PUBLIC_BASE_URL}/${outputKey}`
      : outputKey;

    // cleanup temp files
    safeUnlink(tmpIn.name);
    safeUnlink(tmpOut.name);

    return res.json({
      ok: true,
      message: "video processed + uploaded",
      inputUrl,
      outputKey,
      publicUrl,
    });

  } catch (err) {
    console.error("process error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "processing failed"
    });
  }
});

// helper: download
async function downloadToFile(url, filepath) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
  }
  await streamToFile(resp.body, filepath);
}

function streamToFile(readable, filepath) {
  return new Promise((resolve, reject) => {
    const writable = fs.createWriteStream(filepath);
    readable.pipe(writable);
    writable.on("finish", resolve);
    writable.on("error", reject);
  });
}

// helper: ffmpeg
function runFfmpeg(inputPath, outputPath, maxSeconds) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath)
      .outputOptions([
        "-movflags +faststart"
      ])
      .videoCodec("libx264")
      .audioCodec("aac")
      .format("mp4")
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .output(outputPath);

    // trim if maxSeconds set
    if (maxSeconds && Number.isFinite(maxSeconds)) {
      cmd = cmd.setDuration(maxSeconds);
    }

    cmd.run();
  });
}

function safeUnlink(p) {
  fs.unlink(p, () => {});
}

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
