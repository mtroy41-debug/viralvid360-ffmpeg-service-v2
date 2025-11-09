import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import tmp from "tmp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 8080;

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
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
  });
  console.log('[R2] Pre-signed URL method configured');
}

let ffmpegPath = 'ffmpeg', isFfmpegReady = false;

async function checkFfmpegInstallation() {
  try {
    const { stdout: whichOutput } = await execAsync('which ffmpeg');
    ffmpegPath = whichOutput.trim();
    const { stdout: versionOutput } = await execAsync(`${ffmpegPath} -version`);
    console.log(`[FFmpeg] ${versionOutput.split('\n')[0]}`);
    return true;
  } catch (error) {
    console.error(`[FFmpeg] Not found: ${error.message}`);
    return false;
  }
}

app.get("/health", async (req, res) => {
  if (!isFfmpegReady) isFfmpegReady = await checkFfmpegInstallation();
  res.json({ ok: true, service: "ffmpeg-presigned", version: "5.0", uploadMethod: "pre-signed-url", config: { r2: !!s3, ffmpeg: isFfmpegReady } });
});

async function downloadToBuffer(url, requestId) {
  console.log(`[${requestId}] Downloading...`);
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`[${requestId}] Downloaded ${buffer.length} bytes`);
  return buffer;
}

async function processVideoCLI(inputPath, outputPath, style, requestId) {
  const filters = { cinematic: 'eq=contrast=1.2:brightness=0.1:saturation=1.1', vibrant: 'eq=contrast=1.3:saturation=1.5', vintage: 'curves=vintage,vignette', bw: 'hue=s=0', default: 'scale=1920:1080' };
  const filter = filters[style] || filters.default;
  const cmd = `${ffmpegPath} -i "${inputPath}" -vf "${filter}" -c:v libx264 -preset ultrafast -c:a copy "${outputPath}" -y`;
  console.log(`[${requestId}] Processing...`);
  await execAsync(cmd, { maxBuffer: 20 * 1024 * 1024, timeout: 180000 });
  console.log(`[${requestId}] Processing done`);
}

async function uploadToR2WithPresignedUrl(buffer, outputKey, requestId) {
  console.log(`[${requestId}] Generating pre-signed URL...`);
  const command = new PutObjectCommand({ Bucket: R2_BUCKET, Key: outputKey, ContentType: "video/mp4", CacheControl: "public, max-age=31536000" });
  const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
  console.log(`[${requestId}] URL generated, uploading ${buffer.length} bytes...`);
  const uploadResponse = await fetch(presignedUrl, {
    method: 'PUT',
    body: buffer,
    headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=31536000' },
    signal: AbortSignal.timeout(120000)
  });
  if (!uploadResponse.ok) throw new Error(`Upload failed: ${uploadResponse.status}`);
  console.log(`[${requestId}] Upload complete!`);
}

app.post("/process", async (req, res) => {
  const { inputUrl, outputKey, style = 'cinematic' } = req.body || {};
  const requestId = Date.now().toString(36);
  console.log(`\n[${requestId}] === PRE-SIGNED METHOD ===`);
  console.log(`[${requestId}] Input: ${inputUrl?.substring(0, 80)}...`);
  console.log(`[${requestId}] Output: ${outputKey}`);

  if (!inputUrl || !outputKey) return res.status(400).json({ success: false, error: "Missing fields", requestId });
  if (!isFfmpegReady) return res.status(500).json({ success: false, error: "FFmpeg not ready", requestId });
  if (!s3) return res.status(500).json({ success: false, error: "R2 not configured", requestId });

  let tmpIn = null, tmpOut = null;
  try {
    tmpIn = tmp.fileSync({ postfix: ".mp4" });
    tmpOut = tmp.fileSync({ postfix: ".mp4" });
    const inputBuffer = await downloadToBuffer(inputUrl, requestId);
    await fs.writeFile(tmpIn.name, inputBuffer);
    await processVideoCLI(tmpIn.name, tmpOut.name, style, requestId);
    const outputBuffer = await fs.readFile(tmpOut.name);
    console.log(`[${requestId}] Output: ${outputBuffer.length} bytes`);
    await uploadToR2WithPresignedUrl(outputBuffer, outputKey, requestId);
    const cdnUrl = `${R2_PUBLIC_BASE_URL}/${outputKey}`.replace(/([^:]\/)\/+/g, "$1");
    console.log(`[${requestId}] SUCCESS: ${cdnUrl}`);
    res.json({ success: true, cdnUrl, outputKey, uploadMethod: "pre-signed-url", requestId });
    setImmediate(() => { try { tmpIn.removeCallback(); tmpOut.removeCallback(); } catch (e) {} });
  } catch (error) {
    console.error(`[${requestId}] ERROR: ${error.message}`);
    setImmediate(() => { try { if (tmpIn) tmpIn.removeCallback(); if (tmpOut) tmpOut.removeCallback(); } catch (e) {} });
    return res.status(500).json({ success: false, error: error.message, requestId });
  }
});

app.get("/diagnostic", async (req, res) => {
  const checks = [];
  try { const { stdout } = await execAsync('ffmpeg -version'); checks.push({ name: "FFmpeg", status: "OK", version: stdout.split('\n')[0] }); } catch (e) { checks.push({ name: "FFmpeg", status: "FAIL", error: e.message }); }
  checks.push({ name: "R2 Config", status: s3 ? "OK" : "FAIL", endpoint: R2_ENDPOINT ? "SET" : "MISSING" });
  try { const f = tmp.fileSync(); await fs.writeFile(f.name, "test"); await fs.readFile(f.name); f.removeCallback(); checks.push({ name: "Temp Dir", status: "OK" }); } catch (e) { checks.push({ name: "Temp Dir", status: "FAIL" }); }
  try { const r = await fetch('https://www.google.com', { signal: AbortSignal.timeout(5000) }); checks.push({ name: "Internet", status: r.ok ? "OK" : "WARN" }); } catch (e) { checks.push({ name: "Internet", status: "FAIL" }); }
  if (s3) { const testKey = `diagnostics/test-${Date.now()}.txt`; try { await uploadToR2WithPresignedUrl(Buffer.from("test"), testKey, 'diagnostic'); checks.push({ name: "R2 Upload Test", status: "OK", method: "pre-signed-url", testKey }); } catch (e) { checks.push({ name: "R2 Upload Test", status: "FAIL", error: e.message }); } }
  const allOk = checks.every(c => c.status === "OK");
  res.json({ timestamp: new Date().toISOString(), overallStatus: allOk ? "ALL PASS" : "ISSUES", checks });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log('\n=== FFmpeg v5.0 - PRE-SIGNED URL METHOD ===');
  isFfmpegReady = await checkFfmpegInstallation();
});

process.on('SIGTERM', () => process.exit(0));
