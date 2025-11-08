import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "25mb" }));
app.use(cors());

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

const s3 =
  R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: "auto",
        endpoint: R2_ENDPOINT,
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

async function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
}

function normalizeOutputKey(outputKey = "") {
  let key = outputKey.trim();
  if (key.startsWith("/")) key = key.slice(1);
  if (key.startsWith("processed/")) key = key.replace(/^processed\//, "");
  return key;
}

function runFFmpeg(inputUrl, outPath, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-i", inputUrl, ...extraArgs, outPath];
    const ff = spawn("ffmpeg", args);
    let stderr = "";
    ff.stderr.on("data", (d) => {
      const msg = d.toString();
      stderr += msg;
      console.log(msg);
    });
    ff.on("close", (code) => {
      if (code === 0) {
        resolve({ code, stderr });
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      }
    });
  });
}

async function uploadToR2(localPath, key) {
  if (!s3) throw new Error("R2 not configured");
  const fileData = await fs.promises.readFile(localPath);
  const put = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: fileData,
    ContentType: "video/mp4",
  });
  await s3.send(put);
  if (R2_PUBLIC_BASE_URL) {
    return `${R2_PUBLIC_BASE_URL}/${key}`;
  }
  return `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post("/process", async (req, res) => {
  try {
    const { inputUrl, outputKey, ffmpegArgs } = req.body || {};
    if (!inputUrl) {
      return res.status(400).json({ error: "inputUrl is required" });
    }
    const cleanKey = normalizeOutputKey(outputKey || "output.mp4");
    const localOut = path.join("/tmp/processed", cleanKey);
    await ensureDirForFile(localOut);

    await runFFmpeg(inputUrl, localOut, Array.isArray(ffmpegArgs) ? ffmpegArgs : []);

    let publicUrl = null;
    try {
      publicUrl = await uploadToR2(localOut, `processed/${cleanKey}`);
    } catch (e) {
      console.error("R2 upload failed:", e.message);
    }

    try {
      await fs.promises.unlink(localOut);
    } catch (e) {
      console.warn("Could not delete temp file:", e.message);
    }

    return res.json({
      ok: true,
      message: "ffmpeg completed",
      outputKey: `processed/${cleanKey}`,
      publicUrl,
    });
  } catch (err) {
    console.error("FFmpeg error:", err);
    return res.status(500).json({ error: err.message || "ffmpeg failed" });
  }
});

app.listen(PORT, () => console.log(`FFmpeg service listening on port ${PORT}`));
