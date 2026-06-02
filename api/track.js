import https from 'https';
import crypto from 'crypto';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const numero = req.query.numero;
  if (!numero) return res.status(400).json({ error: 'Numéro manquant' });

  const CODE = process.env.MR_CODE_ENSEIGNE;
  const CLE = process.env.MR_CLE_API;

  // Formule hash exacte Mondial Relay
  const hashInput = `${CODE}${numero}FR${CLE}`;
  const hash = crypto.createHash('md5')
    .update(hashInput)
    .digest('hex')
    .toUpperCase();

  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <WSI2_GetExpeditionsByExpeditions xmlns="http://www.mondialrelay.fr/webservice/">
      <Enseigne>${CODE}</Enseigne>
      <Expeditions>${numero}</Expeditions>
      <Language>FR</Language>
      <Security>${hash}</Security>
    </WSI2_GetExpeditionsByExpeditions>
  </soap:Body>
</soap:Envelope>`;

  const options = {
    hostname: 'api.mondialrelay.com',
    path: '/Web_Services.asmx',
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': '"http://www.mondialrelay.fr/webservice/WSI2_GetExpeditionsByExpeditions"',
      'Content-Length': Buffer.byteLength(soap)
    }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {

      console.log('RAW RESPONSE:', data);

      function extract(xml, tag) {
        const patterns = [
          new RegExp(`<${tag}>([^<]*)<\/${tag}>`, 'i'),
          new RegExp(`<${tag} [^>]*>([^<]*)<\/${tag}>`, 'i'),
        ];
        for (const p of patterns) {
          const m = xml.match(p);
          if (m && m[1].trim()) return m[1].trim();
        }
        return '';
      }

      function extractEvents(xml) {
        const events = [];
        const blocks = xml.match(/<Evenement>[\s\S]*?<\/Evenement>/gi) || [];
        blocks.forEach(block => {
          const date = extract(block, 'Date');
          const heure = extract(block, 'Heure');
          const libelle = extract(block, 'Libelle');
          const lieu = extract(block, 'Lieu');
          if (libelle) events.push({ date, heure, libelle, lieu });
        });
        return events.slice(0, 8);
      }

      function getStep(evenements, code) {
        if (!evenements || evenements.length === 0) return 1;
        const dernierEvent = evenements[0]?.libelle?.toLowerCase() || '';
        if (dernierEvent.includes('livr') || dernierEvent.includes('remis')) return 4;
        if (dernierEvent.includes('relais') || dernierEvent.includes('point')) return 3;
        if (dernierEvent.includes('transit') || dernierEvent.includes('cours') || dernierEvent.includes('charg')) return 2;
        return 1;
      }

      // Vérifier si erreur
      const statCode = extract(data, 'STAT');
      if (statCode && statCode !== '0') {
        return res.status(200).json({
          error: true,
          message: 'Colis introuvable — code: ' + statCode,
          raw: data.substring(0, 300)
        });
      }

      const evenements = extractEvents(data);
      const statut = evenements.length > 0 ? evenements[0].libelle : (extract(data, 'Libelle') || 'En cours');

      res.status(200).json({
        numero,
        statut,
        step: getStep(evenements),
        destinataire: extract(data, 'Destinataire'),
        poids: extract(data, 'Poids'),
        pointRelais: extract(data, 'PointRelais'),
        dateLivraison: extract(data, 'DateLivraison'),
        dateCreation: extract(data, 'DateCreation'),
        evenements,
        raw: data.length > 100,
        fullResponse: data
      });
    });
  });

  request.on('error', e => res.status(500).json({ error: e.message }));
  request.write(soap);
  request.end();
}
