var assert = require("assert");
var nock = require('nock');
var discovery = require('./../discovery.js');
var constants = require('./testConstants.js');
var utils = require('./testUtils.js');
var fullUpdate;
var noUpdate;
var TOTAL_TEST_TIME = 3000;
var UPDATE_TIME_DELAY_MS = 2000;
var ACCEPTABLE_UPDATE_LAG = 50;

describe('# full-update followed by some updates tests', function() {
  beforeEach(function(done) {
    nock.cleanAll();
    nock.disableNetConnect();

    fullUpdate = nock(constants.DISCOVERY_URL)
      .get('/watch')
      .reply(200, {
        "fullUpdate": true,
        "index": 100,
        "deletes": [],
        "updates": [{
          "announcementId": "discovery",
          "staticAnnouncement": false,
          "announceTime": "2015-03-30T18:26:52.178Z",
          "serviceType": "discovery",
          "serviceUri": constants.DISCOVERY_SERVER_URLS[0]
        }, {
          "announcementId": "old",
          "staticAnnouncement": false,
          "announceTime": "2015-03-30T18:26:52.178Z",
          "serviceType": "my-service",
          "serviceUri": "http://1.1.1.1:2"
        }]
      });

    smallUpdate = nock(constants.DISCOVERY_SERVER_URLS[0])
      .get('/watch?since=' + 101)
      .delayConnection(UPDATE_TIME_DELAY_MS)
      .reply(200, {
        "fullUpdate": false,
        "index": 101,
        "deletes": ['old'],
        "updates": [{
          "announcementId": "new1",
          "staticAnnouncement": false,
          "announceTime": "2015-03-30T18:26:52.178Z",
          "serviceType": "my-service-new1",
          "serviceUri": "http://2.2.2.2:2"
        }, {
          "announcementId": "new2",
          "staticAnnouncement": false,
          "announceTime": "2015-03-30T18:26:52.178Z",
          "serviceType": "my-service-new2",
          "serviceUri": "http://3.3.3.3:3"
        }]
      });

    noUpdate = nock(constants.DISCOVERY_SERVER_URLS[0])
      .get('/watch?since=' + 102)
      .delayConnection(10000)
      .reply(204);

    done();
  });

  afterEach(function(done) {
    nock.cleanAll();
    nock.enableNetConnect();
    done();
  });

  it('should call watch, watch?since= and correctly populate announcements', function(done) {
    this.timeout(constants.TIMEOUT_MS);
    var disco = new discovery(constants.DISCOVERY_HOST, {
      logger: {
        log: function(level, log, update) {
          console.log(log);
        },
        error: function() {},
      }
    });

    disco.connect(function(error, host, servers) {
      fullUpdate.done();
      disco.disconnect();
    });

    var start = new Date();
    disco.onUpdate(function(arg1, arg2, arg3) {
      assert.fail(onUpdateReceived, true, 'We should never get an onUpdate after disconnecting!');
    });

    setTimeout(function() {
      assert(smallUpdate.isDone() === false);
      assert(noUpdate.isDone() === false, 'we should not get an update hit!');
      done();
    }, TOTAL_TEST_TIME);
  });
});