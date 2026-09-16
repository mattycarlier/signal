// Vercel serverless function (Node.js runtime).
// Researches a publicly traded company using Claude + web search and returns
// structured data matching the shape the InvestScope dashboard renders.
//
// POST /api/analyze  { name: string, horizon?: string }
// -> 200 { name, ticker, sector, years, rev, margin, debt, pe, price, axes, score }
// -> 4xx/5xx { error: string }

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `Tu es un analyste financier qui prépare des fiches d'entreprise pour un prototype pédagogique nommé InvestScope.
On te donne le nom (ou symbole boursier) d'une société cotée en bourse. Tu dois :
1. Identifier précisément la société et son ticker principal.
2. Rechercher sur le web ses données financières annuelles publiées (chiffre d'affaires, résultat net, marge nette, flux de trésorerie libre, marge opérationnelle) sur autant d'années que possible (idéalement 6 à 16 dernières années, données réellement publiées uniquement — n'invente jamais de chiffres).
3. Rédiger une analyse en français sur 6 axes : Finances, Historique, Macroéconomie, Technique, Perspectives, Géopolitique — en te basant sur de vraies recherches (contexte géopolitique actuel, positionnement produit, concurrence, chaîne d'approvisionnement, réglementation).
4. Donner une estimation chiffrée sur 10 de la qualité de l'investissement à horizon 1 an et à horizon 10 ans, avec une justification courte. Précise toujours qu'il s'agit d'une estimation, pas d'un conseil financier.

Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, sans balises markdown, respectant EXACTEMENT ce schéma :
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
  // Strip markdown fences if present, then find the outermost { ... } block.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Réponse IA sans JSON exploitable");
  }
  return JSON.parse(candidate.slice(start, end + 1));
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

  try {
    const anthropicResp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
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

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      console.error("Anthropic API error", anthropicResp.status, errText);
      res.status(502).json({ error: "Erreur du service d'analyse (code " + anthropicResp.status + ")" });
      return;
    }

    const payload = await anthropicResp.json();
    const textBlocks = (payload.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (!textBlocks.trim()) {
      res.status(502).json({ error: "Réponse IA vide" });
      return;
    }

    const data = validatePayload(extractJson(textBlocks));
    res.status(200).json(data);
  } catch (err) {
    console.error("analyze handler error", err);
    res.status(500).json({ error: err.message || "Erreur inattendue" });
  }
}
