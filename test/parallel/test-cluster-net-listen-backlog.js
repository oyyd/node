'use strict';

const common = require('../common');
const Countdown = require('../common/countdown');

const assert = require('assert');
// Monkey-patch `net.Server._listen2`
const net = require('net');
const cluster = require('cluster');
const tmpdir = require('../common/tmpdir');
tmpdir.refresh();

// Ensures that the `backlog` is used to create a `net.Server`.
const kExpectedBacklog = 127;
if (cluster.isMaster) {
  const unixDomainSocketPath = common.PIPE;
  const workers = [];
  const countdown = new Countdown(3, () => {
    workers.forEach((worker) => {
      worker.disconnect();
    });
  });

  const nativeListen = net.Server.prototype._listen2;
  net.Server.prototype._listen2 = common.mustCall(
    function(address, port, addressType, backlog, fd, flags) {
      assert(backlog, kExpectedBacklog);
      nativeListen.call(this, address, port, addressType, backlog, fd, flags);
    },
    2
  );

  for (let i = 0; i < 3; i += 1) {
    const worker = cluster.fork();
    worker.send(unixDomainSocketPath);
    worker.on('message', () => {
      countdown.dec();
    });
    workers.push(worker);
  }
} else {
  process.on('message', (unixDomainSocketPath) => {
    const countdown = new Countdown(2, () => {
      // Tell the master process all servers emit 'listening'.
      process.send(true);
    });

    net.createServer().listen({
      host: common.localhostIPv4,
      port: 0,
      backlog: kExpectedBacklog,
    }, common.mustCall(() => {
      countdown.dec();
    }));

    net.createServer().listen(unixDomainSocketPath, kExpectedBacklog, () => {
      countdown.dec();
    });
  });
}
