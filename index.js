if (typeof File === 'undefined') { global.File = require('buffer').File; }
if (typeof String.prototype.toWellFormed !== 'function') {
  String.prototype.toWellFormed = function() { return String(this); };
}

const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { createWorker } = require('tesseract.js');
const { exec } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');

console.log('[Startup] Pokétwo Bot Initializing...');

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('[Error] TOKEN not set! The bot cannot connect to Discord without it.');
  console.error('[Fix] Please go to your Railway Project -> Variables tab -> Add New Variable -> name it TOKEN and paste your Discord token as the value.');
}

const POKETWO_ID = '716390085896962058';
const SPAM_CHANNEL_ID = '1477260122337185873';

console.log('[Config] SPAM_CHANNEL_ID:', SPAM_CHANNEL_ID || 'NOT SET');

let discordReady = false;
let worker = null;
let messageCount = 0;

const client = new Client({
  partials: ['MESSAGE', 'CHANNEL', 'GUILD_MEMBER', 'USER', 'GUILD'],
  allowWebAssembly: true,
  retryLimit: 5,
  checkUpdate: false
});

client.on('debug', (info) => {
  console.log('[Discord Debug]', info);
});

console.log('[Init] Discord client created');

async function initOCR() {
  try {
    console.log('[OCR] Initializing...');
    worker = await createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    console.log('[OCR] Ready');
  } catch (e) {
    console.error('[OCR] Failed:', e.message);
  }
}

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const tmpPath = `${os.tmpdir()}/pk_${Date.now()}_in.png`;
    const file = fs.createWriteStream(tmpPath);
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(tmpPath); });
    }).on('error', err => { file.close(); fs.unlink(tmpPath, () => {}); reject(err); });
  });
}

function preprocessImage(inputPath) {
  return new Promise((resolve, reject) => {
    const outPath = inputPath.replace('_in.png', '_out.png');
    // Crop left 60% (removes the Pokémon sprite on the right), scale up, greyscale
    const args = `"${inputPath}" -crop 60%x100%+0+0 +repage -resize 800x300 -colorspace Gray "${outPath}"`;
    // Try 'magick' (ImageMagick v7) first, fall back to 'convert' (v6)
    exec(`magick ${args}`, err => {
      if (!err) return resolve(outPath);
      exec(`convert ${args}`, err2 => {
        if (err2) return reject(new Error(`ImageMagick not available: ${err.message}`));
        resolve(outPath);
      });
    });
  });
}

async function ocrImageUrl(url) {
  let inPath = null;
  let outPath = null;
  try {
    console.log('[OCR] Downloading image...');
    inPath = await downloadToTemp(url);
    outPath = await preprocessImage(inPath);
    if (!worker) return null;
    const result = await worker.recognize(outPath);
    const raw = result.data.text.trim();
    console.log('[OCR Raw]', JSON.stringify(raw));
    return raw;
  } catch (e) {
    console.error('[OCR Pipeline Error]', e.message);
    return null;
  } finally {
    if (inPath) fs.unlink(inPath, () => {});
    if (outPath) fs.unlink(outPath, () => {});
  }
}

