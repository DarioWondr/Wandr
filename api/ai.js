export const config = { runtime: 'edge' };

const ALLOWED_ORIGIN = 'https://tu-dominio.com';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const ALLOWED_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];
const MAX_INPUT_CHARS = 12000;
const MAX_OUTPUT_TOKENS = 1200;

function corsHeaders(origin) {
  const allowedOrigin = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(origin),
  });
}

function extractText(input) {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0, MAX_INPUT_CHARS);
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || ALLOWED_ORIGIN;

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(origin) });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, origin);
  }

  if (origin !== ALLOWED_ORIGIN) {
    return json({ error: 'Origin not allowed' }, 403, origin);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: 'Server misconfigured' }, 500, origin);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, origin);
  }

  const prompt = extractText(body?.prompt);
  if (!prompt) {
    return json({ error: 'prompt is required' }, 400, origin);
  }

  const model =
    typeof body?.model === 'string' && ALLOWED_MODELS.includes(body.model)
      ? body.model
      : DEFAULT_MODEL;

  const maxOutputTokens =
    Number.isInteger(body?.maxOutputTokens) && body.maxOutputTokens > 0
      ? Math.min(body.maxOutputTokens, MAX_OUTPUT_TOKENS)
      : 600;

  const payload = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens,
      temperature: 0.7,
    },
  };

  if (typeof body?.system === 'string' && body.system.trim()) {
    payload.systemInstruction = {
      parts: [{ text: body.system.trim().slice(0, 4000) }],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return json(
        {
          error: 'Gemini request failed',
          details: data?.error?.message || 'Unknown upstream error',
        },
        response.status,
        origin
      );
    }

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text || '')
        .join('')
        .trim() || '';

    return json({ text, raw: data }, 200, origin);
  } catch (err) {
    clearTimeout(timeout);
    const isAbort = err?.name === 'AbortError';

    return json(
      { error: isAbort ? 'Upstream timeout' : 'Internal server error' },
      isAbort ? 504 : 500,
      origin
    );
  }
}
