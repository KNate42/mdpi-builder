const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} = require('docx');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/check', async (req, res) => {
  const { text, language = 'en-US' } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }
  try {
    const params = new URLSearchParams({
      text,
      language,
      enabledOnly: 'false',
    });
    const r = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: 'LanguageTool error', detail });
    }
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/export/docx', async (req, res) => {
  const doc = req.body || {};
  try {
    const buffer = await buildDocx(doc);
    const filename = sanitizeFilename(doc.title || 'mdpi-paper') + '.docx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save', async (req, res) => {
  const doc = req.body || {};
  const id = doc.id || crypto.randomBytes(6).toString('hex');
  doc.id = id;
  doc.savedAt = new Date().toISOString();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, `${id}.json`), JSON.stringify(doc, null, 2));
  res.json({ id, savedAt: doc.savedAt });
});

app.get('/api/load/:id', async (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9_-]/gi, '');
  try {
    const data = await fs.readFile(path.join(DATA_DIR, `${id}.json`), 'utf8');
    res.json(JSON.parse(data));
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});

app.get('/api/list', async (req, res) => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const files = await fs.readdir(DATA_DIR);
    const items = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const raw = await fs.readFile(path.join(DATA_DIR, f), 'utf8');
      const d = JSON.parse(raw);
      items.push({ id: d.id, title: d.title || '(untitled)', savedAt: d.savedAt });
    }
    items.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/doc/:id', async (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9_-]/gi, '');
  try {
    await fs.unlink(path.join(DATA_DIR, `${id}.json`));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});

app.listen(PORT, () => {
  console.log(`MDPI Builder running at http://localhost:${PORT}`);
});

function sanitizeFilename(s) {
  return s.toString().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 80) || 'paper';
}

function para(text, opts = {}) {
  return new Paragraph({
    alignment: opts.align || AlignmentType.JUSTIFIED,
    spacing: { after: 120 },
    children: [new TextRun({ text: text || '', size: 22 })],
  });
}

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true, size: 26 })],
  });
}

function splitParagraphs(text) {
  if (!text) return [para('')];
  return text.split(/\n{2,}|\r\n{2,}/).map((p) => para(p.trim()));
}

async function buildDocx(doc) {
  const children = [];

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: doc.title || 'Untitled', bold: true, size: 32 })],
    })
  );

  if (doc.authors) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: doc.authors, size: 22 })],
      })
    );
  }
  if (doc.affiliations) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: doc.affiliations, italics: true, size: 20 })],
      })
    );
  }

  if (doc.abstract) {
    children.push(heading('Abstract', HeadingLevel.HEADING_2));
    children.push(...splitParagraphs(doc.abstract));
  }
  if (doc.keywords) {
    children.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: 'Keywords: ', bold: true, size: 22 }),
          new TextRun({ text: doc.keywords, size: 22 }),
        ],
      })
    );
  }

  const sections = [
    ['1. Introduction', doc.introduction],
    ['2. Materials and Methods', doc.methods],
    ['3. Results', doc.results],
    ['4. Discussion', doc.discussion],
    ['5. Conclusions', doc.conclusions],
  ];
  for (const [title, body] of sections) {
    if (!body) continue;
    children.push(heading(title));
    children.push(...splitParagraphs(body));
  }

  if (doc.references) {
    children.push(heading('References'));
    const refs = doc.references.split(/\n+/).map((r) => r.trim()).filter(Boolean);
    refs.forEach((r, i) => {
      children.push(
        new Paragraph({
          spacing: { after: 80 },
          children: [new TextRun({ text: `${i + 1}. ${r}`, size: 20 })],
        })
      );
    });
  }

  const document = new Document({
    title: doc.title || 'MDPI Paper',
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(document);
}
