const { sendButtons: giftedSendButtons, sendInteractiveMessage: giftedSendInteractive } = require('gifted-btns');

/**
 * Send interactive buttons using gifted-btns
 * @param {Object} sock Baileys socket connection instance
 * @param {String} jid Target WhatsApp JID
 * @param {Object} data Button configuration object
 * @param {String} [data.title] Optional header title
 * @param {String} [data.text] Main message body
 * @param {String} [data.footer] Optional footer text
 * @param {Object|String} [data.image] Optional header image (URL, { url }, or Buffer)
 * @param {Boolean} [data.aimode] Optional AI mode
 * @param {Array} [data.buttons] Array of button objects [{ id, text }, or native flow objects]
 * @param {Object} [options] Baileys options (e.g., { quoted: mek })
 */
async function sendButtons(sock, jid, data = {}, options = {}) {
  try {
    const payload = {
      title: data.title || '',
      text: data.text || data.caption || '',
      footer: data.footer || '',
      aimode: data.aimode || false,
      buttons: data.buttons || []
    };

    if (data.image) {
      if (typeof data.image === 'string') {
        payload.image = { url: data.image };
      } else {
        payload.image = data.image;
      }
    }

    return await giftedSendButtons(sock, jid, payload, options);
  } catch (error) {
    console.error('❌ Error sending buttons via gifted-btns:', error);
    throw error;
  }
}

/**
 * Send interactive message (quick replies, single select dropdowns, CTA buttons)
 * @param {Object} sock Baileys socket connection instance
 * @param {String} jid Target WhatsApp JID
 * @param {Object} content Interactive content payload
 * @param {Object} [options] Baileys relay options
 */
async function sendInteractive(sock, jid, content = {}, options = {}) {
  try {
    if (content.image && typeof content.image === 'string') {
      content.image = { url: content.image };
    }
    return await giftedSendInteractive(sock, jid, content, options);
  } catch (error) {
    console.error('❌ Error sending interactive message via gifted-btns:', error);
    throw error;
  }
}

/**
 * High-level button menu sender helper for plugins
 * @param {Object} sock Baileys socket connection instance
 * @param {String} jid Target WhatsApp JID
 * @param {Object} config Menu configuration object
 * @param {Object} [options] Baileys options
 */
async function sendButtonMenu(sock, jid, config = {}, options = {}) {
  const { title, text, footer, image, buttons, listTitle, sections } = config;

  // If sections are provided, send as a single select list
  if (sections && Array.isArray(sections)) {
    return await sendInteractive(sock, jid, {
      title: title || '',
      text: text || '',
      footer: footer || '',
      image: image ? (typeof image === 'string' ? { url: image } : image) : undefined,
      interactiveButtons: [
        {
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: listTitle || 'Select Option',
            sections: sections
          })
        }
      ]
    }, options);
  }

  // Otherwise send quick reply buttons
  return await sendButtons(sock, jid, {
    title,
    text,
    footer,
    image,
    buttons
  }, options);
}

module.exports = {
  sendButtons,
  sendInteractive,
  sendButtonMenu
};
