// ============================================
// RAILWAY FFMPEG SERVICE - v4.1 FINAL (with Diagnostics)
// Copy this ENTIRE file to your Railway server.js
// ============================================

import express from "express";
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

// Environment Variables
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
// This handles the TLS warning you saw and the R2 upload failure.
// IMPORTANT: Ensure NODE_TLS_REJECT_UNAUTHORIZED=0 is set in Railway Variables
const NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize S3 Client
let s3 = null;
if (R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  try {
    s3 = new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      // Explicitly configure TLS to ignore unauthorized certificates if the env var is set
      tls: { rejectUnauthorized: NODE_TLS_REJECT_UNAUTHORIZED !== '0' } 
    });
    console.log('[R2] ✅ Client configured successfully');
  } catch (error) {
    console.error('[R2] ❌ Failed to initialize S3 client:', error.message);
  }
} else {
  console.error('[R2] ❌ CRITICAL: Missing R2 credentials. Uploads will fail!');
  console.error('[R2] Required env vars: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
}

// FFmpeg check
let ffmpegPath = 'ffmpeg';
let isFfmpegReady = false;

async function checkFfmpegInstallation() {
  try {
    const { stdout: whichOutput } = await execAsync('which ffmpeg');
    ffmpegPath = whichOutput.trim();
    const { stdout: versionOutput } = await execAsync(`${ffmpegPath} -version`);
    console.log(`[FFmpeg] ✅ Found at: ${ffmpegPath}`);
    console.log(`[FFmpeg] Version: ${versionOutput.split('\n')[0]}`);
    return true;
  } catch (error) {
    console.error(`[FFmpeg] ❌ Not found or not executable: ${error.message}`);
    console.error('[FFmpeg] Please ensure FFmpeg is installed and in the system PATH.');
    return false;
  }
}

// Health Check
app.get("/health", async (req, res) => {
  if (!isFfmpegReady) {
    isFfmpegReady = await checkFfmpegInstallation();
  }

  res.json({
    ok: true,
    service: "ffmpeg-cli-processor",
    version: "4.1-final",
    timestamp: new Date().toISOString(),
    config: {
      r2Configured: !!s3,
      r2Endpoint: R2_ENDPOINT ? 'SET' : 'MISSING',
      r2Bucket: R2_BUCKET || 'MISSING',
      r2PublicBase: R2_PUBLIC_BASE_URL || 'MISSING',
      ffmpegReady: isFfmpegReady,
      ffmpegPath: ffmpegPath,
      nodeVersion: process.version,
      platform: process.platform,
      env_tls_reject_unauthorized: NODE_TLS_REJECT_UNAUTHORIZED
    }
  });
});

// Download helper
async function downloadToBuffer(url, requestId) {
  console.log(`[${requestId}] [Download] Starting: ${url.substring(0, 80)}...`);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(90000) // 90 seconds
  });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`[${requestId}] [Download] ✅ Complete: ${buffer.length} bytes`);
  return buffer;
}

// FFmpeg processing helper
async function processVideoCLI(inputPath, outputPath, style, requestId) {
  console.log(`[${requestId}] [FFmpeg] Processing with style: ${style}`);
  
  const filters = {
    cinematic: 'eq=contrast=1.2:brightness=0.1:saturation=1.1',
    vibrant: 'eq=contrast=1.3:saturation=1.5',
    vintage: 'curves=vintage,vignette',
    bw: 'hue=s=0',
    default: 'scale=1920:1080'
  };
  
  const filter = filters[style] || filters.default;
  const ffmpegCmd = `${ffmpegPath} -i \"${inputPath}\" -vf \"${filter}\" -c:v libx264 -preset ultrafast -c:a copy \"${outputPath}\" -y`;
  
  console.log(`[${requestId}] [FFmpeg] Command: ${ffmpegCmd.substring(0, 150)}...`);
  
  try {
    const { stdout, stderr } = await execAsync(ffmpegCmd, { 
      maxBuffer: 20 * 1024 * 1024, 
      timeout: 180000 // 3 minutes
    });
    
    if (stderr && stderr.includes('error')) {
      console.warn(`[${requestId}] [FFmpeg] Warning in stderr: ${stderr.substring(0, 200)}`);
    }
    
    console.log(`[${requestId}] [FFmpeg] ✅ Processing complete`);
    return { success: true };
  } catch (error) {
    console.error(`[${requestId}] [FFmpeg] ❌ Failed: ${error.message}`);
    if (error.stdout) console.error(`[${requestId}] [FFmpeg] Stdout: ${error.stdout.substring(0, 500)}`);
    if (error.stderr) console.error(`[${requestId}] [FFmpeg] Stderr: ${error.stderr.substring(0, 500)}`);
    throw new Error(`FFmpeg processing failed: ${error.message}`);
  }
}

