const $ = (id) => document.getElementById(id);
const state = { entries: [], translated: [], filename: "subtitles.srt", busy: false };

function parseSrt(raw) {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) throw new Error("The selected SRT file is empty.");
  const blocks = normalized.split(/\n{2,}/);
  const entries = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex(line => /^\s*\d{1,}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,}:\d{2}:\d{2}[,.]\d{3}/.test(line));
    if (timeIndex < 0) continue;
    const timing = lines[timeIndex].trim();
    const index = timeIndex > 0 && /^\d+$/.test(lines[timeIndex - 1].trim())
      ? lines[timeIndex - 1].trim() : String(entries.length + 1);
    const text = lines.slice(timeIndex + 1).join("\n").trim();
    if (!text) continue;
    entries.push({ index, timing, text });
  }
  if (!entries.length) throw new Error("No valid SRT subtitle entries found. Please check the file format.");
  return entries;
}

function buildSrt(entries, translations) {
  return entries.map((entry, i) => `${entry.index}\n${entry.timing}\n${translations[i] || entry.text}`).join("\n\n") + "\n";
}

function setStatus(message, kind = "") {
  $("status").textContent = message;
  $("status").className = `status ${kind}`;
}

function setProgress(done, total, label) {
  const pct = total ? Math.round(done / total * 100) : 0;
  $("progressArea").hidden = false;
  $("progressText").textContent = label;
  $("progressPct").textContent = `${pct}%`;
  $("progressBar").style.width = `${pct}%`;
}

function renderPreview() {
  $("preview").innerHTML = "";
  state.entries.slice(0, 80).forEach((entry, i) => {
    const item = document.createElement("article");
    item.className = "preview-item";
    const time = document.createElement("div");
    time.className = "preview-time";
    time.textContent = `${entry.index}  ·  ${entry.timing}`;
    const content = document.createElement("div");
    content.className = "preview-text";
    content.textContent = state.translated[i] || "";
    item.append(time, content);
    $("preview").append(item);
  });
  if (state.entries.length > 80) {
    const more = document.createElement("p");
    more.className = "status";
    more.textContent = `Showing first 80 of ${state.entries.length} translated entries. The downloaded file contains all entries.`;
    $("preview").append(more);
  }
}

function updateProvider() {
  const isGemini = $("provider").value === "gemini";
  $("keyLabel").textContent = isGemini ? "Gemini API key" : "OpenAI API key";
  $("model").value = isGemini ? "gemini-2.5-flash" : "gpt-4.1-mini";
  $("modelHint").textContent = isGemini ? "Default Gemini model · change if needed" : "Default OpenAI model · change if needed";
  $("apiKey").placeholder = isGemini ? "Paste your Gemini API key" : "Paste your OpenAI API key";
}

$("provider").addEventListener("change", updateProvider);
$("toggleKey").addEventListener("click", () => {
  const input = $("apiKey");
  input.type = input.type === "password" ? "text" : "password";
  $("toggleKey").textContent = input.type === "password" ? "Show" : "Hide";
});

function loadFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".srt")) {
    setStatus("Please choose an .srt file.", "error");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state.entries = parseSrt(String(reader.result || ""));
      state.translated = [];
      state.filename = file.name.replace(/\.srt$/i, "");
      $("fileTitle").textContent = file.name;
      $("fileSub").textContent = `${state.entries.length} subtitle entries detected`;
      $("fileMeta").hidden = false;
      $("fileMeta").textContent = `${(file.size / 1024).toFixed(1)} KB · ${state.entries.length} subtitle entries`;
      $("translateBtn").disabled = false;
      $("result").hidden = true;
      $("progressArea").hidden = true;
      setStatus("SRT file loaded. Check your AI provider and API key, then translate.", "success");
    } catch (error) {
      state.entries = [];
      $("translateBtn").disabled = true;
      setStatus(error.message, "error");
    }
  };
  reader.onerror = () => setStatus("Could not read this file.", "error");
  reader.readAsText(file, "UTF-8");
}