function extractPokemonName(rawText) {
  if (!rawText || rawText.trim().length === 0) return null;

  console.log('[OCR Raw]', JSON.stringify(rawText.substring(0, 300)));

  // Normalise line endings, drop non-printable chars but keep letters/hyphens/spaces/newlines
  const clean = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF\u4E00-\u9FAF\u3400-\u4DBF]/g, '')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .trim();

  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length >= 2);
  if (!lines.length) return null;

  console.log('[OCR Lines]', lines);

  for (const line of lines) {
    // Keep only letters, hyphens, spaces (valid in Pokémon names)
    const stripped = line.replace(/[^a-zA-Z\- ]/g, '').trim();
    if (!stripped || stripped.length < 3) continue;

    // Count uppercase vs lowercase letters
    const letters = stripped.replace(/[^a-zA-Z]/g, '');
    if (letters.length === 0) continue;
    const upperCount = letters.replace(/[^A-Z]/g, '').length;
    const upperRatio = upperCount / letters.length;

    // Poké-Name sends English names in ALL CAPS, alt-language names in lowercase.
    // Only accept lines that are mostly uppercase (≥60% uppercase letters).
    if (upperRatio < 0.6) {
      console.log('[OCR] Skipping lowercase/alt-language line:', stripped);
      continue;
    }

    // Convert to lowercase for the catch command
    // (Pokétwo accepts lowercase: "c hakamo-o", "c three-segment dudunsparce")
    const result = stripped.toLowerCase().replace(/\s+/g, ' ').trim();

    if (result.length >= 3 && result.length <= 50) {
      console.log('[OCR] Extracted name:', result);
      return result;
    }
  }

  return null;
}

// ── Per-channel wild spawn state ──────────────────────────────────────────────
const wildState = new Map();
// { channelId: { timestamp, caught, hintSent, hintTimeout } }

const lastHintTime = new Map();
const HINT_DELAY_MS = 12 * 1000;    // wait 12s before sending hint
const HINT_COOLDOWN_MS = 45 * 1000; // minimum 45s between hints per channel

function sendCatch(channel, pokeName) {
  channel.send(`<@${POKETWO_ID}> c ${pokeName.toLowerCase()}`)
    .catch(e => console.error('[Send Error]', e.message));
}

function sendHint(channel) {
  const now = Date.now();
  const last = lastHintTime.get(channel.id) || 0;
  if (now - last < HINT_COOLDOWN_MS) {
    console.log('[Hint] Cooldown active, skipping for channel', channel.id);
    return;
  }
  lastHintTime.set(channel.id, now);
  const state = wildState.get(channel.id);
  if (state) state.hintSent = true;
  console.log('[Hint] Sending fallback hint to channel', channel.id);
  channel.send(`<@${POKETWO_ID}> hint`).catch(e => console.error('[Hint Error]', e.message));
}

function markCaught(channelId) {
  const state = wildState.get(channelId);
  if (state) {
    if (state.hintTimeout) clearTimeout(state.hintTimeout);
    wildState.delete(channelId);
  }
}

let spamInterval = null;

function startSpammer() {
  if (!SPAM_CHANNEL_ID) {
    console.log('[Spammer] Disabled - SPAM_CHANNEL_ID not set');
    return;
  }
  
  console.log('[Spammer] Starting on channel:', SPAM_CHANNEL_ID);
  spamInterval = setInterval(async () => {
    try {
      let ch = client.channels.cache.get(SPAM_CHANNEL_ID);
      if (!ch) {
        ch = await client.channels.fetch(SPAM_CHANNEL_ID).catch(() => null);
      }
      
      if (ch) {
        const msg = Math.random().toString(36).substring(2, 8) + ' made by quaxly';
        await ch.send(msg);
        console.log('[Spammer] Sent message');
      } else {
        console.log('[Spammer] Channel not found!');
      }
    } catch (e) {
      console.error('[Spammer Error]', e.message);
    }
  }, 8000);
}

client.once('ready', () => {
  discordReady = true;
  console.log('\n[SUCCESS] BOT LOGGED IN AS:', client.user.tag);
  console.log('[Info] Bot ID:', client.user.id);
  console.log('[Info] Guilds:', client.guilds.cache.size);
  console.log('[Info] Channels:', client.channels.cache.size);
  console.log('[Info] Ready to receive messages\n');
  
  startSpammer();
  initOCR();
});

client.on('error', (e) => {
  console.error('[Discord Error]', e.message);
});

client.on('warn', (w) => {
  console.warn('[Discord Warn]', w);
});

client.on('disconnect', () => {
  console.warn('[Disconnect] Bot disconnected');
  discordReady = false;
});