// Main Processing Endpoint
app.post("/process", async (req, res) => {
  const { inputUrl, outputKey, style = 'cinematic', intensity = 0.5 } = req.body || {};
  const requestId = Date.now().toString(36);

  console.log(`\n[${requestId}] ========== NEW REQUEST ==========`);
  console.log(`[${requestId}] Input: ${inputUrl?.substring(0, 80)}...`);
  console.log(`[${requestId}] Output: ${outputKey}`);
  console.log(`[${requestId}] Style: ${style}, Intensity: ${intensity}`);

  // Pre-flight checks
  if (!inputUrl || !outputKey) {
    console.error(`[${requestId}] ❌ Missing required fields`);
    return res.status(400).json({ 
      success: false, 
      error: "inputUrl and outputKey are required",
      requestId
    });
  }

  if (!isFfmpegReady) {
    console.error(`[${requestId}] ❌ FFmpeg not ready`);
    return res.status(500).json({ 
      success: false, 
      error: "FFmpeg not found or not executable",
      hint: "FFmpeg installation failed. Check Railway build logs.",
      requestId
    });
  }

  if (!s3) {
    console.error(`[${requestId}] ❌ R2 not configured`);
    return res.status(500).json({ 
      success: false, 
      error: "R2 storage not configured",
      hint: "Missing R2 environment variables. Check Railway settings.",
      missingVars: {
        R2_ENDPOINT: !R2_ENDPOINT,
        R2_BUCKET: !R2_BUCKET,
        R2_PUBLIC_BASE_URL: !R2_PUBLIC_BASE_URL,
        R2_ACCESS_KEY_ID: !R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY: !R2_SECRET_ACCESS_KEY
      },
      requestId
    });
  }

  let tmpIn = null;
  let tmpOut = null;

  try {
    // Step 1: Create temp files
    tmpIn = tmp.fileSync({ postfix: ".mp4" });
    tmpOut = tmp.fileSync({ postfix: ".mp4" });
    console.log(`[${requestId}] Temp files created`);

    // Step 2: Download input
    const inputBuffer = await downloadToBuffer(inputUrl, requestId);
    await fs.writeFile(tmpIn.name, inputBuffer);
    console.log(`[${requestId}] ✅ Input saved to temp file`);

    // Step 3: Process with FFmpeg
    await processVideoCLI(tmpIn.name, tmpOut.name, style, requestId);
    console.log(`[${requestId}] ✅ Video processed`);

    // Step 4: Read output
    const outputBuffer = await fs.readFile(tmpOut.name);
    console.log(`[${requestId}] ✅ Output read: ${outputBuffer.length} bytes`);

    // Step 5: Upload to R2
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
    console.log(`[${requestId}] ✅ Uploaded to R2`);

    // Step 6: Generate CDN URL
    const cdnUrl = `${R2_PUBLIC_BASE_URL}/${outputKey}`.replace(/([^:]\/)\/+/g, "$1");
    console.log(`[${requestId}] 🎉 SUCCESS! CDN: ${cdnUrl}`);

    // Send response
    res.json({
      success: true,
      cdnUrl,
      outputKey,
      message: "Processing complete",
      requestId,
      timestamp: new Date().toISOString()
    });

    // Cleanup
    setImmediate(() => {
      try {
        tmpIn.removeCallback();
        tmpOut.removeCallback();
        console.log(`[${requestId}] 🧹 Cleanup done`);
      } catch (e) {
        console.warn(`[${requestId}] Cleanup warning: ${e.message}`);
      }
    });

  } catch (error) {
    console.error(`[${requestId}] ❌ ERROR: ${error.message}`);
    console.error(`[${requestId}] Stack: ${error.stack}`);
    
    // Cleanup on error
    setImmediate(() => {
      try {
        if (tmpIn) tmpIn.removeCallback();
        if (tmpOut) tmpOut.removeCallback();
      } catch (e) {
        console.warn(`[${requestId}] Error cleanup warning: ${e.message}`);
      }
    });

    return res.status(500).json({
      success: false,
      error: error.message || "Processing failed",
      details: error.stack,
      requestId,
      timestamp: new Date().toISOString()
    });
  }
});

