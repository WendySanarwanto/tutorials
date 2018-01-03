const http = require('http')
const url = require('url')
const crypto = require('crypto')
const plugin = require('./plugins.js').xrp.Shop()
const winston = require(`winston`);

const tsFormat = () => (new Date()).toLocaleTimeString(`id-ID`, {
  day: "numeric",
  month: "numeric",
  timeZoneName: "long",
  year: "numeric",
});

const logger = new winston.Logger({
  transports: [
    new winston.transports.Console({
      colorize: true,
      level: `debug`,
      timestamp: tsFormat
    })
  ]
});

function base64url (buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sha256 (preimage) {
  return crypto.createHash('sha256').update(preimage).digest()
}

let fulfillments = {}
let letters = {}
const cost = 10
const httpServerPort = 18000;

// console.log(`== Starting the shop server == `)
logger.info(`== Starting the shop server == `);

// console.log(` 1. Connecting to an account to accept payments ...`);
logger.info(` 1. Connecting to an account to accept payments ...`);

plugin.connect().then(() => {
  // Get ledger's info and account information of the Shop, from the plugin
  const ledgerInfo = plugin.getInfo();
  const shopAccount = plugin.getAccount();

  logger.debug(`    - Connected to ledger: ${ledgerInfo.prefix}`);
  logger.debug(`    -- Account: ${shopAccount}`);
  logger.debug(`    -- Currency: ${ledgerInfo.currencyCode}`);
  logger.debug(`    -- CurrencyScale: ${ledgerInfo.currencyScale}`);

  // Convert our cost (10) into the right format given the ledger scale
  const normalisedCost = cost / Math.pow(10, parseInt(ledgerInfo.currencyScale));

  logger.info(` 2. Starting web server to accept requests...`);
  logger.debug(`    - Charging ${normalisedCost} ${ledgerInfo.currencyCode}`);

  // Handle incoming web requests...
  http.createServer((req, res) => {
    // Browsers are irritiating and often probe for a favicon, just ignore
    if (req.url.startsWith('/favicon.ico')) {
      res.statusCode = 404;
      res.end();
      return;
    }

    logger.debug(`    - Incoming request to: ${req.url}`);
    const requestUrl = url.parse(req.url);
    logger.debug(`    - requestUrl: `, requestUrl);

    if (requestUrl.path === '/') {
      // Request for a letter with no attached fulfillment

      // Respond with a 402 HTTP Status Code (Payment Required)
      res.statusCode = 402;

      // Generate a preimage and its SHA256 hash,
      // which we'll use as the fulfillment and condition, respectively, of the
      // conditional transfer.
      const fulfillment = crypto.randomBytes(32);
      const condition = sha256(fulfillment);

      // Get the letter that we are selling
      const letter = (`ABCDEFGHIJKLMNOPQRSTUVWXYZ`).split('')[Math.floor(Math.random() * 26)];

      logger.debug(`    - Generated letter (${letter}) at http://localhost:${httpServerPort}${req.url}${base64url(fulfillment)}`);

      // Store the fulfillment (indexed by condition) to use when we get paid
      fulfillments[base64url(condition)] = fulfillment;

      // Store the letter (indexed by the fulfillment) to use when the customer
      // requests it
      letters[base64url(fulfillment)] = letter;

      logger.info(`    - Waiting for payment...`);

      res.setHeader(`Pay`, `${cost} ${shopAccount} ${base64url(condition)}`);

      res.end(`Please send an Interledger payment of ${normalisedCost} ${ledgerInfo.currencyCode} to ${shopAccount}` +
              ` using the condition ${base64url(condition)}\n` +
              `> node ./pay.js ${shopAccount} ${cost} ${base64url(condition)}`);
    } else {
      // Request for a letter with the fulfillment in the path

      // Get fulfillment from the path
      const fulfillmentBase64 = requestUrl.path.substring(1);

      // Lookup the letter we started previously for this fulfillment
      const letter = letters[fulfillmentBase64];

      if (!letter) {
        // We have no record of a letter that was issued for this fulfillment

        // Respond with a 404 HTTP Status Code (Not Found)
        res.statusCode = 404

        logger.debug('     - No letter found for fulfillment: ' + fulfillmentBase64);
        res.end(`Unrecognised fulfillment.`);
      } else {
        // Provide the customer with their letter
        res.end(`Your letter: ${letter}`);
        logger.debug(`5. Providing paid letter to customer for fulfillment ${fulfillmentBase64}`);
      }
    }

  }).listen(httpServerPort, () => {
    logger.info(`    - Listening on http://localhost:${httpServerPort}`);
    logger.info(` 3. Visit http://localhost:${httpServerPort} in your browser to buy a letter`)
  });

  // Handle incoming payment...
  plugin.on(`incoming_prepare`, (transfer) => {
    const transferAmount = parseInt(transfer.amount);
    if (transferAmount < cost) {
      // Tranfer amount is incorrect
      logger.debug(`    - Payment received for the wrong amount (${transfer.amount})... Rejected`);

      const normalisedAmount = transfer.amount / Math.pow(10, parseInt(ledgerInfo.currencyScale));

      plugin.rejectIncomingTransfer(transfer.id, {
        code: 'F04',
        name: 'Insufficient Destination Amount', 
        message:  `Please send at least ${cost} ${ledgerInfo.currencyCode}, you sent ${normalizedAmount}`,
        triggered_by: plugin.getAccount(),
        triggered_at: new Date().toISOString(),
        forwarded_by: [],
        additional_info: {}
      });
    } else {
      // Looking fulfillment from condition attached to incoming transfer
      const fulfillment = fulfillments[transfer.executionCondition];

      if (!fulfillment) {
        // We don't have a fulfillment for this condition
        logger.debug(`    - Payment received with an unknown condition: ${transfer.executionCondition}`);

        plugin.rejectIncomingTransfer(transfer.id, {
          code: `F05`,
          name: `Wrong condition`,
          message: `Unable to fulfill the condition:  ${transfer.executionCondition}`,
          triggered_by: plugin.getAccount(),
          triggered_at: new Date().toISOString(),
          forwarded_by: [],
          additional_info: {}
        });
      };

      logger.debug(` 4. Accepted payment with condition ${transfer.executionCondition}.`);

      logger.debug(`    - Fulfilling transfer on the ledger using fulfillment: ${base64url(fulfillment)}`);

      // The ledger will check if the fulfillment is correct and
      // if it was submitted before the transfer's rollback timeout
      plugin.fulfillCondition(transfer.id, base64url(fulfillment))
        .then(() => {
          logger.info(`    - Payment complete`);
        })
        .catch(() => {
          logger.error(`    - Error fulfilling the transfer`);
        });
    }
  });
});
