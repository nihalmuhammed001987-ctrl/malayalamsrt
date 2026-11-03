const corsHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

const SYSTEM_PROMPT = `You are an expert Malayalam dialogue adapter and subtitle translator.
Translate English dialogue into natural, spoken Malabar-region Malayalam (Kerala, especially Kozhikode/Malabar).
This is NOT formal literary Malayalam and NOT word-for-word translation.
Rules:
- Use the previous and next subtitle lines only as context; translate only the current line. Preserve meaning, intent, emotion, humour, sarcasm, relationship, register and character voice.
- Use idiomatic everyday Malabar Malayalam when it naturally fits. Avoid mechanically inserting slang into every line.
- Prefer natural spoken Kerala Malayalam heard in everyday Malabar/Kozhikode conversations. Use locally natural phrasing without forcing stereotyped slang or caricaturing the dialect. Do not make every character sound identical.
- Do not translate names, brands, or intentional foreign words unless context requires it.
- Keep each subtitle concise and readable for on-screen timing. Avoid unnecessary English words when a natural Malayalam expression exists. Preserve useful line breaks; do not add explanations, notes, quotation marks, labels, or alternatives.
- Match the selected tone. "natural" means conversational, believable and moderately colloquial; not excessively rude or exaggerated.
- Translate profanity according to the source intensity and context; do not intensify it unnecessarily.
- Output ONLY a valid JSON object with a "translations" array, in exactly the same order and count as the input. Each array item must be a plain Malayalam subtitle string.
- Never include subtitle numbers or timestamps in translations.`;

class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function extractJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch {}
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
  throw new Error("AI response was not valid JSON.");
}

async function callGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, responseMimeType: "application/json" }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ProviderError(data.error?.message || `Gemini API error (${response.status}).`, response.status);
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("");
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}

async function callOpenAI(apiKey, model, prompt) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ProviderError(data.error?.message || `OpenAI API error (${response.status}).`, response.status);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned an empty response.");
  return text;
}

export async function onRequestPost({ request }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON request." }, 400); }

  const { provider, apiKey, model, dialect, tone, subtitles } = body || {};
  if (!["gemini", "openai"].includes(provider)) return json({ error: "Choose Gemini or OpenAI." }, 400);
  if (typeof apiKey !== "string" || apiKey.length < 10 || apiKey.length > 500) return json({ error: "Please provide a valid API key." }, 400);
  if (typeof model !== "string" || !/^[a-zA-Z0-9._:-]{2,100}$/.test(model)) return json({ error: "Invalid model name." }, 400);
  if (dialect !== "malabar") return json({ error: "Unsupported Malayalam dialect." }, 400);
  if (!["natural", "cinematic", "clean", "rough"].includes(tone)) return json({ error: "Unsupported dialogue tone." }, 400);
  if (!Array.isArray(subtitles) || subtitles.length < 1 || subtitles.length > 12) return json({ error: "Send between 1 and 12 subtitle entries per request." }, 400);
  if (subtitles.some((s, i) => !s || s.id !== i || typeof s.text !== "string" || !s.text.trim() || s.text.length > 2000)) {
    return json({ error: "Subtitle batch is invalid or too large." }, 400);
  }

  const toneText = {
    natural: "Natural, believable everyday conversation. Moderate colloquial Malabar Malayalam.",
    cinematic: "Expressive, cinematic dialogue while keeping the character's voice believable.",
    clean: "Clean conversational Malayalam with minimal regional slang.",
    rough: "Use stronger colloquial expressions only where the original dialogue and character justify them."
  }[tone];

  const prompt = `Translate the CURRENT subtitle lines into natural spoken Malabar Malayalam.
Selected style: ${toneText}
For each item, use previous and next lines to understand context, but do not translate those context lines unless they are also listed as current items.
Return exactly ${subtitles.length} strings in the translations array, matching input order. Do not omit short interjections. Do not invent dialogue.
Input JSON:
${JSON.stringify(subtitles.map(s => ({ id: s.id, previous: typeof s.previous === "string" ? s.previous : "", current: s.text, next: typeof s.next === "string" ? s.next : "" })))}`;

  try {
    const raw = provider === "gemini"
      ? await callGemini(apiKey, model, prompt)
      : await callOpenAI(apiKey, model, prompt);
    const parsed = extractJson(raw);
    if (!Array.isArray(parsed.translations) || parsed.translations.length !== subtitles.length ||
        parsed.translations.some(t => typeof t !== "string" || !t.trim())) {
      return json({ error: "AI returned an incomplete translation batch. Try again." }, 502);
    }
    return json({ translations: parsed.translations.map(t => t.trim()) });
  } catch (error) {
    const status = error instanceof ProviderError && [400, 401, 403, 404, 408, 429].includes(error.status) ? error.status : 502;
    return json({ error: error.message || "Translation provider request failed." }, status);
  }
}
