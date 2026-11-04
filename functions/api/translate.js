
const corsHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, ...extraHeaders }
  });
}


const SYSTEM_PROMPT = `You are an expert Malayalam dialogue adapter and subtitle translator.
Translate English dialogue into natural, spoken Malayalam that sounds like real people talking in Kerala. Follow the selected Malayalam style and dialogue tone supplied with the request; use Malabar/Kozhikode Malayalam when that style is selected. Do not force regional slang when it does not fit.

Core dialogue rules:
- Preserve the exact meaning, intent, emotion, humour, sarcasm, subtext and character voice.
- Write natural, conversational Malayalam, not stiff, word-for-word or textbook Malayalam.
- Make each line sound like something a person would actually say in that situation.
- Preserve politeness, familiarity and emotional intensity only when the source dialogue or context clearly supports it.
- Keep subtitles concise and readable. Do not add information absent from the source.

Character and context accuracy — do not guess:
- Do NOT invent or assume a character's age, gender, relationship, social status, personality, or speaking situation.
- Use only details explicitly stated or strongly supported by the dialogue and surrounding subtitle context.
- Previous and next subtitle lines are context only. Translate only the current subtitle lines.
- If the relationship or ages are unclear, do not guess whether characters are friends, siblings, spouses, parent and child, or strangers.
- When uncertain, avoid unsupported terms of address such as ചേട്ടാ, ചേച്ചി, അമ്മേ, മോളേ, അച്ഛാ, സാർ, etc.
- Also avoid choosing overly familiar or overly respectful wording based on assumptions.
- Choose natural, neutral Malayalam that preserves meaning without forcing a relationship label, age-coded address, gender, or intimacy.
- Do not infer gender from a name, occupation, or assumed relationship.
- Do not add slang, insults, affection, honorifics or emotional meaning unsupported by the source.

Translation consistency:
- Keep names unchanged unless translation is necessary.
- Keep terminology and each character's speaking style consistent across supplied lines.
- Follow the selected dialogue tone without inventing character traits.
- Do not add explanations, notes, alternatives, or commentary.

Output requirements:
- Return ONLY valid JSON:
{"translations":["Malayalam subtitle 1","Malayalam subtitle 2"]}
- Return exactly the same number of translations as input, in the same order.
- Each translation must be a plain string.
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
async function checkRateLimit(request, env) {
  if (!env.RATE_LIMIT_KV) {
    return {
      allowed: false,
      error: "Rate limit storage is not configured."
    };
  }

  const ip = request.headers.get("CF-Connecting-IP");

  if (!ip) {
    return {
      allowed: false,
      error: "Unable to identify request source."
    };
  }

  const minute = Math.floor(Date.now() / 60000);

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ip)
  );

  const hash = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");

  const key = `translate:${hash}:${minute}`;

  const current = Number(await env.RATE_LIMIT_KV.get(key) || 0);

  if (current >= 60) {
    const retryAfter = Math.max(1, Math.ceil((60000 - (Date.now() % 60000)) / 1000));
    return {
      allowed: false,
      error: "Too many requests. Please wait before continuing.",
      retryAfter
    };
  }

  await env.RATE_LIMIT_KV.put(
    key,
    String(current + 1),
    { expirationTtl: 120 }
  );

  return { allowed: true };
}
export async function onRequestPost({ request, env }) {   const rateLimit = await checkRateLimit(request, env);

  if (!rateLimit.allowed) {
    return json(
      { error: rateLimit.error, retryAfter: rateLimit.retryAfter },
      429,
      rateLimit.retryAfter ? { "Retry-After": String(rateLimit.retryAfter) } : {}
    );
  }
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
        error: "AI returned an incomplete translation batch. Try again.",
        diagnostic: provider === "gemma" ? gemmaDiagnostic : undefined
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
