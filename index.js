const express = require("express");
const cors = require("cors");
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const { AssemblyAI } = require("assemblyai");
const cloudinary = require("cloudinary").v2;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Ping / Status ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "AutoEdit Server online ✅" }));
app.get("/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Download ─────────────────────────────────────────────────────────────────
app.post("/download", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL não informada." });

  try {
    let downloadUrl = url;

    // Google Drive
    const driveMatch = url.match(/\/d\/(.*?)(\/|$)/);
    if (driveMatch) {
      const fileId = driveMatch[1];
      downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    }

    // Dropbox
    if (url.includes("dropbox.com")) {
      downloadUrl = url.replace("www.dropbox.com", "dl.dropboxcontent.com").replace("?dl=0", "?dl=1");
    }

    const response = await axios({ url: downloadUrl, method: "GET", responseType: "stream" });

    const contentType = response.headers["content-type"] || "";
    const ext = contentType.includes("quicktime") ? "mov"
      : contentType.includes("mp4") ? "mp4"
      : contentType.includes("webm") ? "webm"
      : "mov";

    const filePath = path.join("/tmp", `video_${Date.now()}.${ext}`);
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    writer.on("finish", () => res.json({ success: true, filePath }));
    writer.on("error", (err) => res.status(500).json({ error: err.message }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Extrair Áudio ────────────────────────────────────────────────────────────
app.post("/extract-audio", (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: "filePath não informado." });

  const audioPath = filePath.replace(/\.(mp4|mov|avi|mkv|webm)$/i, ".mp3");

  ffmpeg(filePath)
    .output(audioPath)
    .audioCodec("libmp3lame")
    .audioBitrate("128k")
    .on("end", () => res.json({ success: true, audioPath }))
    .on("error", (err) => res.status(500).json({ error: err.message }))
    .run();
});

// ─── Transcrever ──────────────────────────────────────────────────────────────
app.post("/transcribe", async (req, res) => {
  const { audioPath } = req.body;
  if (!audioPath) return res.status(400).json({ error: "audioPath não informado." });

  try {
    const client = new AssemblyAI({ apiKey: ASSEMBLYAI_KEY });

    const transcript = await client.transcripts.transcribe({
      audio: fs.createReadStream(audioPath),
      language_code: "pt",
      speech_models: ["universal-2"],
      punctuate: true,
      format_text: true,
    });

    if (!transcript.words || transcript.words.length === 0) {
      return res.status(400).json({ error: "Nenhuma fala detectada no vídeo." });
    }

    // Agrupa palavras em segmentos por pausa
    const segments = transcript.words.reduce((acc, word) => {
      const last = acc[acc.length - 1];
      const pause = last ? word.start - last.endMs : 0;
      if (!last || pause > 1500) {
        acc.push({ startMs: word.start, endMs: word.end, text: word.text, words: [word] });
      } else {
        last.text += " " + word.text;
        last.endMs = word.end;
        last.words.push(word);
      }
      return acc;
    }, []);

    const hesitations = ["ééé", "hmm", "hm", "ah", "ahn", "éh", "ãh", "eh"];
    const processed = segments.map((seg, i) => ({
      id: i + 1,
      start: msToTime(seg.startMs),
      end: msToTime(seg.endMs),
      startMs: seg.startMs,
      endMs: seg.endMs,
      text: seg.text,
      keep: !hesitations.some(h => seg.text.toLowerCase().includes(h)) && seg.text.split(" ").length > 2,
      highlight: false,
    }));

    res.json({ success: true, segments: processed, fullText: transcript.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Destaques com Claude ─────────────────────────────────────────────────────
app.post("/highlights", async (req, res) => {
  const { segments, fullText } = req.body;
  if (!segments) return res.status(400).json({ error: "segments não informados." });

  try {
    const transcricao = fullText || segments.map(s => s.text).join(" ");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `Você é um especialista em criação de conteúdo para TikTok, Reels e Shorts.

Analise esta transcrição de vídeo e identifique exatamente 5 momentos ou frases de alto impacto para destacar visualmente.

Transcrição:
"${transcricao}"

Responda SOMENTE com um JSON válido, sem texto adicional, sem markdown, sem backticks. Formato:
{"highlights":[{"palavra":"frase exata do vídeo","tempo":"estimativa MM:SS","motivo":"por que é impactante"}]}`
        }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "{}";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { highlights: [] };
    }

    const highlights = (parsed.highlights || []).map((h, i) => ({
      id: i + 1,
      palavra: h.palavra,
      tempo: h.tempo || "--:--",
      motivo: h.motivo,
      aceito: true,
    }));

    res.json({ success: true, highlights });
  } catch (err) {
    // Fallback para lista básica se Claude falhar
    const impactWords = ["incrível", "nunca", "sempre", "segredo", "grátis", "rápido", "fácil", "melhor", "importante", "dica"];
    const highlights = segments.filter(s => s.keep)
      .filter(s => impactWords.some(w => s.text.toLowerCase().includes(w)))
      .slice(0, 5)
      .map((s, i) => ({
        id: i + 1,
        palavra: s.text.substring(0, 40),
        tempo: s.start,
        motivo: "Palavra de impacto identificada",
        aceito: true,
      }));
    res.json({ success: true, highlights });
  }
});

// ─── Exportar + Upload Cloudinary ─────────────────────────────────────────────
app.post("/export", async (req, res) => {
  const { filePath, segments, format } = req.body;
  if (!filePath || !segments) return res.status(400).json({ error: "Dados incompletos." });

  const keptSegments = segments.filter(s => s.keep);
  if (keptSegments.length === 0) return res.status(400).json({ error: "Nenhum segmento selecionado." });

  const ext = format || "mp4";
  const outputPath = path.join("/tmp", `edited_${Date.now()}.${ext}`);

  const filterParts = keptSegments.map((seg, i) =>
    `[0:v]trim=start=${seg.startMs / 1000}:end=${seg.endMs / 1000},setpts=PTS-STARTPTS[v${i}];` +
    `[0:a]atrim=start=${seg.startMs / 1000}:end=${seg.endMs / 1000},asetpts=PTS-STARTPTS[a${i}]`
  ).join(";");

  const concatV = keptSegments.map((_, i) => `[v${i}]`).join("");
  const concatA = keptSegments.map((_, i) => `[a${i}]`).join("");
  const fullFilter = `${filterParts};${concatV}concat=n=${keptSegments.length}:v=1:a=0[outv];${concatA}concat=n=${keptSegments.length}:v=0:a=1[outa]`;

  ffmpeg(filePath)
    .complexFilter(fullFilter)
    .outputOptions(["-map [outv]", "-map [outa]", "-c:v libx264", "-c:a aac", "-shortest"])
    .output(outputPath)
    .on("end", async () => {
      try {
        // Upload para Cloudinary
        const uploaded = await cloudinary.uploader.upload(outputPath, {
          resource_type: "video",
          folder: "autoedit",
          use_filename: true,
          unique_filename: true,
        });

        // Limpar arquivo local
        fs.unlink(outputPath, () => {});

        res.json({ success: true, downloadUrl: uploaded.secure_url, publicId: uploaded.public_id });
      } catch (uploadErr) {
        res.status(500).json({ error: "Erro no upload: " + uploadErr.message });
      }
    })
    .on("error", (err) => res.status(500).json({ error: err.message }))
    .run();
});

// ─── Gerar SRT ────────────────────────────────────────────────────────────────
app.post("/generate-srt", (req, res) => {
  const { legendas } = req.body;
  if (!legendas) return res.status(400).json({ error: "legendas não informadas." });

  const toSrtTime = (t) => {
    const [m, s] = t.split(":").map(Number);
    return `00:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},000`;
  };

  const srt = legendas.map((leg, i) =>
    `${i + 1}\n${toSrtTime(leg.start)} --> ${toSrtTime(leg.end)}\n${leg.text}`
  ).join("\n\n");

  res.json({ success: true, srt });
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function msToTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

app.listen(PORT, () => console.log(`✅ AutoEdit Server v2 rodando na porta ${PORT}`));
