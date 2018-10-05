'use strict';

const assert = require('assert');
const util = require('util');
const { Socket } = require('net');
const { internalBinding } = require('internal/bootstrap/loaders');
const { JSStream } = internalBinding('js_stream');
const uv = internalBinding('uv');
const debug = util.debuglog('stream_wrap');
const { owner_symbol } = require('internal/async_hooks').symbols;
const { ERR_STREAM_WRAP } = require('internal/errors').codes;

const kCurrentWriteRequest = Symbol('kCurrentWriteRequest');
const kCurrentShutdownRequest = Symbol('kCurrentShutdownRequest');
const kWaitingStreamDrain = Symbol('kWaitingStreamDrain');

function isClosing() { return this[owner_symbol].isClosing(); }
function onreadstart() { return this[owner_symbol].readStart(); }
function onreadstop() { return this[owner_symbol].readStop(); }
function onshutdown(req) { return this[owner_symbol].tryShutdown(req); }
function onwrite(req, bufs) { return this[owner_symbol].doWrite(req, bufs); }

/* This class serves as a wrapper for when the C++ side of Node wants access
 * to a standard JS stream. For example, TLS or HTTP do not operate on network
 * resources conceptually, although that is the common case and what we are
 * optimizing for; in theory, they are completely composable and can work with
 * any stream resource they see.
 *
 * For the common case, i.e. a TLS socket wrapping around a net.Socket, we
 * can skip going through the JS layer and let TLS access the raw C++ handle
 * of a net.Socket. The flipside of this is that, to maintain composability,
 * we need a way to create "fake" net.Socket instances that call back into a
 * "real" JavaScript stream. JSStreamWrap is exactly this.
 */
class JSStreamWrap extends Socket {
  constructor(stream) {
    const handle = new JSStream();
    handle.close = (cb) => {
      debug('close');
      this.doClose(cb);
    };
    // Inside of the following functions, `this` refers to the handle
    // and `this[owner_symbol]` refers to this JSStreamWrap instance.
    handle.isClosing = isClosing;
    handle.onreadstart = onreadstart;
    handle.onreadstop = onreadstop;
    handle.onshutdown = onshutdown;
    handle.onwrite = onwrite;

    stream.pause();
    stream.on('error', (err) => this.emit('error', err));
    stream.on('drain', () => {
      // console.log('sub stream drain');
      this[kWaitingStreamDrain] = false;
      return this.emit('drain');
    });
    const ondata = (chunk) => {
      if (typeof chunk === 'string' ||
          stream._readableState.objectMode === true) {
        // Make sure that no further `data` events will happen.
        stream.pause();
        stream.removeListener('data', ondata);

        this.emit('error', new ERR_STREAM_WRAP());
        return;
      }

      debug('data', chunk.length);
      if (this._handle)
        this._handle.readBuffer(chunk);
    };
    stream.on('data', ondata);
    stream.once('end', () => {
      debug('end');
      if (this._handle)
        this._handle.emitEOF();
    });

    super({ handle, manualStart: true });
    this.stream = stream;
    this[kCurrentWriteRequest] = null;
    this[kCurrentShutdownRequest] = null;
    this[kWaitingStreamDrain] = false;
    this.readable = stream.readable;
    this.writable = stream.writable;

    // Start reading.
    this.read(0);
  }

  // Legacy
  static get StreamWrap() {
    return JSStreamWrap;
  }

  isClosing() {
    return !this.readable || !this.writable;
  }

  readStart() {
    this.stream.resume();
    return 0;
  }

  readStop() {
    this.stream.pause();
    return 0;
  }

  doShutdown(req) {
    assert.strictEqual(this[kCurrentWriteRequest], null);

    // console.log('js_stream shutdown');

    const handle = this._handle;

    setImmediate(() => {
      // Ensure that write is dispatched asynchronously.
      this.stream.end(() => {
        this.finishShutdown(handle, 0);
      });
    });
    return 0;
  }

