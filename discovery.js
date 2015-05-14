/*jslint node: true */
"use strict";
var request = require("request");
var uuid = require('node-uuid');

/*
 * DiscoveryClient constructor.
 * Creates a new uninitialized DiscoveryClient.
 */
function DiscoveryClient(host, options) {
  this.host = host;
  this.state = {
    announcements: {},
    disconnectDiscoFlag: false
  };
  this.logger = (options && options.logger) || require("ot-logger");
  this.errorHandlers = [this.logger.log.bind(this.logger, 'error', 'Discovery error: ')];
  this.watchers = [this._update.bind(this), this.logger.log.bind(this.logger, 'debug', 'Discovery update: ')];
  this.announcements = [];
  this.backoff = 1;
  this._announceIntervals = [];
}

/* Increase the watch backoff interval */
DiscoveryClient.prototype._backoff = function() {
  this.backoff = Math.min(this.backoff * 2, 10240);
};

/* Reset the watch backoff interval */
DiscoveryClient.prototype._unbackoff = function() {
  this.backoff = 1;
};

DiscoveryClient.prototype._randomServer = function() {
  return this.servers[Math.floor(Math.random() * this.servers.length)];
};

/* Consume a WatchResult from the discovery server and update internal state */
DiscoveryClient.prototype._update = function (update) {
  var disco = this;
  if (update.fullUpdate) {
    Object.keys(disco.state.announcements).forEach(function (id) { delete disco.state.announcements[id]; });
  }
  disco.state.index = update.index;
  update.deletes.forEach(function (id) { delete disco.state.announcements[id]; });
  update.updates.forEach(function (announcement) { disco.state.announcements[announcement.announcementId] = announcement; });
};

/* Connect to the Discovery servers given the endpoint of any one of them */
DiscoveryClient.prototype.connect = function(onComplete) {
  var disco = this;
  disco.state.disconnectDiscoFlag = false;
  
  request({
    url: "http://" + this.host + "/watch",
    json: true
  }, function(error, response, update) {
    if (error) {
      onComplete(error);
      return;
    }
    if (response.statusCode !== 200) {
      onComplete(new Error("Unable to initiate discovery: " + JSON.stringify(update)), undefined, undefined);
      return;
    }

    if (!update.fullUpdate) {
      onComplete(new Error("Expecting a full update: " + JSON.stringify(update)), undefined, undefined);
      return;
    }

    disco.logger.log('debug', 'Discovery update: ' + JSON.stringify(update));
    disco._update(update);

    disco.servers = [];

    Object.keys(disco.state.announcements).forEach(function(id) {
      var announcement = disco.state.announcements[id];
      if (announcement.serviceType === "discovery") {
        disco.servers.push(announcement.serviceUri);
      }
    });
    if (disco.state.disconnectDiscoFlag === false) {
      disco._schedulePoll();
      disco._announceIntervals.push(setInterval(disco._announce.bind(disco), 10000));
    }

    onComplete(undefined, disco.host, disco.servers);
  });
};

DiscoveryClient.prototype.reconnect = function(onComplete) {
  var disco = this;
  if (disco.state.disconnectDiscoFlag) {
    return;
  }
  disco.logger.log('info', 'Attempting to reconnect to Discovery on: ' + disco.host);
  disco.reconnectScheduled = false;
  disco.state.index = -1;
  request({
    url: "http://" + disco.host + "/watch?since=" + (this.state.index),
    json: true
  }, function(error, response, update) {
    if (error) {
      disco.logger.log('error', 'Could not reconnect to Discovery on: ' + disco.host);
      disco._scheduleReconnect();
      return;
    }
    if (response.statusCode !== 200) {
      disco.logger.log('error', 'Could not reconnect to Discovery on: ' + disco.host);
      disco._scheduleReconnect();
      return;
    }

    if (!update.fullUpdate) {
      disco.logger.log('error', 'Expecting a full update: ' + JSON.stringify(update));
      disco._scheduleReconnect();
      return;
    }

    disco.logger.log('info', 'Reconnected toDiscovery on ' + disco.host);

    disco._update(update);
    disco.servers = [];
    Object.keys(disco.state.announcements).forEach(function(id) {
      var announcement = disco.state.announcements[id];
      if (announcement.serviceType === "discovery") {
        disco.servers.push(announcement.serviceUri);
      }
    });

    disco._unbackoff();
    disco._schedulePoll();
  });
};

/* Stops internal scheduling.  Not meant for client use but rather for testing scenarios */
DiscoveryClient.prototype.disconnect = function() {
  this.state.disconnectDiscoFlag = true;

  this._announceIntervals.forEach(function(interval){
    clearInterval(interval);
  });

};

/* Register a callback on every discovery update */
DiscoveryClient.prototype.onUpdate = function(watcher) {
  this.watchers.push(watcher);
};

/* Register a callback on every error */
DiscoveryClient.prototype.onError = function(handler) {
  this.errorHandlers.push(handler);
};

