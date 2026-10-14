// Preloaded with --require in integration tests: any network attempt fails loudly.
const net = require("node:net");
const dns = require("node:dns");
const fail = (what) => {
  process.stderr.write(`NETWORK ATTEMPT: ${what}\n`);
  process.exit(99);
};
net.Socket.prototype.connect = function () {
  fail("socket.connect");
};
dns.lookup = () => fail("dns.lookup");
dns.promises.lookup = () => fail("dns.promises.lookup");
globalThis.fetch = () => fail("fetch");
