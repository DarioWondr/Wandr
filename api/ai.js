export const config = { runtime: 'edge' };

const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_OUTPUT_TOKENS = 700;
const MAX_TEXT_LENGTH = 12000;

function corsHeaders(req) {
  const requestOrigin = req.headers.get('origin');
  const sameOrigin = new URL(req.url).origin;
  const allowedOrigin = !requestOrigin || requestOrigin === sameOrigin ? (requestOrigin || sameOrigin) : null;

  return {
    ok: Boolean(allowedOrigin),
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin || sameOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
    },
  };
}

function json(req, data, status = 200) {
  const { headers } = corsHeaders(req);
  return new Response(JSON.stringify(data), { status, headers });
}

function safeString(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function safeArray(value, maxItems = 8, maxLen = 60) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => safeString(item, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function normalizeScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 65;
  return Math.max(35, Math.min(98, Math.round(n)));
}

function normalizeResult(parsed, profile, trip, rawText = '') {
  const score = normalizeScore(parsed?.score);

  const title = safeString(
    parsed?.title || (
      score >= 80 ? 'Gran compatibilidad' :
      score >= 65 ? 'Buena compatibilidad' :
      score >= 50 ? 'Compatibilidad moderada' :
      'Compatibilidad básica'
    ),
    80
  );

  const summary = safeString(
    parsed?.summary || `Compatibilidad estimada entre tu perfil y el viaje a ${trip?.dest || 'este destino'}.`,
    180
  );

  const pros = safeArray(parsed?.pros, 4, 120);
  const cons = safeArray(parsed?.cons, 4, 120);

  const advice = safeString(
    parsed?.advice || rawText || 'Hablad antes de confirmar para alinear expectativas, presupuesto y ritmo del viaje.',
    220
  );

  return { score, title, summary, pros, cons, advice };
}

function buildPayload(profile, trip) {
  const normalizedProfile = {
    full_name: safeString(profile?.full_name, 120),
    bio: safeString(profile?.bio, 500),
    style: safeString(profile?.style, 60),
    interests: safeArray(profile?.interests, 8, 40),
    languages: safeArray(profile?.languages, 6, 30),
    home_city: safeString(profile?.home_city, 80),
    age_range: safeString(profile?.age_range, 20),
  };

  const normalizedTrip = {
    id: safeString(trip?.id, 80),
    dest: safeString(trip?.dest, 120),
    region: safeString(trip?.region, 80),
    type: safeString(trip?.type, 40),
    desc: safeString(trip?.desc, 600),
    interests: safeArray(trip?.interests, 8, 40),
    start_date: safeString(trip?.start_date, 20),
    end_date: safeString(trip?.end_date, 20),
    organizer_name: safeString(trip?.organizer_name, 120),
  };

  const prompt = `
Eres un analista de compatibilidad para una app de compañeros de viaje.

Evalúa la compatibilidad entre un usuario y un viaje.
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
- title breve
- summary máximo 180 caracteres
- pros máximo 4 elementos
- cons máximo 4 elementos
- advice máximo 220 caracteres
- responde en español
- sé útil, concreto y equilibrado
- valora intereses, estilo, bio, idiomas y coherencia general con el viaje
- si faltan datos, indícalo de forma elegante

DATOS DEL USUARIO:
${JSON.stringify(normalizedProfile, null, 2)}

DATOS DEL VIAJE:
${JSON.stringify(normalizedTrip, null, 2)}
`.trim().slice(0, MAX_TEXT_LENGTH);

  return {
    profile: normalizedProfile,
    trip: normalizedTrip,
    prompt,
  };
}

export default async function handler(req) {
  const cors = corsHeaders(req);

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

  if (!body?.profile || !body?.trip) {
    return json(req, { error: 'profile and trip are required' }, 400);
  }

  const { profile, trip, prompt } = buildPayload(body.profile, body.trip);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            responseMimeType: 'text/plain',
          },
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timeout);

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      return json(
        req,
        {
          error: 'Gemini request failed',
          details: data?.error?.message || 'Unknown upstream error',
        },
        upstream.status
      );
    }

    const rawText = data?.candidates?.[0]?.content?.parts
      ?.map(part => safeString(part?.text, 1000))
      .join('')
      .trim() || '';

    let parsed;
    try {
      parsed = JSON.parse(stripCodeFences(rawText));
    } catch {
      parsed = null;
    }

    return json(req, normalizeResult(parsed, profile, trip, rawText), 200);
  } catch (err) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      return json(req, { error: 'Upstream timeout' }, 504);
    }
    return json(req, { error: 'Internal server error' }, 500);
  }
}