/* Internal scheduling method.  Schedule the next poll in the event loop */
DiscoveryClient.prototype._schedulePoll = function() {
  if (this.state.disconnectDiscoFlag) {
   return;
 }

  if (!this.servers.length) {
    this._scheduleReconnect();
    return;
  }
  setImmediate(this.poll.bind(this));
};

DiscoveryClient.prototype._scheduleReconnect = function() {
  if (this.reconnectScheduled) {
    return;
  }

  this.reconnectScheduled = true;
  var c = this.reconnect.bind(this);
  if (this.backoff <= 1) {
    setImmediate(c);
  } else {
    setTimeout(c, this.backoff).unref();
  }
  this._backoff();
};

/* Long-poll the discovery server for changes */
DiscoveryClient.prototype.poll = function() {
  if (this.state.disconnectDiscoFlag) {
    return;
  }

  var disco = this;
  var server = this._randomServer();
  var url = server + "/watch?since=" + (this.state.index + 1);
  request({
    url: url,
    json: true
  }, function(error, response, body) {
    if (error) {
      disco.errorHandlers.forEach(function(h) {
        h(error);
      });
      disco.dropServer(server);
      disco._schedulePoll();
      return;
    }
    if (response.statusCode === 204) {
      disco._schedulePoll();
      return;
    }
    if (response.statusCode !== 200) {
      var err = new Error("Bad status code " + response.statusCode + " from watch: " + response);
      disco.errorHandlers.forEach(function(h) {
        h(err);
      });
      disco.dropServer(server);
      disco._schedulePoll();
      return;
    }
    disco.watchers.forEach(function(w) {
      w(body);
    });
    if (!disco.state.disconnectDiscoFlag) {
      disco._schedulePoll();
    }
  });
};

DiscoveryClient.prototype.dropServer = function(server) {
  this.logger.log('info', 'Dropping discovery server ' + server);
  this.servers.splice(this.servers.indexOf(server), 1);
};

/* Lookup a service by service type!
 * Accepts one of:
 *   serviceType as string
 *   serviceType:feature as string
 *   predicate function over announcement object
 */
DiscoveryClient.prototype.findAll = function(predicate) {
  var disco = this;
  var candidates = [];

  if (typeof(predicate) !== "function") {
    var serviceType = predicate;
    predicate = function(a) {
      return a.serviceType === serviceType || a.serviceType + ":" + a.feature === serviceType;
    };
  }

  Object.keys(disco.state.announcements).forEach(function(id) {
    var a = disco.state.announcements[id];
    if (predicate(a)) {
      candidates.push(a.serviceUri);
    }
  });

  return candidates;
};

DiscoveryClient.prototype.find = function(predicate) {
  var candidates = this.findAll(predicate);
  if (candidates.length === 0) {
    return undefined;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
};

DiscoveryClient.prototype._announce = function() {
  var disco = this;

  function cb(error, announcement) {
    if (error) {
      disco.errorHandlers.forEach(function(h) {
        h(error);
      });
    }
  }
  this.announcements.forEach(function(a) {
    disco._singleAnnounce(a, cb);
  });
};

DiscoveryClient.prototype._singleAnnounce = function(announcement, cb) {
  var disco = this;
  announcement.announcementId = announcement.announcementId || uuid.v4();
  var server = this._randomServer();
  if (!server) {
    this.logger.log('info', 'Cannot announce. No discovery servers available');
    cb(new Error('Cannot announce. No discovery servers available'));
    disco._scheduleReconnect();
    return;
  }
  this.logger.log('debug', 'Announcing ' + JSON.stringify(announcement));
  request({
    url: server + "/announcement",
    method: "POST",
    json: true,
    body: announcement
  }, function(error, response, body) {
    if (error) {
      disco.dropServer(server);
      cb(error);
      return;
    }
    if (response.statusCode !== 201) {
      cb(new Error("During announce, bad status code " + response.statusCode + ": " + JSON.stringify(body)));
      return;
    }
    cb(undefined, body);
  });
};

/* Announce ourselves to the registry */
DiscoveryClient.prototype.announce = function(announcement, cb) {
  var disco = this;
  this._singleAnnounce(announcement, function(error, a) {
    if (error) {
      cb(error);
      return;
    }
    disco.logger.log("info", "Announced as " + JSON.stringify(a));
    disco.announcements.push(a);
    cb(undefined, a);
  });
};

/* Remove a previous announcement.  The passed object *must* be the
 * lease as returned by the 'announce' callback. */
DiscoveryClient.prototype.unannounce = function(announcement, callback) {
  var disco = this;
  var server = disco._randomServer();
  var url = server + "/announcement/" + announcement.announcementId;
  disco.announcements.splice(disco.announcements.indexOf(announcement), 1);
  request({
    url: url,
    method: "DELETE"
  }, function(error, response, body) {
    if (error) {
      disco.logger.log('error', error);
    } else {
      disco.logger.log("info", "Unannounce DELETE '" + url + "' returned " + response.statusCode + ": " + JSON.stringify(body));
    }
    if (callback) {
      callback();
    }
  });
};

module.exports = DiscoveryClient;