  tryShutdown(req) {
    assert.strictEqual(this[kCurrentShutdownRequest], null);
    this[kCurrentShutdownRequest] = req;

    // TODO(addaleax): It might be nice if we could get into a state where
    // DoShutdown() is not called on streams while a write is still pending.
    //
    // Currently, the only part of the code base where that happens is the
    // TLS implementation, which calls both DoWrite() and DoShutdown() on the
    // underlying network stream inside of its own DoShutdown() method.
    // Working around that on the native side is not quite trivial (yet?),
    // so for now that is supported here.

    // console.log('this[kCurrentWriteRequest]', !!this[kCurrentWriteRequest]);
    if (this[kCurrentWriteRequest] !== null) {
      // console.log('this[kWaitingStreamDrain]', this[kWaitingStreamDrain]);
      if (this[kWaitingStreamDrain]) {
        // TODO: Make sure that whether this class will emit 'drain' or not.
        return this.on('drain', () => {
          // console.log('js_stream drain');
          return this.doShutdown(req);
        });
      }

      // The stream is writing but won't emit 'drain'. `finishWrite` is expected
      // to call `this.doShutdown`.
      return;
    }

    this.doShutdown();
  }

  // handle === this._handle except when called from doClose().
  finishShutdown(handle, errCode) {
    // The shutdown request might already have been cancelled.
    if (this[kCurrentShutdownRequest] === null)
      return;
    const req = this[kCurrentShutdownRequest];
    this[kCurrentShutdownRequest] = null;
    handle.finishShutdown(req, errCode);
  }

  doWrite(req, bufs) {
    assert.strictEqual(this[kCurrentWriteRequest], null);
    assert.strictEqual(this[kCurrentShutdownRequest], null);

    const handle = this._handle;
    const self = this;

    let pending = bufs.length;
    let shouldWaitDrain = false;

    const setShouldWaitDrainFalse = () => {
      // console.log('in doWrite drain');
      shouldWaitDrain = false;
    };
    // It's possible that this.stream emits 'drain' before all callbacks
    // of `stream.write()` get called. In that case, we should not set
    // kWaitingStreamDrain as false.
    this.stream.once('drain', setShouldWaitDrainFalse);

    this.stream.cork();
    for (var i = 0; i < bufs.length; ++i)
      if (!this.stream.write(bufs[i], done)) {
        shouldWaitDrain = true;
      }

    this.stream.uncork();

    // console.log('doWrite again');
    // Only set the request here, because the `write()` calls could throw.
    this[kCurrentWriteRequest] = req;

    function done(err) {
      if (!err && --pending !== 0)
        return;

      // Ensure that this is called once in case of error
      pending = 0;

      self.stream.removeListener('drain', setShouldWaitDrainFalse);
      // console.log('shouldWaitDrain', shouldWaitDrain);
      if (shouldWaitDrain) {
        self[kWaitingStreamDrain] = true;
      }

      let errCode = 0;
      if (err) {
        errCode = uv[`UV_${err.code}`] || uv.UV_EPIPE;
      }

      // Ensure that write was dispatched
      setImmediate(() => {
        self.finishWrite(handle, errCode);
      });
    }

    return 0;
  }

  // handle === this._handle except when called from doClose().
  finishWrite(handle, errCode) {
    // The write request might already have been cancelled.
    if (this[kCurrentWriteRequest] === null)
      return;
    const req = this[kCurrentWriteRequest];
    this[kCurrentWriteRequest] = null;

    handle.finishWrite(req, errCode);

    // console.log('finishWrite', !this[kWaitingStreamDrain], !!this[kCurrentShutdownRequest]);
    // `this[kCurrentShutdownRequest] === true` indicate that the
    // this instance is waiting for `doShutdown`.
    if (!this[kWaitingStreamDrain] && !!this[kCurrentShutdownRequest]) {
      this.doShutdown();
    }
  }

  doClose(cb) {
    const handle = this._handle;

    setImmediate(() => {
      // Should be already set by net.js
      assert.strictEqual(this._handle, null);

      this.finishWrite(handle, uv.UV_ECANCELED);
      this.finishShutdown(handle, uv.UV_ECANCELED);

      cb();
    });
  }
}

module.exports = JSStreamWrap;
// exposed for testing purposes only.
module.exports.kCurrentShutdownRequest = kCurrentShutdownRequest;
