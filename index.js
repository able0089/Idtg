const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { createWorker } = require('tesseract.js');

console.log('[Startup] Pokétwo Bot Initializing...');

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('[Error] TOKEN not set');
  process.exit(1);
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
    console.log('[OCR] Ready');
  } catch (e) {
    console.error('[OCR] Failed:', e.message);
  }
}

function extractPokemonName(text) {
  if (!text || text.length === 0) return null;
  
  const clean = text.replace(/[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF\u4E00-\u9FAF\u3400-\u4DBF]|\uD83C[\uDDE6-\uDDFF]\uD83C[\uDDE6-\uDDFF]/g, '').trim();
  const lines = clean.split('\n').filter(l => l.trim().length > 2);
  
  if (!lines.length) return null;
  
  let name = lines[0].split(/\s{2,}/)[0].split('(')[0].split(',')[0].trim();
  const match = name.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?(?:\-[A-Z][a-z]+)?)/);
  
  if (!match) return null;
  
  name = match[1].trim();
  if (name.length > 20) name = name.split(/\s+/).slice(0, 2).join(' ');
  
  name = name.replace(/cuscHoo/i, 'Cubchoo').replace(/[^a-zA-Z\s\-]/g, '').trim();
  return (name.length > 3 && name.length <= 20) ? name : null;
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
  }, 3000);
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
    
    if (msg.author.id === client.user.id) {
      console.log('[Message] Own message - ignoring');
      return;
    }
    
    console.log(`[Message #${messageCount}] From ${msg.author.username} in ${msg.channel?.name || 'DM'}: ${msg.content?.substring(0, 50) || '(embeds)'}`);
    
    if (!msg.embeds.length) {
      console.log('[Message] No embeds - checking for text commands');
      
      if (msg.content.includes('Possible pokemons:') || msg.content.includes('Possible Pokémon:')) {
        console.log('[Hints] Found hint list');
        const hints = msg.content.split(/Possible Pok[eé]mons?:/i)[1];
        if (hints) {
          const names = hints.split(/,|\s+/).map(n => n.trim().replace(/[^a-zA-Z0-9\-]/g, '')).filter(n => n.length > 2);
          names.forEach((n, i) => {
            setTimeout(() => {
              msg.channel.send(`<@${POKETWO_ID}> catch ${n.toLowerCase()}`).catch(e => console.error('[Send Error]', e.message));
            }, i * 3000 + 500);
          });
        }
      }
      
      if (msg.content.includes('⏳')) {
        console.log('[Cooldown] Detected');
        setTimeout(() => {
          msg.channel.send(`<@${POKETWO_ID}> h`).catch(e => console.error('[Send Error]', e.message));
        }, 3500);
      }
      
      return;
    }
    
    console.log('[Message] Has embeds - checking for Pokémon info');
    
    if (msg.author.id === POKETWO_ID || msg.author.username.includes('Poké-Name') || msg.author.username.includes('P2 Assistant')) {
      console.log('[Bot Embed] Found embed message from', msg.author.username);
      const emb = msg.embeds[0];
      let poke = null;
      
      const text = (emb.title || '') + ' ' + (emb.description || '');
      console.log('[Bot Embed] Text:', text.substring(0, 100));
      
      if (text.includes('Name of the Pokemon') || text.includes('Possible')) {
        console.log('[Poké-Name] Trying text extraction');
        const m = text.match(/(?:\d+\)\s+|Pokémon:\s+|pokemons:\s+)([a-zA-Z0-9\- ]+)/i);
        if (m) {
          poke = extractPokemonName(m[1]);
          console.log('[Poké-Name] Text extraction result:', poke);
        }
      }
      
      if (!poke && (emb.image?.url || emb.thumbnail?.url)) {
        const url = emb.image?.url || emb.thumbnail?.url;
        console.log('[Poké-Name] No text match, trying OCR on:', url.substring(0, 50));
        try {
          if (worker) {
            const res = await worker.recognize(url);
            poke = extractPokemonName(res.data.text);
            console.log('[OCR] Extracted:', poke || 'none');
          } else {
            console.log('[OCR] Worker not ready yet');
          }
        } catch (e) {
          console.error('[OCR Error]', e.message);
        }
      }
      
      if (poke) {
        console.log('[CATCH] Sending catch for:', poke);
        setTimeout(() => {
          msg.channel.send(`<@${POKETWO_ID}> catch ${poke.toLowerCase()}`).catch(e => console.error('[Send Error]', e.message));
        }, 500);
      }
    }
    
    if (msg.author.id === POKETWO_ID) {
      console.log('[Pokétwo] Message from Pokétwo:', msg.content.substring(0, 100));
      if (msg.content.includes('verify') || msg.content.includes('captcha') || msg.content.includes('human')) {
        console.log('[Captcha] Detected - sending recovery');
        msg.channel.send(`<@${POKETWO_ID}> inc p`).catch(() => {});
        msg.channel.send(`<@${POKETWO_ID}> inc p all -y`).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[Message Error]', e.message, e.stack);
  }
});

process.on('unhandledRejection', (e) => console.error('[Rejection]', e));
process.on('uncaughtException', (e) => console.error('[Exception]', e));

const app = express();

app.get('/', (req, res) => {
  res.json({ 
    status: discordReady ? 'ready' : 'connecting', 
    uptime: process.uptime(),
    messages_received: messageCount
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('[Server] Running on port', PORT));

console.log('[Login] Connecting to Discord...');

client.login(TOKEN).catch((e) => {
  console.error('[Login Failed]', e.message);
  setTimeout(() => process.exit(1), 1000);
});

setTimeout(() => {
  if (!discordReady) {
    console.log('[Waiting] Still connecting...');
  }
}, 10000);
