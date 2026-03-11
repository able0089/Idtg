const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const newLogic = `client.on('messageCreate', async (msg) => {
  try {
    messageCount++;
    
    if (msg.author.id === client.user.id) {
      console.log('[Message] Own message - ignoring');
      return;
    }
    
    const isPoketwo = msg.author.id === POKETWO_ID;
    const isAssistant = msg.author.username.includes('Poké-Name') || msg.author.username.includes('P2 Assistant') || msg.author.username.toLowerCase().includes('assistant');
    
    let textContent = msg.content || '';
    let imageUrl = null;
    
    if (msg.embeds && msg.embeds.length > 0) {
      const emb = msg.embeds[0];
      textContent += ' ' + (emb.title || '') + ' ' + (emb.description || '');
      imageUrl = emb.image?.url || emb.thumbnail?.url;
    }
    
    if (msg.attachments && msg.attachments.size > 0) {
      imageUrl = imageUrl || msg.attachments.first().url;
    }
    
    console.log(\`[Message #\${messageCount}] From \${msg.author.username}: \${textContent.substring(0, 50).replace(/\\n/g, ' ')}\`);
    
    // We removed the auto-hint logic as it causes issues with user limits
    // Relying strictly on assistant bots and Poketwo OCR
    
    // 1. Assistant Hint lists (if an assistant bot posts hints in text)
    if (textContent.includes('Possible pokemons:') || textContent.includes('Possible Pokémon:')) {
      console.log('[Hints] Found hint list');
      let poke = null;
      const m = textContent.match(/(?:\\d+\\)\\s+|Pokémon:\\s+|pokemons:\\s+)([a-zA-Z0-9\\- ]+)/i);
      if (m) {
        poke = extractPokemonName(m[1]);
      } else {
        const hints = textContent.split(/Possible Pok[eé]mons?:/i)[1];
        if (hints) {
          const match = hints.match(/([A-Z][a-z]+)/);
          if (match) {
            poke = extractPokemonName(match[1]);
          }
        }
      }
      
      if (poke) {
        console.log('[CATCH] Hint match:', poke);
        setTimeout(() => {
          msg.channel.send(\`<@\${POKETWO_ID}> c \${poke.toLowerCase()}\`).catch(e => console.error('[Send Error]', e.message));
        }, 500);
      }
    }
    
    // 2. OCR / Direct name (The core logic to read from Assistant/Naming bots)
    if (isPoketwo || isAssistant) {
      let poke = null;
      
      if (textContent.includes('Name of the Pokemon') || textContent.includes('Found')) {
        console.log('[Poké-Name] Trying text extraction');
        const m = textContent.match(/(?:\\d+\\)\\s+|Pokémon:\\s+|pokemons:\\s+)([a-zA-Z0-9\\- ]+)/i);
        if (m) {
          poke = extractPokemonName(m[1]);
          console.log('[Poké-Name] Text extraction result:', poke);
        }
      }
      
      // Look for the Pokemon name in the image from the Assistant Bot
      if (!poke && imageUrl) {
        console.log('[Image] No text match, trying OCR on:', imageUrl.substring(0, 50));
        try {
          if (worker) {
            const res = await worker.recognize(imageUrl);
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
          msg.channel.send(\`<@\${POKETWO_ID}> c \${poke.toLowerCase()}\`).catch(e => console.error('[Send Error]', e.message));
        }, 500);
      }
    }
    
    // 3. Captcha detection
    if (isPoketwo) {
      if (textContent.includes('verify') || textContent.includes('captcha') || textContent.includes('human')) {
        console.log('[Captcha] Detected - sending recovery');
        msg.channel.send(\`<@\${POKETWO_ID}> inc p\`).catch(() => {});
        msg.channel.send(\`<@\${POKETWO_ID}> inc p all -y\`).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[Message Error]', e.message, e.stack);
  }
});`;

const startIndex = code.indexOf("client.on('messageCreate'");
const endIndex = code.indexOf("});\n\nprocess.on('unhandledRejection'");

if (startIndex !== -1 && endIndex !== -1) {
  code = code.substring(0, startIndex) + newLogic + code.substring(endIndex + 3);
  fs.writeFileSync('index.js', code);
  console.log('Fixed messageCreate logic');
} else {
  console.log('Could not find boundaries');
}
