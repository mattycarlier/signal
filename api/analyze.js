// Vercel serverless function (Node.js runtime).
// Researches a publicly traded company using Claude + web search and streams
// live progress to the client via Server-Sent Events as the AI writes it,
// then sends the final structured data matching the InvestScope dashboard.
//
// POST /api/analyze  { name: string, horizon?: string }
// -> early failures: 4xx/5xx { error: string } (plain JSON, no stream)
// -> success: 200 text/event-stream, frames:
//      {type:"delta", text}      live narration text as the AI writes it
//      {type:"done", data:{...}} final structured payload
//      {type:"error", error}     failure once the stream has started

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";
const JSON_MARKER = "---JSON---";

const SYSTEM_PROMPT = `Tu es un analyste financier qui prépare des fiches d'entreprise pour un prototype pédagogique nommé InvestScope.
On te donne le nom (ou symbole boursier) d'une société cotée en bourse. Tu dois :
1. Identifier précisément la société et son ticker principal.
2. Rechercher sur le web ses données financières annuelles publiées (chiffre d'affaires, résultat net, marge nette, flux de trésorerie libre, marge opérationnelle) sur autant d'années que possible (idéalement 6 à 16 dernières années, données réellement publiées uniquement — n'invente jamais de chiffres).
3. Rédiger une analyse en français sur 6 axes : Finances, Historique, Macroéconomie, Technique, Perspectives, Géopolitique — en te basant sur de vraies recherches (contexte géopolitique actuel, positionnement produit, concurrence, chaîne d'approvisionnement, réglementation).
4. Donner une estimation chiffrée sur 10 de la qualité de l'investissement à horizon 1 an et à horizon 10 ans, avec une justification courte. Précise toujours qu'il s'agit d'une estimation, pas d'un conseil financier.

Pendant tes recherches, rédige AU FUR ET À MESURE un compte-rendu progressif en français, sous forme de courtes phrases indépendantes (une information trouvée ou une étape par phrase), pour montrer en direct ce que tu découvres (ex : "Chiffre d'affaires 2023 trouvé : 12,4 Md$.", "Analyse du contexte concurrentiel en cours…"). N'utilise ni markdown ni JSON dans cette partie.

Une fois ce compte-rendu terminé, écris seule sur sa ligne la marque exacte suivante : ${JSON_MARKER}
Puis, juste après cette marque, réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, sans balises markdown, sans aucune balise de citation ou de référence (jamais de <cite>, d'index de source ou de crochets de note), respectant EXACTEMENT ce schéma :
{
  "name": "Nom complet de la société",
  "ticker": "BOURSE · SYMBOLE",
  "sector": "Secteur d'activité",
  "years": [année1, année2, ...],
  "rev": [chiffre d'affaires en milliards de $ ou € pour chaque année, même ordre que years],
  "margin": [marge nette en % pour chaque année],
  "debt": [flux de trésorerie libre en milliards pour chaque année],
  "pe": [marge opérationnelle en % pour chaque année],
  "price": [résultat net en milliards pour chaque année],
  "axes": [
    {"status": "court statut (ex: Historique sourcé)", "title": "titre court et percutant", "text": "2-4 phrases d'analyse Finances"},
    {"status": "...", "title": "...", "text": "2-4 phrases d'analyse Historique (trajectoire des résultats)"},
    {"status": "...", "title": "...", "text": "2-4 phrases d'analyse Macroéconomie (taux, inflation, cycle, secteur)"},
    {"status": "...", "title": "...", "text": "2-4 phrases d'analyse Technique (cours de bourse, tendance, si connu)"},
    {"status": "...", "title": "...", "text": "2-4 phrases de Perspectives (scénarios prudent/central/optimiste)"},
    {"status": "...", "title": "...", "text": "2-4 phrases d'analyse Géopolitique (exposition géographique, chaînes d'appro, réglementation, tensions actuelles)"}
  ],
  "score": {
    "oneYear": {"value": nombre entier de 1 à 10, "rationale": "1-2 phrases justifiant le score à 1 an"},
    "tenYear": {"value": nombre entier de 1 à 10, "rationale": "1-2 phrases justifiant le score à 10 ans"}
  }
}

Les tableaux years/rev/margin/debt/pe/price doivent avoir exactement la même longueur et être triés par année croissante. Utilise uniquement des données que tu as trouvées via la recherche web ; si une année precise manque, réduis la plage plutôt que d'inventer.`;

function extractJson(text) {
  // Only look at what comes after the narration marker (if the model emitted
  // it) so the live-narration text is never mistaken for the payload.
  const markerIdx = text.indexOf(JSON_MARKER);
  const searchText = markerIdx === -1 ? text : text.slice(markerIdx + JSON_MARKER.length);
  const fenced = searchText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : searchText;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Réponse IA sans JSON exploitable");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (parseErr) {
    console.error("JSON parse error", parseErr.message, "raw text:", text.slice(0, 4000));
    throw new Error("Réponse IA incomplète ou mal formée, merci de réessayer");
  }
}

