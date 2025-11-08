import cors from "cors";
import fetch from "node-fetch";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import tmp from "tmp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

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
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('[R2] ✅ Configured');
} else {
  console.error('[R2] ❌ Missing credentials');
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ffmpeg-cli-processor",
    version: "3.0-simplified",
    timestamp: new Date().toISOString(),
    r2Configured: !!s3
  });
});

async function downloadToBuffer(url) {
  console.log('[Download] Fetching...');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`[Download] ✅ ${buffer.length} bytes`);
  return buffer;
}

async function processVideoCLI(inputPath, outputPath, style = 'cinematic') {
  console.log(`[FFmpeg-CLI] Processing with style: ${style}`);
  
  // Style filters mapped to FFmpeg CLI syntax
  const filters = {
    cinematic: 'eq=contrast=1.2:brightness=0.1:saturation=1.1',
    vibrant: 'eq=contrast=1.3:saturation=1.5',
    vintage: 'curves=vintage,vignette',
    bw: 'hue=s=0',
    default: 'scale=1920:1080'
  };
  
  const filter = filters[style] || filters.default;
  
  // Use FFmpeg CLI directly - NO fluent-ffmpeg library!
  const ffmpegCmd = `ffmpeg -i "${inputPath}" -vf "${filter}" -c:v libx264 -preset ultrafast -c:a copy "${outputPath}"`;
  
  console.log(`[FFmpeg-CLI] Command: ${ffmpegCmd.substring(0, 100)}...`);
  
  try {
    const { stdout, stderr } = await execAsync(ffmpegCmd, { maxBuffer: 10 * 1024 * 1024 });
    console.log('[FFmpeg-CLI] ✅ Complete');
    if (stderr) console.log('[FFmpeg-CLI] Stderr:', stderr.substring(0, 200));
    return { success: true };
  } catch (error) {
    console.error('[FFmpeg-CLI] ❌ Error:', error.message);
    throw new Error(`FFmpeg processing failed: ${error.message}`);
  }
}

app.post("/process", async (req, res) => {
  const { inputUrl, outputKey, style = 'cinematic' } = req.body || {};
  const requestId = Date.now().toString(36);

  console.log(`\n[${requestId}] ========== NEW REQUEST ==========`);
  console.log(`[${requestId}] Style: ${style}, Output: ${outputKey}`);

  if (!inputUrl || !outputKey) {
    return res.status(400).json({ 
      success: false, 
      error: "Missing inputUrl or outputKey" 
    });
  }

  if (!s3) {
    return res.status(500).json({ 
      success: false, 
      error: "R2 not configured" 
    });
  }

  let tmpIn = null;
  let tmpOut = null;

  try {
    // Create temp files
    tmpIn = tmp.fileSync({ postfix: ".mp4" });
    tmpOut = tmp.fileSync({ postfix: ".mp4" });

    // Download
    console.log(`[${requestId}] Downloading...`);
    const inputBuffer = await downloadToBuffer(inputUrl);
    await fs.writeFile(tmpIn.name, inputBuffer);

    // Process with FFmpeg CLI
    console.log(`[${requestId}] Processing...`);
    await processVideoCLI(tmpIn.name, tmpOut.name, style);

    // Read output
    console.log(`[${requestId}] Reading output...`);
    const outputBuffer = await fs.readFile(tmpOut.name);
    console.log(`[${requestId}] Output: ${outputBuffer.length} bytes`);

    // Upload to R2
    console.log(`[${requestId}] Uploading...`);
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
    console.log(`[${requestId}] ✅ SUCCESS: ${cdnUrl}`);

    // Send response
    res.json({
      success: true,
      cdnUrl,
      outputKey,
      requestId
    });

    // Cleanup after response
    setImmediate(() => {
      try {
        tmpIn.removeCallback();
        tmpOut.removeCallback();
        console.log(`[${requestId}] 🧹 Cleanup done`);
      } catch {}
    });

  } catch (error) {
    console.error(`[${requestId}] ❌ ERROR:`, error.message);
    
    // Cleanup on error
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
  console.log(`\n🚀 FFmpeg CLI Service v3.0 - SIMPLIFIED`);
  console.log(`   Port: ${PORT}`);
  console.log(`   R2: ${s3 ? 'YES ✅' : 'NO ❌'}`);
  console.log(`   Using: Native FFmpeg CLI (no fluent-ffmpeg)\n`);
});
