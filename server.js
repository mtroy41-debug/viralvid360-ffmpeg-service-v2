import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { exec } from "child_process";
import util from "util";

const app = express();
app.use(express.json({ limit: "200mb" }));

const execPromise = util.promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_ENDPOINT,
  R2_BUCKET,
  R2_PUBLIC_BASE_URL,
  ENABLE_FFMPEG,
  PORT = 8080,
} = process.env;

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

app.get("/health", (_, res) =>
  res.json({ ok: true, service: "ffmpeg-processor", ts: new Date().toISOString() })
);

app.post("/process", async (req, res) => {
  try {
    const { inputUrl, outputKey } = req.body;
    if (!inputUrl || !outputKey)
      return res.status(400).json({ ok: false, error: "Missing inputUrl or outputKey" });

    console.log("▶ Downloading:", inputUrl);

    const tmpInput = path.join("/tmp", "input.mp4");
    const tmpOutput = path.join("/tmp", "output.mp4");

    const r = await fetch(inputUrl);
    if (!r.ok) throw new Error(`failed to download input: ${r.statusText}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(tmpInput, buf);

    if (ENABLE_FFMPEG === "true") {
      await execPromise(
        `ffmpeg -y -i ${tmpInput} -vf "eq=brightness=0.03:saturation=1.2" -c:a copy ${tmpOutput}`
      );
    } else {
      fs.copyFileSync(tmpInput, tmpOutput);
    }

    const fileBody = fs.readFileSync(tmpOutput);
    const uploadParams = {
      Bucket: R2_BUCKET,
      Key: outputKey,
      Body: fileBody,
      ContentType: "video/mp4",
      ACL: "public-read",
    };
    await s3.send(new PutObjectCommand(uploadParams));

    const publicUrl = `${R2_PUBLIC_BASE_URL}/${outputKey}`;
    console.log("✅ Uploaded:", publicUrl);

    res.json({ ok: true, publicUrl });
  } catch (err) {
    console.error("❌ process error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`🎬 FFmpeg Service running on ${PORT}`));