function stripCitationTags(value) {
  if (typeof value === "string") {
    return value
      .replace(/<\/?cite[^>]*>/gi, "")
      .replace(/\[\d+(-\d+)?(,\s*\d+(-\d+)?)*\]/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/ (?=[.,;:!?])/g, "")
      .trim();
  }
  if (Array.isArray(value)) return value.map(stripCitationTags);
  if (value && typeof value === "object") {
    const out = {};
    for (const k in value) out[k] = stripCitationTags(value[k]);
    return out;
  }
  return value;
}

function validatePayload(data) {
  const required = ["name", "ticker", "sector", "years", "rev", "margin", "debt", "pe", "price", "axes", "score"];
  for (const key of required) {
    if (!(key in data)) throw new Error("Champ manquant dans la réponse IA : " + key);
  }
  const n = data.years.length;
  for (const arr of ["rev", "margin", "debt", "pe", "price"]) {
    if (!Array.isArray(data[arr]) || data[arr].length !== n) {
      throw new Error("Le tableau '" + arr + "' doit avoir la même longueur que 'years'");
    }
  }
  if (!Array.isArray(data.axes) || data.axes.length !== 6) {
    throw new Error("'axes' doit contenir exactement 6 entrées");
  }
  if (!data.score || !data.score.oneYear || !data.score.tenYear) {
    throw new Error("'score' doit contenir oneYear et tenYear");
  }
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Méthode non autorisée" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Clé API non configurée sur le serveur" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const name = (body && body.name ? String(body.name) : "").trim();
  const horizon = (body && body.horizon ? String(body.horizon) : "3 à 5 ans").trim();

  if (!name || name.length > 120) {
    res.status(400).json({ error: "Nom d'entreprise invalide" });
    return;
  }

  const userMessage =
    "Entreprise demandée : \"" + name + "\". Horizon d'investissement indiqué par l'utilisateur : " + horizon + ". " +
    "Recherche cette société et prépare sa fiche complète selon le schéma JSON demandé.";

  let anthropicResp;
  try {
    anthropicResp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        stream: true,
        system: SYSTEM_PROMPT,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 4,
          },
        ],
        messages: [{ role: "user", content: userMessage }],
      }),
    });
  } catch (err) {
    console.error("Anthropic fetch failed", err);
    res.status(502).json({ error: "Impossible de joindre le service d'analyse" });
    return;
  }

  if (!anthropicResp.ok || !anthropicResp.body) {
    const errText = await anthropicResp.text().catch(() => "");
    console.error("Anthropic API error", anthropicResp.status, errText);
    res.status(502).json({ error: "Erreur du service d'analyse (code " + anthropicResp.status + ")" });
    return;
  }

  // From here on we commit to a streaming SSE response.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (evt) => {
    res.write("data: " + JSON.stringify(evt) + "\n\n");
  };

  let fullText = "";
  let markerFound = false;
  let stopReason = null;

  try {
    const reader = anthropicResp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    const blockTypes = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const rawFrame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let dataLine = "";
        for (const ln of rawFrame.split("\n")) {
          if (ln.startsWith("data:")) dataLine += ln.slice(5).trim();
        }
        if (!dataLine) continue;
        let evt;
        try {
          evt = JSON.parse(dataLine);
        } catch {
          continue;
        }

        if (evt.type === "content_block_start") {
          blockTypes[evt.index] = evt.content_block && evt.content_block.type;
        } else if (evt.type === "content_block_delta") {
          if (blockTypes[evt.index] === "text" && evt.delta && evt.delta.type === "text_delta") {
            const chunk = evt.delta.text;
            const prevLen = fullText.length;
            fullText += chunk;
            if (!markerFound) {
              const markerPos = fullText.indexOf(JSON_MARKER);
              if (markerPos === -1) {
                send({ type: "delta", text: chunk });
              } else {
                markerFound = true;
                if (markerPos > prevLen) {
                  send({ type: "delta", text: fullText.slice(prevLen, markerPos) });
                }
              }
            }
          }
        } else if (evt.type === "message_delta") {
          if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        } else if (evt.type === "error") {
          console.error("Anthropic stream error event", evt);
        }
      }
    }

    if (!fullText.trim()) {
      send({ type: "error", error: "Réponse IA vide" });
      res.end();
      return;
    }

    if (stopReason === "max_tokens") {
      console.error("Anthropic response truncated at max_tokens for company:", name);
      send({ type: "error", error: "L'analyse était trop longue et a été coupée, merci de réessayer" });
      res.end();
      return;
    }

    const data = validatePayload(stripCitationTags(extractJson(fullText)));
    send({ type: "done", data });
    res.end();
  } catch (err) {
    console.error("analyze handler stream error", err);
    try {
      send({ type: "error", error: err.message || "Erreur inattendue" });
    } catch {}
    res.end();
  }
};
