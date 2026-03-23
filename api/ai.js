export const config = { runtime: 'edge' };

function getCorsHeaders(req) {
  const origin = req.headers.get('origin');
  const sameOrigin = new URL(req.url).origin;

  const allowOrigin = !origin || origin === sameOrigin ? (origin || sameOrigin) : null;

  return {
    ok: !!allowOrigin,
    headers: {
      'Access-Control-Allow-Origin': allowOrigin || sameOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
      'Vary': 'Origin',
    },
  };
}

function json(req, data, status = 200) {
  const { headers } = getCorsHeaders(req);
  return new Response(JSON.stringify(data), { status, headers });
}

function stripCodeFences(text) {
  if (!text) return '';
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function normalizeArray(value, max = 4) {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 65;
  return Math.max(35, Math.min(98, Math.round(n)));
}

function normalizeResult(parsed, profile, trip, rawText = '') {
  const score = normalizeScore(parsed?.score);

  let title = String(parsed?.title || '').trim();
  if (!title) {
    title =
      score >= 80 ? 'Gran compatibilidad' :
      score >= 65 ? 'Buena compatibilidad' :
      score >= 50 ? 'Compatibilidad moderada' :
      'Compatibilidad básica';
  }

  let summary = String(parsed?.summary || '').trim();
  if (!summary) {
    summary = `Compatibilidad estimada entre tu perfil y el viaje a ${trip?.dest || 'este destino'}.`;
  }

  const pros = normalizeArray(parsed?.pros);
  const cons = normalizeArray(parsed?.cons);

  let advice = String(parsed?.advice || '').trim();
  if (!advice) {
    advice = rawText
      ? rawText.slice(0, 280)
      : 'Habla con el organizador y aclara presupuesto, ritmo y expectativas antes de unirte.';
  }

  return { score, title, summary, pros, cons, advice };
}

function buildPrompt(profile, trip) {
  return `
Eres un analista de compatibilidad para una app de compañeros de viaje.

Tu tarea es evaluar la compatibilidad entre un usuario y un viaje.
Responde SOLO con JSON válido.
No añadas explicaciones fuera del JSON.
No uses markdown.
No uses comillas tipográficas.

Devuelve exactamente este esquema:
{
  "score": number,
  "title": "string",
  "summary": "string",
  "pros": ["string", "string"],
  "cons": ["string", "string"],
  "advice": "string"
}

Reglas:
- score entre 35 y 98
- title debe ser breve
- summary máximo 180 caracteres
- pros máximo 4 elementos
- cons máximo 4 elementos
- advice máximo 220 caracteres
- responde en español
- sé útil, concreto y equilibrado
- valora intereses, estilo, bio, idiomas y coherencia general con el viaje
- si faltan datos, dilo de forma elegante en pros/cons/advice

DATOS DEL USUARIO:
${JSON.stringify(profile, null, 2)}

DATOS DEL VIAJE:
${JSON.stringify(trip, null, 2)}
`.trim();
}

export default async function handler(req) {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: cors.headers });
  }

  if (!cors.ok) {
    return json(req, { error: 'Origin not allowed' }, 403);
  }

  if (req.method !== 'POST') {
    return json(req, { error: 'Method not allowed' }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(req, { error: 'GEMINI_API_KEY not set' }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: 'Invalid JSON body' }, 400);
  }

  const profile = body?.profile;
  const trip = body?.trip;

  if (!profile || !trip) {
    return json(req, { error: 'profile and trip are required' }, 400);
  }

  const payload = {
    contents: [
      {
        parts: [
          {
            text: buildPrompt(profile, trip),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 700,
      responseMimeType: 'text/plain',
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return json(req, {
        error: 'Gemini request failed',
        details: data?.error?.message || 'Unknown upstream error',
      }, response.status);
    }

    const rawText =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part?.text || '')
        .join('')
        .trim() || '';

    let parsed;
    try {
      parsed = JSON.parse(stripCodeFences(rawText));
    } catch {
      parsed = null;
    }

    const result = normalizeResult(parsed, profile, trip, rawText);

    return json(req, result, 200);
  } catch (err) {
    clearTimeout(timeout);

    if (err?.name === 'AbortError') {
      return json(req, { error: 'Upstream timeout' }, 504);
    }

    return json(req, { error: 'Internal server error' }, 500);
  }
}