// === DIAGNOSTIC ENDPOINT - Checks core components ===
app.get("/diagnostic", async (req, res) => {
  const diagnostics = {
    timestamp: new Date().toISOString(),
    service: "ffmpeg-diagnostic",
    checks: []
  };

  // Check 1: FFmpeg
  try {
    const { stdout } = await execAsync('ffmpeg -version');
    diagnostics.checks.push({
      name: "FFmpeg Binary",
      status: "✅ OK",
      version: stdout.split('\n')[0]
    });
  } catch (error) {
    diagnostics.checks.push({
      name: "FFmpeg Binary",
      status: "❌ FAIL",
      error: error.message
    });
  }

  // Check 2: R2 Configuration and Client
  diagnostics.checks.push({
    name: "R2 Configuration",
    status: s3 ? "✅ OK" : "❌ FAIL",
    details: {
      endpoint: R2_ENDPOINT ? "SET" : "MISSING",
      bucket: R2_BUCKET || "MISSING",
      publicBase: R2_PUBLIC_BASE_URL || "MISSING",
      hasCredentials: !!(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY),
      tls_reject_unauthorized: NODE_TLS_REJECT_UNAUTHORIZED
    }
  });

  // Check 3: Temp directory write/read access
  try {
    const testFile = tmp.fileSync();
    await fs.writeFile(testFile.name, "test");
    await fs.readFile(testFile.name);
    testFile.removeCallback();
    diagnostics.checks.push({
      name: "Temporary Directory Access",
      status: "✅ OK"
    });
  } catch (error) {
    diagnostics.checks.push({
      name: "Temporary Directory Access",
      status: "❌ FAIL",
      error: error.message
    });
  }

  // Check 4: Outbound Internet connectivity (to a trusted source)
  try {
    const response = await fetch('https://www.google.com', { signal: AbortSignal.timeout(5000) });
    diagnostics.checks.push({
      name: "Outbound Internet Access",
      status: response.ok ? "✅ OK" : "⚠️ WARN",
      httpStatus: response.status
    });
  } catch (error) {
    diagnostics.checks.push({
      name: "Outbound Internet Access",
      status: "❌ FAIL",
      error: error.message
    });
  }

  const allOk = diagnostics.checks.every(c => c.status.includes("✅"));
  diagnostics.overallStatus = allOk ? "✅ ALL SYSTEMS GO" : "⚠️ ISSUES DETECTED";

  res.json(diagnostics);
});


// Start server
app.listen(PORT, '0.0.0.0', async () => {
  console.log('\n======================================================');
  console.log(`🚀 FFmpeg Service v4.1 - FINAL`);
  console.log(`   Port: ${PORT}`);
  console.log(`   R2: ${s3 ? 'YES ✅' : 'NO ❌'}`);
  console.log(`   NODE_TLS_REJECT_UNAUTHORIZED: ${NODE_TLS_REJECT_UNAUTHORIZED}`);
  console.log('======================================================\n');

  isFfmpegReady = await checkFfmpegInstallation();
  if (!isFfmpegReady) {
    console.error("CRITICAL: FFmpeg not ready!");
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  process.exit(0);
});
