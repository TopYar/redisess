/* eslint-disable */
require('./support/env');
const assert = require('assert');
const redisess = require('..');
const Redis = require('ioredis');
const waterfall = require('putil-waterfall');

describe('SessionManager', function() {

  let redis;
  let sm;
  let sessionIds = [];
  let _now;

  before((done) => {
    redis = new Redis();
    redis.once('ready', done);
    redis.once('error', done);
    sm = redisess(redis, 'myapp', {
      namespace: 'smtest',
      wipeInterval: 60000
    });
  });

  before(() => sm.killAll());

  after((done) => {
    redis.quit(done);
  });

  it('should constructor validate arguments', function() {
    assert.throws(() => {
      redisess();
    }, /You must provide redis instance/);
    assert.throws(() => {
      redisess(redis);
    }, /You must provide application name/);
    redisess(redis, 'myapp');
  });

  it('should set namespace while construct', function() {
    const sm = redisess(redis, 'myapp', {namespace: 'abc'});
    assert.strictEqual(sm.namespace, 'abc');
  });

  it('should set ttl while construct', function() {
    const sm = redisess(redis, 'myapp', {ttl: 60});
    assert.strictEqual(sm._ttl, 60);
  });

  it('should create() validate arguments', function() {
    return assert.rejects(() => sm.create(),
        /You must provide userId/);
  });

  it('should get() validate arguments', function() {
    return assert.rejects(() => sm.get(),
        /You must provide sessionId/);
  });

  it('should getUserSessions() validate arguments', function() {
    return assert.rejects(() => sm.getUserSessions(),
        /You must provide userId/);
  });

  it('should exists() validate arguments', function() {
    return assert.rejects(() => sm.exists(),
        /You must provide sessionId/);
  });

  it('should kill() validate arguments', function() {
    return assert.rejects(() => sm.kill(),
        /You must provide sessionId/);
  });

  it('should killUser() validate arguments', function() {
    return assert.rejects(() => sm.killUser(),
        /You must provide userId/);
  });

  it('should now() return redis server time', function() {
    return sm.now().then((n) => {
      assert(n);
      _now = n;
    });
  });

  it('should create session', function() {
    let t = _now - 10;
    return waterfall.every([1, 1, 1, 2, 3, 2, 1, 4, 2, 5], (next, k, i) => {
      sm._now = () => (t - (i * 10));
      return sm.create('user' + k, {ttl: 50}).then((sess) => {
        delete sm._now;
        assert(sess);
        assert(sess.sessionId);
        assert.strictEqual(sess.userId, 'user' + k);
        assert.strictEqual(sess.idle, i * 10 + 10);
        assert.strictEqual(sess.manager, sm);
        assert.strictEqual(sess.expiresIn, 50 - (i * 10 + 10));
        sessionIds.push(sess.sessionId);
      });
    });
  });

  it('should count() return session count', function() {
    return sm.count().then((c) => {
      assert.strictEqual(c, 10);
    });
  });

  it('should count() return active session count which active within given time', function() {
    return sm.count(40).then((c) => {
      assert.strictEqual(c, 4);
    });
  });

  it('should getAllSession() return all session ids', function() {
    return sm.getAllSession().then((sessions) => {
      assert(sessions);
      assert.strictEqual(Object.keys(sessions).length, 10);
    });
  });

  it('should getAllSession() return all session ids  which active within given time', function() {
    return sm.getAllSession(20).then((sessions) => {
      assert(sessions);
      assert.strictEqual(Object.keys(sessions).length, 2);
    });
  });

  it('should getUserSessions() return all session ids of user', function() {
    return sm.getUserSessions('user1').then((sessions) => {
      assert(sessions);
      assert.strictEqual(Object.keys(sessions).length, 4);
    });
  });

  it('should getUserSessions() return all session ids of user which active within given time', function() {
    return sm.getUserSessions('user1', 50).then((sessions) => {
      assert(sessions);
      assert.strictEqual(Object.keys(sessions).length, 3);
    });
  });

  it('should getAllUsers() return all user ids', function() {
    return sm.getAllUsers().then((users) => {
      assert(users);
      assert.strictEqual(Object.keys(users).length, 5);
    });
  });

  it('should getAllUsers() return all user ids which active within given time', function() {
    return sm.getAllUsers(50).then((sessions) => {
      assert(sessions);
      assert.strictEqual(Object.keys(sessions).length, 1);
    });
  });

  it('should create session with default options', function() {
    sm._now = () => _now - 200;
    return sm.create('user7').then((sess) => {
      delete sm._now;
      assert(sess);
      assert(sess.sessionId);
      assert.strictEqual(sess.ttl, 30 * 60);
    });
  });

  it('should get session without updating idle time', function() {
    return sm.get(sessionIds[0], true).then((sess) => {
      assert(sess);
      assert(sess.sessionId);
      assert(sess.userId = 'user2');
      assert(sess.idle > 0);
    });
  });

  it('should get session with updating idle time (default)', function() {
    return sm.get(sessionIds[0]).then((sess) => {
      assert(sess);
      assert(sess.sessionId);
      assert(sess.userId = 'user2');
      assert.strictEqual(sess.idle, 0);
    });
  });

  it('should exists() check if session exists', function() {
    return sm.exists(sessionIds[0])
        .then((b) => assert(b))
        .then(() => sm.exists('unknown')
            .then((b) => assert(!b)));
  });

  it('should kill() remove session', function() {
    const sessionId = sessionIds.pop();
    return waterfall([
      () => sm.kill(sessionId).then((b) => assert(b)),
      () => sm.exists(sessionId).then((b) => assert(!b)),
      () => sm.get(sessionId).then((sess) => assert(!sess))
    ]);
  });

  it('should killUser() remove all sessions of the user', function() {
    let sessionId;
    return waterfall([
      () => sm.getUserSessions('user4').then(ids => {sessionId = ids[0];}),
      () => sm.exists(sessionId).then(b => assert.strictEqual(b, true)),
      () => sm.killUser('user4').then(b => assert.strictEqual(b, true)),
      () => sm.exists(sessionId).then(b => assert.strictEqual(b, false))
    ]);
  });

  it('should wipe expired sessions', function() {
    return sm._wipe().then(() => {
      return sm.count().then(c => assert.strictEqual(c, 5));
    });
  });

  it('should killAll() remove all sessions of the user', function() {
    return waterfall([
      () => sm.count().then(c => assert(c > 0)),
      () => sm.killAll(),
      () => sm.count().then(c => assert.strictEqual(c, 0))
    ]);
  });

  it('should create immutable session', function() {
    return sm.create('user6', {ttl: 0}).then((sess) => {
      assert(sess);
      assert(sess.sessionId);
      assert.strictEqual(sess.ttl, 0);
    });
  });

  it('should wipe periodically', function(done) {
    this.slow(500);
    sm._wipeInterval = 1;
    const oldWipe = sm._wipe;
    let k = 0;
    sm._wipe = () => {
      k++;
      oldWipe.call(sm);
    };
    sm._wipe();
    setTimeout(() => {
      sm._wipeInterval = 6000;
      sm._wipe = oldWipe;
      if (k > 5)
        return done();
      done(new Error('Failed'));
    }, 100);
  });

});
