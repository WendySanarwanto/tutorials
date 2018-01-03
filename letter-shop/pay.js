const IlpPacket = require('ilp-packet');
const plugin = require('./plugins.js').xrp.Customer();
const winston = require(`winston`);
const uuid = require('uuid/v4');

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
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const destinationAddress = process.argv[2];
const destinationAmount = process.argv[3];
const condition = process.argv[4];
const shopServerPort = 18000;

logger.info(`== Starting the payment client == `);
logger.debug(`destinationAddress = ${destinationAddress}\ndestinationAmount = ${destinationAmount}\ncondition = ${condition}`);
// Do something...
logger.info(`1. Connecting to an account to send payments...`);

plugin.connect().then(() => {
  const ledgerInfo = plugin.getInfo();
  const account = plugin.getAccount();

  logger.debug(`    - Connected to ledger: ${ledgerInfo.prefix}`)
  logger.debug(`    -- Account: ${account}`)
  logger.debug(`    -- Currency: ${ledgerInfo.currencyCode}`)
  logger.debug(`    -- CurrencyScale: ${ledgerInfo.currencyScale}`)

  // Make payment...
  logger.debug(` 2. Making payment to ${destinationAddress} using condition: ${condition}`);

  // send the trasfer
  plugin.sendTransfer({
    to: destinationAddress,
    amount: destinationAmount,
    executionCondition: condition,
    id: uuid(),
    from: account,
    ledger: ledgerInfo.prefix,
    ilp: base64url(IlpPacket.serializeIlpPayment({
      amount: destinationAmount,
      account: destinationAddress
    })),
    expiresAt: new Date(new Date().getTime() + 1000000).toISOString()
  }).then(() => {
    logger.info('    - Transfer prepared, waiting for fulfillment...')
  }, (err) => {
    logger.error(err.message);
  });
  
  // Listen for fulfillments...
  // Handle fulfillments
  plugin.on(`outgoing_fulfill`, (transferId, fulfillmentBase64) => {
    logger.debug(`    - Transfer with ID=${transferId} is executed. Got fulfillment: ${fulfillmentBase64} `);
    logger.debug(` 3. Collect your letter at http://localhost:${shopServerPort}/${fulfillmentBase64}`);
    plugin.disconnect();
    process.exit();
  });
});