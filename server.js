// server.js
import express from "express";
import fetch from "node-fetch"; // if you're on Node <18; on Node 18+ you can remove this line
import fs from "fs";
import path from "path";

// If you're uploading to R2/S3, you'll also have something like:
// import AWS from "aws-sdk";

const app = express();
app.use(express.json({ limit: "200mb" }));

// ✅ CORS: allow app domain + cdn domain + local
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = [
    "https://viralvid360.com",
    "https://www.viralvid360.com",
    "https://cdn.viralvid360.com",
    "http://localhost:3000",
    "http://localhost:5173",
  ];

  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // if you just want to allow everything, uncomment the next line
    // res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-service-key");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// small helper
function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "viralvid360-ffmpeg-service-v2" });
});

app.post("/process", async (req, res) => {
  try {
    const { inputUrl, outputKey } = req.body;

    if (!inputUrl) {
      return res.status(400).json({ ok: false, error: "inputUrl is required" });
    }
    if (!outputKey) {
      return res.status(400).json({ ok: false, error: "outputKey is required" });
    }

    console.log("downloading", inputUrl);

    // 1) download source file
    const sourceResp = await fetch(inputUrl);
    if (!sourceResp.ok) {
      // 👇 this is the thing that was blowing up earlier
      return res.status(400).json({
        ok: false,
        error: `download failed: ${sourceResp.status} ${sourceResp.statusText}`,
        inputUrl,
      });
    }

    // where to save input
    const inputPath = `/tmp/input.mp4`;
    const fileStream = fs.createWriteStream(inputPath);
    await new Promise((resolve, reject) => {
      sourceResp.body.pipe(fileStream);
      sourceResp.body.on("error", reject);
      fileStream.on("finish", resolve);
    });

    // 2) ensure output dir exists (this was another earlier issue)
    const outLocalPath = `/tmp/${outputKey}`;
    ensureDirForFile(outLocalPath);

    // 3) run ffmpeg
    // this is pseudocode – keep your existing spawn code here
    // e.g. spawn("ffmpeg", ["-i", inputPath, "-c:v", "copy", outLocalPath])
    // await waitForFFmpeg(...)
    // For now let's just pretend we processed:
    console.log("pretend ffmpeg processed to", outLocalPath);
    fs.copyFileSync(inputPath, outLocalPath); // 👈 temp: just copy so we always have an output

    // 4) upload to R2 / S3
    // You'll have something like:
    // const s3 = new AWS.S3({ ...env });
    // await s3.putObject({
    //   Bucket: process.env.R2_BUCKET,
    //   Key: outputKey,
    //   Body: fs.createReadStream(outLocalPath),
    //   ContentType: "video/mp4",
    // }).promise();

    // 5) return the final CDN URL so the UI can show it
    const cdnBase = process.env.R2_PUBLIC_BASE_URL || "https://cdn.viralvid360.com";
    const publicUrl = `${cdnBase}/${outputKey}`;

    return res.json({
      ok: true,
      inputUrl,
      outputKey,
      url: publicUrl,
    });
  } catch (err) {
    console.error("process error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "internal error",
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("FFmpeg service listening on port", port);
});
