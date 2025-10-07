const fs = require('fs');
if (fs.existsSync('config.env')) require('dotenv').config({ path: './config.env' });

function convertToBool(text, fault = 'true') {
    return text === fault ? true : false;
}
module.exports = {
SESSION_ID: process.env.SESSION_ID || "2ccwzKjK#N_nLp5hfNIZXEFC4nZQv7XcfWEs0eMvQpaWXz1Z3_H0",
ALIVE_IMG: process.env.ALIVE_IMG || "https://github.com/DANUWA-MD/DANUWA-MD/blob/main/images/DANUWA-MD.png?raw=true",
ALIVE_MSG: process.env.ALIVE_MSG || "*Hello👋 DANUWA-MD Is Alive Now😍*",
BOT_OWNER: '94774915917',  // Replace with the owner's phone number



};
