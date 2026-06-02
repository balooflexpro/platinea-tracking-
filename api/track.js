const https = require('https');
const crypto = require('crypto');

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const numero = req.query.numero;
  if (!numero) return res.status(400).json({ error: 'Numéro manquant' });

  const CODE = process.env.MR_CODE_ENSEIGNE;
  const CLE = process.env.MR_CLE_API;

  const hash = crypto.createHash('md5')
    .update(CODE + numero + 'FR' + CLE)
    .digest('hex').toUpperCase();

  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
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
      'SOAPAction': 'http://www.mondialrelay.fr/webservice/WSI2_GetExpeditionsByExpeditions',
      'Content-Length': Buffer.byteLength(soap)
    }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      function extract(tag) {
        const m = data.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
        return m ? m[1].trim() : '';
      }

      function extractEvents(xml) {
        const events = [];
        const matches = xml.match(/<Evenement>[\s\S]*?<\/Evenement>/gi) || [];
        matches.slice(0, 6).forEach(block => {
          const date = extract('Date') || '';
          const heure = extract('Heure') || '';
          const libelle = extract('Libelle') || '';
          const lieu = extract('Lieu') || '';
          if (libelle) events.push({ date, heure, libelle, lieu });
        });
        return events;
      }

      function getStep(code) {
        const n = parseInt(code) || 0;
        if (n === 0) return 0;
        if (n < 30) return 1;
        if (n < 60) return 2;
        if (n < 80) return 3;
        return 4;
      }

      const statut = extract('Libelle') || extract('StatutLibelle') || 'Inconnu';
      const code = extract('STAT') || extract('Statut') || '0';

      res.status(200).json({
        numero,
        statut,
        code,
        step: getStep(code),
        destinataire: extract('Destinataire'),
        poids: extract('Poids'),
        pointRelais: extract('PointRelais'),
        dateLivraison: extract('DateLivraison'),
        dateCreation: extract('DateCreation'),
        evenements: extractEvents(data),
        raw: data.length > 0
      });
    });
  });

  request.on('error', e => res.status(500).json({ error: e.message }));
  request.write(soap);
  request.end();
}
