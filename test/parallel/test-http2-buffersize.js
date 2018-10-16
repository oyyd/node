'use strict';

const { mustCall, hasCrypto, skip } = require('../common');
// TODO: should not skip
if (!hasCrypto)
  skip('missing crypto');
const assert = require('assert');
const { createServer, connect } = require('http2');
const Countdown = require('../common/countdown');

// This test ensures that `bufferSize` of Http2Session and Http2Stream work
// as expected.
{
  const ITER = 1;
  const BUFFER_SIZE = 10;
  const server = createServer();

  let serverSession;
  server.on('session', mustCall((session) => {
    serverSession = session;
    console.log('serverSession', serverSession)
  }))
  server.on('stream', mustCall((stream) => {
    stream.on('readable', () => {
      stream.read();
    });

    stream.on('end', mustCall());
  }, ITER));

  server.listen(0, mustCall(() => {
    const authority = `http://localhost:${server.address().port}`;
    const client = connect(authority);
    const countdown = new Countdown(ITER, () => {
      assert.strictEqual(client.bufferSize, 0);
      client.close();
      server.close();
    });

    client.once('connect', mustCall());

    for (let i = 0; i < ITER; i += 1) {
      const stream = client.request({ ':method': 'POST' });
      stream.on('response', mustCall(() => {
        stream.write(Buffer.allocUnsafe(BUFFER_SIZE), mustCall(() => {
          console.log('close')
          countdown.dec();
        }));

        assert.strictEqual(stream.bufferSize, BUFFER_SIZE);
        assert.strictEqual(client.bufferSize, (i + 1) * BUFFER_SIZE);

        // stream.on('close', mustCall());
        stream.close();
      }));
    }
  }));
}
