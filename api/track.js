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

  // Hash MD5 exact Mondial Relay
  const hashInput = CODE + numero + 'FR' + CLE;
  const hash = crypto.createHash('md5')
    .update(hashInput)
    .digest('hex')
    .toUpperCase();

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

  const soapBuffer = Buffer.from(soap, 'utf-8');

  const options = {
    hostname: 'api.mondialrelay.com',
    path: '/Web_Services.asmx',
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': '"http://www.mondialrelay.fr/webservice/WSI2_GetExpeditionsByExpeditions"',
      'Content-Length': soapBuffer.length
    }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {

      console.log('STATUS:', response.statusCode);
      console.log('RAW:', data.substring(0, 800));

      function extract(xml, tag) {
        const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return m ? m[1].trim() : '';
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
        return events;
      }

      function getStep(evenements, statut) {
        const s = (evenements.length > 0 ? evenements[0].libelle : statut).toLowerCase();
        if (s.includes('livr') || s.includes('remis') || s.includes('distribu')) return 4;
        if (s.includes('relais') || s.includes('point') || s.includes('disponible')) return 3;
        if (s.includes('transit') || s.includes('cours') || s.includes('tri') || s.includes('charg')) return 2;
        if (s.includes('enregistr') || s.includes('pris') || s.includes('cr')) return 1;
        return 1;
      }

      // Erreur SOAP
      if (data.includes('soap:Fault') || data.includes('faultstring')) {
        const fault = extract(data, 'faultstring');
        return res.status(200).json({
          error: true,
          message: fault || 'Erreur serveur Mondial Relay',
          fullResponse: data
        });
      }

      // Code erreur MR
      const statCode = extract(data, 'STAT');
      if (statCode && statCode !== '0') {
        return res.status(200).json({
          error: true,
          message: 'Colis introuvable (code ' + statCode + ')',
          fullResponse: data
        });
      }

      const evenements = extractEvents(data);
      const statut = evenements.length > 0
        ? evenements[0].libelle
        : extract(data, 'Libelle') || 'En cours de traitement';

      const destinataire = extract(data, 'Destinataire');
      const poids = extract(data, 'Poids');
      const pointRelais = extract(data, 'PointRelais') || extract(data, 'LieuLivraison');
      const dateLivraison = extract(data, 'DateLivraison') || extract(data, 'DateEstimee');
      const dateCreation = extract(data, 'DateCreation') || extract(data, 'DateExpedition');

      return res.status(200).json({
        numero,
