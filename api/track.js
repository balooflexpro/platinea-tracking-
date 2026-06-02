import https from 'https';
import crypto from 'crypto';

export default function handler(req, res) {
  // Gestion des CORS pour ton site Shopify
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const numero = req.query.numero;
  const codePostal = req.query.cp || '';

  if (!numero) return res.status(400).json({ error: 'Numéro manquant' });

  const CODE = process.env.MR_CODE_ENSEIGNE;
  const CLE = process.env.MR_CLE_API;

  if (!CODE || !CLE) {
    return res.status(500).json({ error: true, message: "Variables d'environnement manquantes sur Vercel." });
  }

  // Clé de sécurité pour WSI3_GetExpeditions : Enseigne + Numéro + Clé
  const hashInput = CODE + numero + CLE;
  const hash = crypto.createHash('md5')
    .update(hashInput)
    .digest('hex')
    .toUpperCase();

  // Enveloppe SOAP
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <WSI3_GetExpeditions xmlns="http://www.mondialrelay.fr/webservice/">
      <Enseigne>${CODE}</Enseigne>
      <Expedition>${numero}</Expedition>
      <Langue>FR</Langue>
      <Security>${hash}</Security>
    </WSI3_GetExpeditions>
  </soap:Body>
</soap:Envelope>`;

  const options = {
    hostname: 'www.mondialrelay.fr',
    path: '/webservice/Web_Services.asmx',
    method: 'POST',
    headers: {
      'Host': 'www.mondialrelay.fr',
      'Content-Type': 'text/xml; charset=utf-8',
      // CRUCIAL : Les guillemets doubles doivent être envoyés AU SERVEUR. 
      // On utilise \"...\" pour qu'ils fassent partie intégrante de la valeur reçue par Mondial Relay.
      'SOAPAction': '"http://www.mondialrelay.fr/webservice/WSI3_GetExpeditions"',
      'Content-Length': Buffer.byteLength(soap)
    }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      
      function extract(xml, tag) {
        const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)<\/${tag}>`, 'i'));
        return m ? m[1].trim() : '';
      }

      function extractEvents(xml) {
        const events = [];
        const blocks = xml.match(/<View_AnomalieEvenement>[\s\S]*?<\/View_AnomalieEvenement>/gi) || [];
        
        blocks.forEach(block => {
          const date = extract(block, 'Date');
          const heure = extract(block, 'Heure');
          const libelle = extract(block, 'Libelle');
          if (libelle) {
            events.push({ 
              date: date, 
              heure: heure, 
              libelle: libelle, 
              lieu: '' 
            });
          }
        });
        return events;
      }

      function getStep(evenements, statCode) {
        if (statCode === '80' || statCode === '81' || statCode === '82') return 4;
        if (!evenements || evenements.length === 0) return 0;
        
        const dernier = evenements[0]?.libelle?.toLowerCase() || '';
        if (dernier.includes('livr') || dernier.includes('remis') || dernier.includes('distribu')) return 4;
        if (dernier.includes('relais') || dernier.includes('point') || dernier.includes('disponible')) return 3;
        if (dernier.includes('transit') || dernier.includes('cours') || dernier.includes('tri') || dernier.includes('acheminement')) return 2;
        return 1;
      }

      if (data.includes('soap:Fault')) {
        return res.status(200).json({ error: true, message: extract(data, 'faultstring') });
      }

      const statCode = extract(data, 'STAT');
      const codesValides = ['0', '80', '81', '82', '83'];
      if (statCode && !codesValides.includes(statCode)) {
        return res.status(200).json({ error: true, message: 'Colis introuvable ou numéro incorrect.', code: statCode });
      }

      const evenements = extractEvents(data);
      
      let statut = 'En cours de traitement';
      if (evenements.length > 0) {
        statut = evenements[0].libelle;
      } else if (statCode === '80' || statCode === '81' || statCode === '82') {
        statut = 'Colis livré';
      }

      res.status(200).json({
        numero,
        statut,
        step: getStep(evenements, statCode),
        destinataire: extract(data, 'LgDest'),
        poids: extract(data, 'Poids'),
        pointRelais: extract(data, 'LgPR'),
        dateLivraison: extract(data, 'DateLivrEstimee'),
        dateCreation: extract(data, 'DateIns'),
        evenements: evenements
      });
    });
  });

  request.on('error', e => res.status(500).json({ error: e.message }));
  request.write(soap);
  request.end();
}
