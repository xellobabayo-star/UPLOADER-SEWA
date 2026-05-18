const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const { Readable } = require("stream");

ffmpeg.setFfmpegPath(ffmpegPath);

async function processAudio(inputBuffer, options = {}) {
  const { speed = 1.0, pitch = 0, normalize = true } = options;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const inputStream = new Readable();
    inputStream.push(inputBuffer);
    inputStream.push(null);

    const filterParts = [];

    if (speed !== 1.0) {
      filterParts.push(`atempo=${Math.min(Math.max(speed, 0.5), 2.0)}`);
    }
    if (pitch !== 0) {
      const semitones = Math.min(Math.max(pitch, -12), 12);
      const rate = Math.pow(2, semitones / 12);
      filterParts.push(`asetrate=44100*${rate},aresample=44100`);
    }
    if (normalize) {
      filterParts.push("dynaudnorm=f=150:g=15:r=0.9:p=0.95");
    }
    filterParts.push("aresample=44100:resampler=swr");

    const cmd = ffmpeg(inputStream)
      .inputFormat("mp3")
      .audioCodec("libmp3lame")
      .audioBitrate("320k")
      .audioChannels(2)
      .audioFrequency(44100)
      .outputFormat("mp3");

    if (filterParts.length > 0) {
      cmd.audioFilters(filterParts.join(","));
    }

    cmd
      .on("error", reject)
      .pipe()
      .on("data", chunk => chunks.push(chunk))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

async function uploadToRoblox(buffer, filename, apiKey, creatorType, userId, groupId, displayName, description) {
  const axios = require("axios");
  const FormData = require("form-data");

  const creator = creatorType === "group"
    ? { groupId: String(groupId) }
    : { userId: String(userId) };

  const asset = {
    assetType: "Audio",
    displayName: displayName || filename.replace(/\.[^.]+$/, ""),
    description: description || "Uploaded via Pendosa Bypass Audio",
    creationContext: { creator },
  };

  const form = new FormData();
  form.append("request", JSON.stringify(asset));
  form.append("fileContent", buffer, { filename, contentType: "audio/mpeg" });

  const res = await axios.post("https://apis.roblox.com/assets/v1/assets", form, {
    headers: { ...form.getHeaders(), "x-api-key": apiKey },
    maxBodyLength: Infinity,
  });

  const operationId = res.data?.operationId || res.data?.path?.split("/").pop();
  if (!operationId) throw new Error("Tidak dapat operationId dari Roblox");

  // Poll operation
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const op = await axios.get(`https://apis.roblox.com/assets/v1/operations/${operationId}`, {
      headers: { "x-api-key": apiKey },
    });
    if (op.data?.done) {
      const assetId = op.data?.response?.assetId || op.data?.response?.asset?.assetId;
      if (!assetId) throw new Error("operationId done tapi assetId tidak ditemukan");
      return String(assetId);
    }
    if (op.data?.error) throw new Error(op.data.error.message || "Roblox operation error");
  }
  throw new Error("Timeout menunggu Roblox memproses audio");
}

module.exports = { processAudio, uploadToRoblox };