client.on('messageCreate', async (msg) => {
  try {
    messageCount++;
    if (msg.author.id === client.user.id) return;

    const isPoketwo = msg.author.id === POKETWO_ID;
    const isBot = msg.author.bot === true;
    const channelId = msg.channel.id;

    // Build text content from message + embeds
    let textContent = msg.content || '';
    let imageUrl = null;
    if (msg.embeds?.length > 0) {
      const emb = msg.embeds[0];
      textContent += ' ' + (emb.title || '') + ' ' + (emb.description || '');
      imageUrl = emb.image?.url || emb.thumbnail?.url || emb.url || null;
    }
    if (msg.attachments?.size > 0) {
      imageUrl = imageUrl || msg.attachments.first().url;
    }
    const textLower = textContent.toLowerCase();

    // Log every message (so we can see what usernames bots have)
    console.log(`[Msg #${messageCount}] ${msg.author.username}${isPoketwo ? ' [P2]' : isBot ? ' [BOT]' : ''}: "${textContent.substring(0, 70).replace(/\n/g, ' ')}"${imageUrl ? ' [IMG]' : ''}`);

    // ── 1. DETECT WILD SPAWN (Pokétwo) ──────────────────────────────────────
    if (isPoketwo && (textLower.includes('wild') || textLower.includes('appeared'))) {
      console.log('[Spawn] Wild Pokémon detected in channel', channelId);
      const prev = wildState.get(channelId);
      if (prev?.hintTimeout) clearTimeout(prev.hintTimeout);

      const hintTimeout = setTimeout(() => {
        const state = wildState.get(channelId);
        if (state && !state.caught) {
          console.log('[Hint] OCR failed or timed out — sending hint fallback');
          sendHint(msg.channel);
        }
      }, HINT_DELAY_MS);

      wildState.set(channelId, { timestamp: Date.now(), caught: false, hintSent: false, hintTimeout });
    }

    // ── 2. WILD POKÉMON FLED / CAUGHT BY SOMEONE ELSE ───────────────────────
    if (isPoketwo && (textLower.includes('fled') || textLower.includes('get away') ||
        textLower.includes('added to your pokédex') || textLower.includes('caught the'))) {
      console.log('[Spawn] Wild Pokémon resolved, clearing state for channel', channelId);
      markCaught(channelId);
    }

    // ── 3. TEXT-BASED NAME READING (works reliably) ──────────────────────────
    // Matches: Poké-Name text response after hint, or any bot posting the name as text
    {
      let poke = null;

      // "Possible Pokémon: Piplup, ..." or "Possible pokemons: Piplup"
      const listMatch = textContent.match(/Possible Pok[eé]mons?:\s*([^\n,;|]+)/i);
      if (listMatch) {
        poke = listMatch[1].trim().toLowerCase().replace(/[^a-z0-9 \-]/g, '').trim();
      }

      // "Found: Piplup" / "Name: Piplup" / "Name of the Pokemon: Piplup"
      if (!poke) {
        const foundMatch = textContent.match(/(?:Found|Name of the pok[eé]mon|Pokemon name|It is)[:\s]+([A-Za-z][A-Za-z0-9 \-]{1,30})/i);
        if (foundMatch) poke = foundMatch[1].trim().toLowerCase();
      }

      // Numbered list: "1) Piplup" or "1. Piplup"
      if (!poke) {
        const numMatch = textContent.match(/(?:^|\n)\s*\d+[.)]\s*([A-Za-z][A-Za-z0-9 \-]{1,30})/m);
        if (numMatch) poke = numMatch[1].trim().toLowerCase();
      }

      if (poke && poke.length >= 3) {
        console.log('[Text] Pokémon name from text:', poke);
        markCaught(channelId);
        setTimeout(() => sendCatch(msg.channel, poke), 500);
        return; // done
      }
    }

    // ── 4. IMAGE OCR (any bot that sends an image, e.g. Poké-Name) ──────────
    if (isBot && imageUrl) {
      console.log(`[Image] Bot "${msg.author.username}" sent image — URL: ${imageUrl}`);
      if (worker) {
        const rawText = await ocrImageUrl(imageUrl);
        const poke = extractPokemonName(rawText);
        if (poke) {
          console.log('[OCR] Success:', poke);
          markCaught(channelId);
          setTimeout(() => sendCatch(msg.channel, poke), 500);
        } else {
          // OCR couldn't read the name — send hint right now
          console.log('[OCR] No name found — sending hint immediately');
          sendHint(msg.channel);
        }
      } else {
        // OCR not ready — send hint right now
        console.log('[OCR] Worker not ready — sending hint immediately');
        sendHint(msg.channel);
      }
    }

    // ── 5. CAPTCHA ───────────────────────────────────────────────────────────
    if (isPoketwo && (textLower.includes('verify') || textLower.includes('captcha') || textLower.includes('human'))) {
      console.log('[Captcha] Detected');
      msg.channel.send(`<@${POKETWO_ID}> inc p`).catch(() => {});
    }

  } catch (e) {
    console.error('[Message Error]', e.message, e.stack?.split('\n').slice(0, 3).join('\n'));
  }
});

