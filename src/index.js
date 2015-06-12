var _ = require('lodash-node');
var delayAsync = require('delay-async');
var dropbox = require('dropbox');
var events = require('events');
var fs = require('fs');
var moment = require('moment-timezone');
var mkdirp = require('mkdirp');
var path = require('path');
var secret = {
};
try {
  secret = require('@exponent/secret');
} catch (e) {
  console.error("You may want to install @exponent/secret or something similar");
}

function getClient() {
  return new dropbox.Client({
    token: secret.dropbox._ccheeverTestAccessToken,
    key: secret.dropbox.appKey,
    secret: secret.dropbox.appSecret,
  });
}

var testClient = null;
try {
  testClient = getClient();
} catch (e) {
  // Already gave an error
}

class DropboxSyncer extends events.EventEmitter {
  constructor(client, destFolder, opts) {

    super();
    this.client = client || getClient();
    this.destFolder = destFolder;
    this.opts = opts = opts || {};
    this.state = 'stopped';

    this.cursor = opts.cursor || null;
    this.emitter = opts.emitter || this;
    this._shouldStop = false;
    this.logger = opts.logger || console || {
      log: () => undefined,
      error: () => undefined,
      warn: () => undefined,
    };

  }

  startSyncing() {
    this._shouldStop = false;
    this.state = 'syncing';
    this._syncLoopAsync().then((result) => {
      if (result != null) {
        this.logger.log(result);
      }
    }).catch((err) => {
      if (this.opts.logger) {
        this.logger.error(err, err.stack);
      } else {
        console.error(err, err.stack);
      }
    });
    return this;
  }

  stopSyncingAsync() {
    this._shouldStop = true;
    return new Promise((fulfill, reject) => {
      this.emitter.on('stopped', fulfill);
    });
  }

  _stop() {
    this.state = 'stopped';
    this.emitter.emit('stopped', this.cursor);
    return this.cursor;
  }

  async _syncLoopAsync() {

    await mkdirp.promise(this.destFolder);

    if (this._shouldStop) { return this._stop(); }

    var newCursor = await this.syncAsync();

    if (this._shouldStop) { return this._stop(); }

    var result;
    do {
      this.logger.log("Polling for changes...");

      result = await this.client.promise.pollForChanges(newCursor);

      this.logger.log("Polled successfully");

      if (this._shouldStop) { return this._stop(); }

      if (!result) {
        // Not sure what to do here, so we'll just back off and try again in a bit
        this.logger.error("No response from polling; will retry");

        result = {hasChanges: false, retryAfter: 2000};
      } else {
        if (!result.hasChanges) {
          this.emitter.emit('updatedAsOf', Date.now());
        }
      }

      if (!result.hasChanges && result.retryAfter) {
        await delayAsync(result.retryAfter * 1000);
      }

    } while (!result.hasChanges && !this._shouldStop);

    if (this._shouldStop) { return this._stop(); }

    return this._syncLoopAsync();
  }

  async syncAsync() {
    var delta = await this.client.promise.delta(this.cursor);

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
      await Promise.all(awaitables);
    } catch (e) {
      this.logger.error("Error syncing (but will keep trying):", e.message);
      this.emitter.emit('errorIgnored', e);
      // TODO: Implement some kind of smart backoff
      await delayAsync(2000);
      return this.cursor;
    }

    // Update cursor to the new value since we've successfully updated
    this.cursor = newCursor;
    this.logger.log("New cursor is now", this.cursor);
    this.emitter.emit('syncedToCursor', this.cursor);
    this.emitter.emit('updatedAsOf', Date.now());
    return this.cursor;

  }

  async processChangeAsync(change) {
    var dest = path.join(this.destFolder, change.path);
    this.logger.log("Syncing to", dest, "...");
    if (change.wasRemoved) {

    } else if (change.stat.isFolder) {

      if (change.wasRemoved) {
        await fs.promise.rmdir(dest);
        this.emitter.emit('didRemove', dest, change);
      } else {
        await mkdirp.promise(dest);
        if (this.opts.logger) { this.opts.logger.log("Updating folder at", dest); }
        this.emitter.emit('didMkdirp', dest, change);
      }

    } else if (change.stat.isFile) {
      if (change.wasRemoved) {
        try {
          await fs.promise.unlink(dest);
        } catch (e) {
          if (e.message && e.message.match(/ENOENT:/)) {
            this.logger.error("Trying to remove file that's already gone, ignoring:", dest);
            this.emitter.emit('errorIgnored', e);
          } else {
            throw e;
          }
        }
        this.emitter.emit('didRemove', dest, change);
        this.logger.log("Removed", dest);
      } else {
        var contentsBuffer = await this.client.promise.readFile(change.path, {buffer: true});
        await fs.promise.writeFile(dest, contentsBuffer);
        this.emitter.emit('didWriteFile', dest, change);
      }
    } else {
      var err = new Error("I'm confused; I don't know how to deal with this kind of change");
      err.change = change;
      this.emitter.emit('errorConfused', err);
      throw err;
    }

    return true;

  }
}

module.exports = function (...args) {
  return new DropboxSyncer(...args);
};

_.assign(module.exports, {
  dropbox,
  DropboxSyncer,
  getClient,
  c: getClient(),
});
