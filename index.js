const express = require("express");
const cors = require("cors");
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const { AssemblyAI } = require("assemblyai");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_KEY;

// ─── Rota de status ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "AutoEdit Server online ✅" });
});

// ─── Baixar vídeo do Drive/Dropbox ────────────────────────────────────────────
app.post("/download", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL não informada." });

  try {
    // Normaliza link do Google Drive
    let downloadUrl = url;
    const driveMatch = url.match(/\/d\/(.*?)(\/|$)/);
    if (driveMatch) {
      const fileId = driveMatch[1];
      // Usa a URL de download direto contornando o aviso do Drive
      downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    }
    // Normaliza link do Dropbox
    if (url.includes('dropbox.com')) {
      downloadUrl = url.replace('www.dropbox.com', 'dl.dropboxcontent.com').replace('?dl=0', '?dl=1');
    }

    const response = await axios({ url: downloadUrl, method: "GET", responseType: "stream" });
    // Detecta extensão pelo Content-Type ou usa mov como fallback
    const contentType = response.headers['content-type'] || '';
    const ext = contentType.includes('quicktime') ? 'mov' : contentType.includes('mp4') ? 'mp4' : 'mov';
    const filePath = path.join("/tmp", `video_${Date.now()}.${ext}`);
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    writer.on("finish", () => res.json({ success: true, filePath }));
    writer.on("error", (err) => res.status(500).json({ error: err.message }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Extrair áudio do vídeo ───────────────────────────────────────────────────
app.post("/extract-audio", (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: "filePath não informado." });

  const audioPath = filePath.replace(/\.(mp4|mov|avi|mkv)$/i, ".mp3");

  ffmpeg(filePath)
    .output(audioPath)
    .audioCodec("libmp3lame")
    .audioBitrate("128k")
    .on("end", () => res.json({ success: true, audioPath }))
    .on("error", (err) => res.status(500).json({ error: err.message }))
    .run();
});

// ─── Transcrever com AssemblyAI ───────────────────────────────────────────────
app.post("/transcribe", async (req, res) => {
  const { audioPath } = req.body;
  if (!audioPath) return res.status(400).json({ error: "audioPath não informado." });

  try {
    const client = new AssemblyAI({ apiKey: ASSEMBLYAI_KEY });

    const transcript = await client.transcripts.transcribe({
      audio: fs.createReadStream(audioPath),
      language_code: "pt",
      punctuate: true,
      format_text: true,
    });

    // Monta segmentos com timestamps
    const segments = transcript.words.reduce((acc, word, i) => {
      const last = acc[acc.length - 1];
      const pause = last ? (word.start - last.endMs) : 0;

      // Novo segmento se pausa > 1.5s ou início
      if (!last || pause > 1500) {
        acc.push({ startMs: word.start, endMs: word.end, text: word.text, words: [word] });
      } else {
        last.text += " " + word.text;
        last.endMs = word.end;
        last.words.push(word);
      }
      return acc;
    }, []);

    // Marca segmentos de silêncio/hesitação
    const hesitations = ["ééé", "hmm", "hm", "ah", "ahn", "éh"];
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

// ─── Gerar destaques com IA simples ───────────────────────────────────────────
app.post("/highlights", (req, res) => {
  const { segments } = req.body;
  if (!segments) return res.status(400).json({ error: "segments não informados." });

  const impactWords = ["incrível", "nunca", "sempre", "segredo", "grátis", "rápido", "fácil", "melhor", "pior", "top", "importante", "essencial", "dica", "erro", "cuidado"];

  const highlights = segments
    .filter(s => s.keep)
    .filter(s => impactWords.some(w => s.text.toLowerCase().includes(w)))
    .map(s => ({
      id: s.id,
      palavra: impactWords.find(w => s.text.toLowerCase().includes(w)),
      tempo: s.start,
      motivo: "Palavra de alto impacto identificada",
      aceito: true,
    }));

  res.json({ success: true, highlights });
});

// ─── Montar vídeo final com cortes ────────────────────────────────────────────
app.post("/export", (req, res) => {
  const { filePath, segments } = req.body;
  if (!filePath || !segments) return res.status(400).json({ error: "Dados incompletos." });

  const keptSegments = segments.filter(s => s.keep);
  if (keptSegments.length === 0) return res.status(400).json({ error: "Nenhum segmento selecionado." });

  const outputPath = filePath.replace(".mp4", `_edited_${Date.now()}.mp4`);
  const listPath = `/tmp/segments_${Date.now()}.txt`;

  // Gera arquivo de lista de segmentos para FFmpeg
  const filterComplex = keptSegments.map((seg, i) =>
    `[0:v]trim=start=${seg.startMs / 1000}:end=${seg.endMs / 1000},setpts=PTS-STARTPTS[v${i}];` +
    `[0:a]atrim=start=${seg.startMs / 1000}:end=${seg.endMs / 1000},asetpts=PTS-STARTPTS[a${i}]`
  ).join(";");

  const concatV = keptSegments.map((_, i) => `[v${i}]`).join("");
  const concatA = keptSegments.map((_, i) => `[a${i}]`).join("");
  const fullFilter = `${filterComplex};${concatV}concat=n=${keptSegments.length}:v=1:a=0[outv];${concatA}concat=n=${keptSegments.length}:v=0:a=1[outa]`;

  ffmpeg(filePath)
    .complexFilter(fullFilter)
    .outputOptions(["-map [outv]", "-map [outa]", "-c:v libx264", "-c:a aac", "-shortest"])
    .output(outputPath)
    .on("end", () => res.json({ success: true, outputPath }))
    .on("error", (err) => res.status(500).json({ error: err.message }))
    .run();
});

// ─── Gerar SRT de legendas ────────────────────────────────────────────────────
app.post("/generate-srt", (req, res) => {
  const { legendas } = req.body;
  if (!legendas) return res.status(400).json({ error: "legendas não informadas." });

  const srt = legendas.map((leg, i) => (
    `${i + 1}\n${leg.start.replace(".", ",")} --> ${leg.end.replace(".", ",")}\n${leg.text}\n`
  )).join("\n");

  res.json({ success: true, srt });
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function msToTime(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

app.listen(PORT, () => console.log(`✅ AutoEdit Server rodando na porta ${PORT}`));