process.on('unhandledRejection', (e) => console.error('[Rejection]', e));
process.on('uncaughtException', (e) => console.error('[Exception]', e));

const app = express();

app.get('/', (req, res) => {
  const uptimeSecs = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSecs / 3600);
  const mins = Math.floor((uptimeSecs % 3600) / 60);
  const secs = uptimeSecs % 60;
  res.send(`<!DOCTYPE html><html><head><title>Pokétwo Bot Status</title>
  <style>body{font-family:monospace;background:#1a1a2e;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
  .card{background:#16213e;border-radius:12px;padding:40px 60px;text-align:center;box-shadow:0 0 30px #0f3460;}
  h1{color:#e94560;margin:0 0 10px;}
  .status{font-size:2em;margin:20px 0;}
  .ok{color:#00ff88;}
  .dim{color:#888;font-size:0.85em;}
  table{margin:20px auto;border-collapse:collapse;}
  td{padding:6px 20px;border-bottom:1px solid #0f3460;}
  td:first-child{color:#888;}
  td:last-child{color:#00ff88;}
  </style></head><body>
  <div class="card">
    <h1>🎮 Pokétwo Self-Bot</h1>
    <div class="status">${discordReady ? '<span class="ok">● ONLINE</span>' : '<span style="color:#ffaa00">● CONNECTING</span>'}</div>
    <table>
      <tr><td>Service</td><td>${IS_WEB_ONLY ? 'Web (Status Page)' : 'Worker (Bot Active)'}</td></tr>
      <tr><td>Uptime</td><td>${hours}h ${mins}m ${secs}s</td></tr>
      <tr><td>Messages Seen</td><td>${messageCount}</td></tr>
      <tr><td>Spam Channel</td><td>${SPAM_CHANNEL_ID}</td></tr>
    </table>
    <div class="dim">Worker is handling catching & spamming</div>
  </div></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('[Server] Running on port', PORT));

const SERVICE_NAME = (process.env.RAILWAY_SERVICE_NAME || '').toLowerCase();
const IS_WEB_ONLY = SERVICE_NAME === 'web' || SERVICE_NAME.includes('web');

if (IS_WEB_ONLY) {
  console.log('[Mode] Running as WEB service (status page only). Discord bot runs on the worker service.');
} else if (TOKEN) {
  console.log('[Login] Connecting to Discord as worker...');
  client.login(TOKEN).catch((e) => {
    console.error('[Login Failed]', e.message);
  });
} else {
  console.log('[Login Skipped] No token provided.');
}

setTimeout(() => {
  if (!discordReady) {
    console.log('[Waiting] Still connecting...');
  }
}, 10000);
