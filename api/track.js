const https = require('https');
const crypto = require('crypto');

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const numero = req.query.numero;
  if (!numero) return res.status(400).json({ error: 'Numéro manquant' });

  const CODE = process.env.MR_CODE_ENSEIGNE;
  const CLE = process.env.MR_CLE_API;

  // Formule exacte Mondial Relay pour WSI2_GetExpeditionsByExpeditions
  const hashInput = CODE + numero + 'FR' + '' + CLE;
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

      // Log pour debug
      console.log('MR Response:', data.substring(0, 500));

      function extract(xml, tag) {
        const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i'));
        return m ? m[1].trim() : '';
      }

      function extractAllEvents(xml) {
        const events = [];
        const regex = /<Evenement>([\s\S]*?)<\/Evenement>/gi;
        let match;
        while ((match = regex.exec(xml)) !== null) {
          const block = match[1];
          const date = extract(block, 'Date');
          const heure = extract(block, 'Heure');
          const libelle = extract(block, 'Libelle');
          const lieu = extract(block, 'Lieu');
          if (libelle) events.push({ date, heure, libelle, lieu });
        }
        return events.slice(0, 6);
      }

      function getStep(statut) {
        const s = statut.toLowerCase();
        if (s.includes('livr') || s.includes('remis')) return 4;
        if (s.includes('relais') || s.includes('point')) return 3;
        if (s.includes('transit') || s.includes('cours')) return 2;
        if (s.includes('pris') || s.includes('charg') || s.includes('enregistr')) return 1;
        return 0;
      }

      const statut = extract(data, 'Libelle') || extract(data, 'StatutLibelle') || 'En cours';
      const code = extract(data, 'STAT') || '0';
      const evenements = extractAllEvents(data);

      res.status(200).json({
        numero,
        statut,
        code,
        step: getStep(statut),
        destinataire: extract(data, 'Destinataire'),
        poids: extract(data, 'Poids'),
        pointRelais: extract(data, 'PointRelais'),
        dateLivraison: extract(data, 'DateLivraison'),
        dateCreation: extract(data, 'DateCreation'),
        evenements,
        raw: data.length > 100,
        debug: data.substring(0, 200)
      });
    });
  });

  request.on('error', e => {
    res.status(500).json({ error: e.message });
  });

  request.write(soap);
  request.end();
}
