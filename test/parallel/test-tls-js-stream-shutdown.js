'use strict';
const common = require('../common');
const StreamWrap = require('_stream_wrap');

if (!common.hasCrypto)
  common.skip('missing crypto');

const fixtures = require('../common/fixtures');

const assert = require('assert');
const net = require('net');
const tls = require('tls');

// TODO: Description.
{
  const server = tls.createServer({
    key: fixtures.readKey('agent1-key.pem'),
    cert: fixtures.readKey('agent1-cert.pem')
  }, common.mustCall()).listen(common.mustCall(() => {
    const { port } = server.address();
    const netSocket = net.connect({
      port,
    });
    // Here we wrap the socket in `StreamWrap` so that `tls.connect` won't
    // regard it as an instance of `net.Socket`.
    const streamWrap = new StreamWrap(netSocket);

    const socket = tls.connect({
      socket: streamWrap,
      rejectUnauthorized: false
    }, () => {
      // TODO:
      // Make sure that our buffer will make stream emit 'drain'.
      // TODO:
      const data = Buffer.allocUnsafe(socket.writableHighWaterMark * 3 + 1);
      netSocket.on('drain', common.mustCall());
      const res = socket.write(data);
      assert(!res);
      socket.end();
    });
  }));
}
