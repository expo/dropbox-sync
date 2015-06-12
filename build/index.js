'use strict';

var _inherits = require('babel-runtime/helpers/inherits')['default'];

var _get = require('babel-runtime/helpers/get')['default'];

var _createClass = require('babel-runtime/helpers/create-class')['default'];

var _classCallCheck = require('babel-runtime/helpers/class-call-check')['default'];

var _asyncToGenerator = require('babel-runtime/helpers/async-to-generator')['default'];

var _bind = require('babel-runtime/helpers/bind')['default'];

var _Promise = require('babel-runtime/core-js/promise')['default'];

var _ = require('lodash-node');
var delayAsync = require('delay-async');
var dropbox = require('dropbox');
var events = require('events');
var fs = require('fs');
var moment = require('moment-timezone');
var mkdirp = require('mkdirp');
var path = require('path');
var secret = {};
try {
  secret = require('@exponent/secret');
} catch (e) {
  console.error('You may want to install @exponent/secret or something similar');
}

function getClient() {
  return new dropbox.Client({
    token: secret.dropbox._ccheeverTestAccessToken,
    key: secret.dropbox.appKey,
    secret: secret.dropbox.appSecret
  });
}

var testClient = null;
try {
  testClient = getClient();
} catch (e) {}

var DropboxSyncer = (function (_events$EventEmitter) {
  function DropboxSyncer(client, destFolder, opts) {
    _classCallCheck(this, DropboxSyncer);

    _get(Object.getPrototypeOf(DropboxSyncer.prototype), 'constructor', this).call(this);
    this.client = client || getClient();
    this.destFolder = destFolder;
    this.opts = opts = opts || {};
    this.state = 'stopped';

    this.cursor = opts.cursor || null;
    this.emitter = opts.emitter || this;
    this._shouldStop = false;
    this.logger = opts.logger || console || {
      log: function log() {
        return undefined;
      },
      error: function error() {
        return undefined;
      },
      warn: function warn() {
        return undefined;
      }
    };
  }

  _inherits(DropboxSyncer, _events$EventEmitter);

  _createClass(DropboxSyncer, [{
    key: 'startSyncing',
    value: function startSyncing() {
      var _this = this;

      this._shouldStop = false;
      this.state = 'syncing';
      this._syncLoopAsync().then(function (result) {
        if (result != null) {
          _this.logger.log(result);
        }
      })['catch'](function (err) {
        if (_this.opts.logger) {
          _this.logger.error(err, err.stack);
        } else {
          console.error(err, err.stack);
        }
      });
      return this;
    }
  }, {
    key: 'stopSyncingAsync',
    value: function stopSyncingAsync() {
      var _this2 = this;

      this._shouldStop = true;
      return new _Promise(function (fulfill, reject) {
        _this2.emitter.on('stopped', fulfill);
      });
    }
  }, {
    key: '_stop',
    value: function _stop() {
      this.state = 'stopped';
      this.emitter.emit('stopped', this.cursor);
      return this.cursor;
    }
  }, {
    key: '_syncLoopAsync',
    value: _asyncToGenerator(function* () {

      yield mkdirp.promise(this.destFolder);

      if (this._shouldStop) {
        return this._stop();
      }

      var newCursor = yield this.syncAsync();

      if (this._shouldStop) {
        return this._stop();
      }

      var result;
      do {
        this.logger.log('Polling for changes...');

        result = yield this.client.promise.pollForChanges(newCursor);

        this.logger.log('Polled successfully');

        if (this._shouldStop) {
          return this._stop();
        }

        if (!result) {
          // Not sure what to do here, so we'll just back off and try again in a bit
          this.logger.error('No response from polling; will retry');

          result = { hasChanges: false, retryAfter: 2000 };
        } else {
          if (!result.hasChanges) {
            this.emitter.emit('updatedAsOf', Date.now());
          }
        }

        if (!result.hasChanges && result.retryAfter) {
          yield delayAsync(result.retryAfter * 1000);
        }
      } while (!result.hasChanges && !this._shouldStop);

      if (this._shouldStop) {
        return this._stop();
      }

      return this._syncLoopAsync();
    })
  }, {
    key: 'syncAsync',
    value: _asyncToGenerator(function* () {
      var delta = yield this.client.promise.delta(this.cursor);

      if (!delta) {
        return this.cursor;
      }

      var newCursor = delta.cursorTag;

      var awaitables = [];
      for (var change of delta.changes) {
        this.emitter.emit('changeTo', change.path, change);
        awaitables.push(this.processChangeAsync(change));
      }

      try {
        yield _Promise.all(awaitables);
      } catch (e) {
        this.logger.error('Error syncing (but will keep trying):', e.message);
        this.emitter.emit('errorIgnored', e);
        // TODO: Implement some kind of smart backoff
        yield delayAsync(2000);
        return this.cursor;
      }

      // Update cursor to the new value since we've successfully updated
      this.cursor = newCursor;
      this.logger.log('New cursor is now', this.cursor);
      this.emitter.emit('syncedToCursor', this.cursor);
      this.emitter.emit('updatedAsOf', Date.now());
      return this.cursor;
    })
  }, {
    key: 'processChangeAsync',
    value: _asyncToGenerator(function* (change) {
      var dest = path.join(this.destFolder, change.path);
      this.logger.log('Syncing to', dest, '...');
      if (change.wasRemoved) {} else if (change.stat.isFolder) {

        if (change.wasRemoved) {
          yield fs.promise.rmdir(dest);
          this.emitter.emit('didRemove', dest, change);
        } else {
          yield mkdirp.promise(dest);
          if (this.opts.logger) {
            this.opts.logger.log('Updating folder at', dest);
          }
          this.emitter.emit('didMkdirp', dest, change);
        }
      } else if (change.stat.isFile) {
        if (change.wasRemoved) {
          try {
            yield fs.promise.unlink(dest);
          } catch (e) {
            if (e.message && e.message.match(/ENOENT:/)) {
              this.logger.error('Trying to remove file that\'s already gone, ignoring:', dest);
              this.emitter.emit('errorIgnored', e);
            } else {
              throw e;
            }
          }
          this.emitter.emit('didRemove', dest, change);
          this.logger.log('Removed', dest);
        } else {
          var contentsBuffer = yield this.client.promise.readFile(change.path, { buffer: true });
          yield fs.promise.writeFile(dest, contentsBuffer);
          this.emitter.emit('didWriteFile', dest, change);
        }
      } else {
        var err = new Error('I\'m confused; I don\'t know how to deal with this kind of change');
        err.change = change;
        this.emitter.emit('errorConfused', err);
        throw err;
      }

      return true;
    })
  }]);

  return DropboxSyncer;
})(events.EventEmitter);

module.exports = function () {
  for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
    args[_key] = arguments[_key];
  }

  return new (_bind.apply(DropboxSyncer, [null].concat(args)))();
};

_.assign(module.exports, {
  dropbox: dropbox,
  DropboxSyncer: DropboxSyncer,
  getClient: getClient,
  c: getClient()
});

// Already gave an error
//# sourceMappingURL=sourcemaps/index.js.map