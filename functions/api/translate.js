
const corsHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
}

const SYSTEM_PROMPT = `You are an expert Malayalam dialogue adapter and subtitle translator.
Translate English dialogue into natural, spoken Malabar-region Malayalam, especially Kozhikode Malayalam.

Rules:
- Preserve meaning, intent, emotion, humour, sarcasm and character voice.
- Use previous and next subtitle lines only as context.
- Translate only the current subtitle lines.
- Use natural everyday Malabar Malayalam without forcing slang.
- Keep subtitles concise and readable.
- Do not translate names unnecessarily.
- Do not add explanations or notes.
- Return ONLY valid JSON:
{"translations":["Malayalam subtitle 1","Malayalam subtitle 2"]}
- Return exactly the same number of translations as input.
- Never include subtitle numbers or timestamps.`;

class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function extractJson(text) {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  const first = cleaned.indexOf("{");

  if (first < 0) {
    throw new Error("AI response was not valid JSON.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = first; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;

      if (depth === 0) {
        return JSON.parse(cleaned.slice(first, i + 1));
      }
    }
  }

  throw new Error("AI response contains incomplete JSON.");
}

async function callGemini(apiKey, model, prompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: [{
        role: "user",
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.35,
        responseMimeType: "application/json"
      }
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ProviderError(
      data.error?.message || `Gemini API error (${response.status}).`,
      response.status
    );
  }

  const text = data.candidates?.[0]?.content?.parts
    ?.map(p => p.text || "")
    .join("");

  if (!text) throw new Error("Gemini returned an empty response.");

  return text;
}

async function callOpenAI(apiKey, model, prompt) {
  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ]
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ProviderError(
      data.error?.message || `OpenAI API error (${response.status}).`,
      response.status
    );
  }

  const text = data.choices?.[0]?.message?.content;

  if (!text) throw new Error("OpenAI returned an empty response.");

  return text;
}

async function callGemma(env, prompt) {
  if (!env.AI) {
    throw new Error("Workers AI binding AI is missing.");
  }

  const result = await env.AI.run(
    "@cf/google/gemma-4-26b-a4b-it",
    {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      temperature: 0.35,
      chat_template_kwargs: {
        enable_thinking: false
      }
    }
  );

  const text =
    typeof result === "string"
      ? result
      : result?.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error("Gemma returned an empty response.");
  }

  return text;
}

async function callIndicTrans2(env, subtitles) {
  if (!env.AI) {
    throw new Error("Workers AI binding AI is missing.");
  }

  const translations = [];

  for (const subtitle of subtitles) {
    const result = await env.AI.run(
      "@cf/ai4bharat/indictrans2-en-indic-1B",
      {
        text: subtitle.text,
        target_language: "mal_Mlym"
      }
    );

    const translatedText = result?.translations?.[0];

    if (
      typeof translatedText !== "string" ||
      !translatedText.trim()
    ) {
      throw new Error("IndicTrans2 returned an empty translation.");
    }

    translations.push(translatedText.trim());
  }

  return translations;
}

export async function onRequestPost({ request, env }) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  const {
    provider,
    apiKey,
    model,
    dialect,
    tone,
    subtitles
  } = body || {};

  const supportedProviders = [
    "gemini",
    "openai",
    "gemma",
    "indictrans2"
  ];

  if (!supportedProviders.includes(provider)) {
    return json({ error: "Unsupported AI provider." }, 400);
  }

  if (
    ["gemini", "openai"].includes(provider) &&
    (typeof apiKey !== "string" ||
      apiKey.length < 10 ||
      apiKey.length > 500)
  ) {
    return json({ error: "Please provide a valid API key." }, 400);
  }

  if (
    ["gemini", "openai"].includes(provider) &&
    (typeof model !== "string" ||
      !/^[a-zA-Z0-9._:-]{2,100}$/.test(model))
  ) {
    return json({ error: "Invalid model name." }, 400);
  }

  if (dialect !== "malabar") {
    return json({ error: "Unsupported Malayalam dialect." }, 400);
  }

  if (!["natural", "cinematic", "clean", "rough"].includes(tone)) {
    return json({ error: "Unsupported dialogue tone." }, 400);
  }

  if (
    !Array.isArray(subtitles) ||
    subtitles.length < 1 ||
    subtitles.length > 12
  ) {
    return json({
      error: "Send between 1 and 12 subtitle entries per request."
    }, 400);
  }

  if (
    subtitles.some((s, i) =>
      !s ||
      s.id !== i ||
      typeof s.text !== "string" ||
      !s.text.trim() ||
      s.text.length > 2000
    )
  ) {
    return json({
      error: "Subtitle batch is invalid or too large."
    }, 400);
  }

  const toneText = {
    natural: "Natural, believable everyday conversation. Moderate colloquial Malabar Malayalam.",
    cinematic: "Expressive cinematic dialogue while keeping character voices believable.",
    clean: "Clean conversational Malayalam with minimal regional slang.",
    rough: "Stronger colloquial expressions only where the original dialogue justifies them."
  }[tone];

  const prompt = `Translate the CURRENT subtitle lines into natural spoken Malabar Malayalam.

Selected style: ${toneText}

Use previous and next lines only as context.
Translate only the current lines.
Return exactly ${subtitles.length} strings in a translations array.
Do not omit short interjections or invent dialogue.

Input JSON:
${JSON.stringify(
  subtitles.map(s => ({
    id: s.id,
    previous: typeof s.previous === "string" ? s.previous : "",
    current: s.text,
    next: typeof s.next === "string" ? s.next : ""
  }))
)}`;

    try {
    let translations;
    let gemmaDiagnostic = "";

    if (provider === "indictrans2") {
      translations = await callIndicTrans2(env, subtitles);
    } else {
      let raw;

      if (provider === "gemma") {
       raw = await callGemma(env, prompt);
gemmaDiagnostic = String(raw).slice(0, 500);
      } else if (provider === "gemini") {
        raw = await callGemini(apiKey, model, prompt);
      } else {
        raw = await callOpenAI(apiKey, model, prompt);
      }

            try {
        const parsed = extractJson(raw);
        translations = parsed.translations;
      } catch (error) {
        if (provider !== "gemma" || subtitles.length !== 1) {
          throw error;
        }

        const plainText = raw.trim();

        if (!plainText) {
          throw error;
        }

        translations = [plainText];
      }
    }

    if (
      !Array.isArray(translations) ||
      translations.length !== subtitles.length ||
      translations.some(t => typeof t !== "string" || !t.trim())
    ) {
      return json({
        error: "AI returned an incomplete translation batch. Try again."
      }, 502);
    }

    return json({
      translations: translations.map(t => t.trim())
    });

  } catch (error) {
    const status =
      error instanceof ProviderError &&
      [400, 401, 403, 404, 408, 429].includes(error.status)
        ? error.status
        : 502;

    return json({
      error: error.message || "Translation provider request failed."
    }, status);
  }
}