$("srtFile").addEventListener("change", e => loadFile(e.target.files[0]));
const dropzone = $("dropzone");
["dragenter", "dragover"].forEach(name => dropzone.addEventListener(name, e => {
  e.preventDefault(); dropzone.classList.add("drag");
}));
["dragleave", "drop"].forEach(name => dropzone.addEventListener(name, e => {
  e.preventDefault(); dropzone.classList.remove("drag");
}));
dropzone.addEventListener("drop", e => loadFile(e.dataTransfer.files[0]));

async function translateBatch(entries, config, startIndex) {
  const subtitles = entries.map((entry, i) => ({
    id: i,
    text: entry.text,
    previous: state.entries[startIndex + i - 1]?.text || "",
    next: state.entries[startIndex + i + 1]?.text || ""
  }));

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, subtitles })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || `Translation request failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      if (!Array.isArray(data.translations) || data.translations.length !== entries.length) {
        throw new Error("The AI returned an unexpected number of translations. Please retry this batch.");
      }
      return data.translations;
    } catch (error) {
      lastError = error;
      const retryable = !error.status || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 3) break;
      const delay = Math.min(12000, 1500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 500);
      setStatus(`Temporary API issue. Retrying batch in ${Math.ceil(delay / 1000)} seconds (attempt ${attempt + 1}/3)…`, "warning");
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error("Translation failed.");
}

$("translateBtn").addEventListener("click", async () => {
  if (state.busy || !state.entries.length) return;
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) { setStatus("Please enter your API key.", "error"); $("apiKey").focus(); return; }
  const provider = $("provider").value;
  const model = $("model").value.trim();
  if (!model) { setStatus("Please enter a model name.", "error"); return; }

  state.busy = true;
  $("translateBtn").disabled = true;
  $("result").hidden = true;
  if (state.translated.length !== state.entries.length) state.translated = new Array(state.entries.length);
  const batchSize = 12;
  const pendingCount = state.translated.filter(value => !value).length;
  const totalBatches = Math.ceil(pendingCount / batchSize);
  const config = { provider, apiKey, model, dialect: $("dialect").value, tone: $("tone").value };
  try {
    let completed = state.translated.filter(Boolean).length;
    let batchNo = 0;
    for (let start = 0; start < state.entries.length; start += batchSize) {
      const indexes = [];
      for (let i = start; i < Math.min(start + batchSize, state.entries.length); i++) {
        if (!state.translated[i]) indexes.push(i);
      }
      if (!indexes.length) continue;
      const batch = indexes.map(i => state.entries[i]);
      batchNo++;
      setProgress(completed, state.entries.length, `Translating batch ${batchNo} of ${totalBatches}…`);
      const translated = await translateBatch(batch, config, indexes[0]);
      translated.forEach((text, i) => { state.translated[indexes[i]] = String(text); });
      completed += batch.length;
      setProgress(completed, state.entries.length, `Translated ${completed} of ${state.entries.length} subtitles`);
    }
    $("result").hidden = false;
    $("resultInfo").textContent = `${state.entries.length} subtitles translated · ${provider === "gemini" ? "Google Gemini" : "OpenAI"}`;
    renderPreview();
    setStatus("Translation complete. Review the preview and download your Malayalam SRT.", "success");
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    const completed = state.translated.filter(Boolean).length;
    setStatus(`${error.message || "Translation failed."} ${completed} of ${state.entries.length} subtitles are saved in this page. Press Translate again to resume the remaining entries.`, "error");
    $("progressText").textContent = `Paused · ${completed}/${state.entries.length} completed`;
  } finally {
    state.busy = false;
    $("translateBtn").disabled = false;
    // Do not retain the API key in the form after the operation.
    $("apiKey").value = "";
  }
});

$("downloadBtn").addEventListener("click", () => {
  if (!state.translated.length) return;
  const blob = new Blob(["\uFEFF", buildSrt(state.entries, state.translated)], { type: "application/x-subrip;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.filename}-malayalam.srt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
