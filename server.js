// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import fs from "fs";
import { pipeline } from "stream/promises";
import tmp from "tmp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// make fluent-ffmpeg use the bundled binary
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 8080;

// ---- envs from your screenshot ----
const ENABLE_FFMPEG = (process.env.ENABLE_FFMPEG || "true") === "true";
const R2_ENDPOINT = process.env.R2_ENDPOINT; // e.g. https://xxxx.r2.cloudflarestorage.com
const R2_BUCKET = process.env.R2_BUCKET;     // e.g. "viralvid360"
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL; // e.g. https://cdn.viralvid360.com
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
// optional “service key” you had in Railway:
const SERVICE_KEY = process.env.SERVICE_KEY || "ffmpeg-test-123";
// -----------------------------------

app.use(cors());
app.use(express.json());

// R2/S3 client (Cloudflare R2 is S3-compatible)
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
}

// health check – Base44 is already using this
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ffmpeg-processor",
    ts: new Date().toISOString(),
    port: PORT,
  });
});

// main endpoint
app.post("/process", async (req, res) => {
  const { inputUrl, outputKey } = req.body || {};

  if (!inputUrl || !outputKey) {
    return res.status(400).json({
      ok: false,
      error: "inputUrl and outputKey are required",
    });
  }

  try {
    // 1) download to temp file
    const tmpIn = tmp.fileSync({ postfix: ".mp4" });
    const tmpOut = tmp.fileSync({ postfix: ".mp4" });

    const resp = await fetch(inputUrl);
    if (!resp.ok) {
      // same kind of error you saw in Postman
      return res.status(500).json({
        ok: false,
        error: `failed to download input: ${resp.status} ${resp.statusText}`,
      });
    }

    await pipeline(resp.body, fs.createWriteStream(tmpIn.name));

    // 2) process (or just copy)
    if (ENABLE_FFMPEG) {
      await new Promise((resolve, reject) => {
        ffmpeg(tmpIn.name)
          .output(tmpOut.name)
          .videoCodec("libx264")
          .size("?x720") // simple transform so ffmpeg actually runs
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    } else {
      fs.copyFileSync(tmpIn.name, tmpOut.name);
    }

    // 3) upload to R2 if configured
    let publicUrl = null;
    if (s3) {
      const bodyStream = fs.createReadStream(tmpOut.name);
      await s3.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: outputKey,           // e.g. "processed/test-output.mp4"
          Body: bodyStream,
          ContentType: "video/mp4",
        })
      );

      if (R2_PUBLIC_BASE_URL) {
        // exactly what your frontend expects
        publicUrl = `${R2_PUBLIC_BASE_URL}/${outputKey}`;
      }
    }

    // cleanup
    tmpIn.removeCallback();
    tmpOut.removeCallback();

    // final response – this is the shape your Base44 function logged
    return res.json({
      ok: true,
      message: "process endpoint reached",
      inputUrl,
      outputKey,
      publicUrl,
      serviceKeyUsed: SERVICE_KEY,
    });
  } catch (err) {
    console.error("process error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
