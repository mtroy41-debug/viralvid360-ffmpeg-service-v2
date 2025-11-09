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

    // fetch the source
    const sourceResp = await fetch(inputUrl);
    if (!sourceResp.ok) {
      return res.status(400).json({
        ok: false,
        error: `download failed: ${sourceResp.status} ${sourceResp.statusText}`,
        inputUrl,
      });
    }

    // ✅ Node 20 fetch → use arrayBuffer()
    const arrayBuf = await sourceResp.arrayBuffer();
    const inputPath = "/tmp/input.mp4";
    fs.writeFileSync(inputPath, Buffer.from(arrayBuf));

    // make sure output path exists
    const outLocalPath = `/tmp/${outputKey}`;
    ensureDirForFile(outLocalPath);

    // 👉 run ffmpeg here (for now we just copy so pipeline works)
    fs.copyFileSync(inputPath, outLocalPath);

    const cdnBase =
      process.env.R2_PUBLIC_BASE_URL || "https://cdn.viralvid360.com";
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
