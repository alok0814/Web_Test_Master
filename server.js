import dotenv from 'dotenv';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import OpenAI from 'openai';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });
if (fs.existsSync(envPath)) {
  const fromFile = dotenv.parse(fs.readFileSync(envPath));
  for (const name of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'PORT', 'HTTPS_PORT']) {
    if (fromFile[name]) process.env[name] = String(fromFile[name]).trim();
  }
}

const PORT = Number(process.env.PORT || 8787);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8788);
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const ALLOWED_MODELS = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini']);

let memoryKey = (process.env.OPENAI_API_KEY || '').trim();

const SYSTEM_PROMPT = `あなたは、カメラ画像に写っている画面の問題を解く係です。計算、表、グラフ、日本語の文章、選択式の問題を読み、音声でそのまま読み上げる答えを作ります。

ルール:
- モニターや紙に書かれた問題だけを見る。机、反射、画面の枠は無視する。
- 問題が写っていない、または文字が読めないときは has_problem を false にする。そのとき answer_speech は空文字にする。
- 選択肢があるときは記号と中身を答える。例: 「ウ。1,200円」
- answer_speech は日本語の話し言葉。文頭は「答えは、」で始め、1〜2文で終える。解説、式の途中経過、前置きは入れない。
- 数値は算用数字のまま書く。
- 複数の問題が同じ画面にあり、今解くべき一問が判別できるときはその一問だけ答える。判別できないときは上から順に短く答える。
- summary は、何の問題かを15文字以内で書く。
- 次のJSONオブジェクトだけを返す:
{"has_problem":true,"summary":"割合の計算","answer_speech":"答えは、ウ。40パーセントです"}`;

function lanAddresses() {
  const ips = [];
  let nets = {};
  try {
    nets = os.networkInterfaces();
  } catch {
    return ips;
  }
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) ips.push(net.address);
    }
  }
  return [...new Set(ips)].sort();
}

function loadOrCreateCert(ips) {
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const metaPath = path.join(dir, 'ips.txt');
  const signature = ips.join(',');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath)) {
    if (fs.readFileSync(metaPath, 'utf8') === signature) {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    }
  }
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(metaPath, signature);
  return { key: pems.private, cert: pems.cert };
}

function clientForKey() {
  if (!memoryKey) return null;
  return new OpenAI({ apiKey: memoryKey });
}

function friendlyError(message) {
  if (/credit|billing|quota|insufficient/i.test(message)) {
    return 'OpenAIの残高がありません。platform.openai.com でクレジットを追加してから、もう一度試してください。';
  }
  if (/invalid api key|incorrect api key|api key/i.test(message)) {
    return 'APIキーが正しくありません。設定から入れ直してください。';
  }
  if (/rate limit/i.test(message)) {
    return '読み取りが混み合っています。数秒待ってから、もう一度映してください。';
  }
  return message;
}

function parseModelJson(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  }
}

const app = express();
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    next();
    return;
  }
  express.json({ limit: '4mb' })(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  const ips = process.env.VERCEL ? [] : lanAddresses();
  res.json({
    ok: true,
    hasKey: Boolean(memoryKey),
    model: DEFAULT_MODEL,
    phoneUrls: ips.map((ip) => `https://${ip}:${HTTPS_PORT}`),
  });
});

function persistKey(key) {
  const envPath = path.join(__dirname, '.env');
  const line = `OPENAI_API_KEY=${key}`;
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const next = /^OPENAI_API_KEY=.*$/m.test(current)
    ? current.replace(/^OPENAI_API_KEY=.*$/m, line)
    : `${current}${current.endsWith('\n') || current.length === 0 ? '' : '\n'}${line}\n`;
  fs.writeFileSync(envPath, next);
}

app.post('/api/key', (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key.startsWith('sk-') || key.length < 20) {
    res.status(400).json({ error: 'APIキーの形式が違います。sk- で始まるキーを入れてください。' });
    return;
  }
  memoryKey = key;
  try {
    persistKey(key);
  } catch {
    res.json({ ok: true, warning: 'キーは今の起動中だけ有効です。再起動後はもう一度保存してください。' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/solve', async (req, res) => {
  const client = clientForKey();
  if (!client) {
    res.status(400).json({ error: 'OpenAIのAPIキーが未設定です。設定からキーを保存してください。' });
    return;
  }

  const image = String(req.body?.image || '');
  if (!image.startsWith('data:image/')) {
    res.status(400).json({ error: '画像データがありません。' });
    return;
  }
  if (image.length > 9_000_000) {
    res.status(413).json({ error: '画像が大きすぎます。カメラを少し離してください。' });
    return;
  }

  const requested = String(req.body?.model || DEFAULT_MODEL);
  const model = ALLOWED_MODELS.has(requested) ? requested : DEFAULT_MODEL;

  try {
    const completion = await client.chat.completions.create(
      {
        model,
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'この画像の画面に写っている問題を読み、指定のJSONで答えだけ返してください。',
              },
              { type: 'image_url', image_url: { url: image, detail: 'high' } },
            ],
          },
        ],
      },
      { timeout: 45000 }
    );

    const text = completion.choices?.[0]?.message?.content || '';
    const parsed = parseModelJson(text);
    if (!parsed) {
      res.status(502).json({ error: '答えの形式を読み取れませんでした。もう一度映してください。' });
      return;
    }

    const hasProblem = Boolean(parsed.has_problem);
    const speech = String(parsed.answer_speech || '').trim();
    res.json({
      hasProblem,
      summary: String(parsed.summary || '').trim(),
      speech: hasProblem ? speech : '',
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    const raw = String(error?.error?.message || error?.message || '読み取りに失敗しました');
    const message = friendlyError(raw);
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    res.status(safeStatus).json({ error: message });
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: '画像が大きすぎます。' });
    return;
  }
  res.status(500).json({ error: 'サーバーでエラーが起きました。' });
});

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve(label);
    });
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly && !process.env.VERCEL) {
  const httpServer = http.createServer(app);
  const ips = lanAddresses();
  try {
    const creds = loadOrCreateCert(ips);
    const httpsServer = https.createServer(creds, app);
    await listen(httpServer, PORT, 'http');
    await listen(httpsServer, HTTPS_PORT, 'https');
    console.log('');
    console.log('画面の答え を起動しました');
    console.log(`  このMacのブラウザ:  http://localhost:${PORT}`);
    if (ips.length === 0) {
      console.log('  スマホ用のアドレス: 同じWi-FiのIPアドレスが見つかりません');
    } else {
      for (const ip of ips) {
        console.log(`  スマホのブラウザ:    https://${ip}:${HTTPS_PORT}`);
      }
    }
    console.log('');
    console.log('スマホは必ず https の方で開いてください。最初に証明書の警告が出たら、詳細からこのサイトへ進んでください。');
    if (!memoryKey) console.log('APIキーは未設定です。画面の「設定」から保存できます。');
  } catch (error) {
    console.error('起動に失敗しました:', error.message);
    process.exit(1);
  }
}

export default app;
