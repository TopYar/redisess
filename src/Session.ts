import util from "util";
import zlib from "zlib";
import {SessionManager} from './SessionManager';
import {RedisScript} from './RedisScript';
import {Redis} from 'ioredis';
import promisify from 'putil-promisify';

const unzip = util.promisify<Buffer, Buffer>(zlib.unzip);

interface SessionManagerAccess {
    _ns?: string;
    _additionalFields: string[];
    _killScript: RedisScript;
    _writeScript: RedisScript;

    _now(): number;

    _getClient(): Promise<Redis>;
}

export namespace Session {
    export interface Options {
        sessionId: string;
        userId?: string;
        ttl?: number;
    }
}

export class Session {

    private readonly _manager: SessionManagerAccess;
    private readonly _sessionId: string;
    private _userId: string;
    private _ttl: number;
    private _lastAccess: number;
    private _expires: number;

    /**
     *
     * @param {SessionManager} manager
     * @param {Object} opts
     * @param {string} opts.sessionId
     * @param {string} [opts.userId]
     * @param {number} [opts.ttl]
     * @constructor
     */
    constructor(manager: SessionManager, opts: Session.Options) {
        this._manager = manager as unknown as SessionManagerAccess;
        this._sessionId = opts.sessionId;
        this._userId = opts.userId || '';
        this._ttl = opts.ttl || 0;
        this._lastAccess = 0;
        this._expires = 0;
    }

    /**
     * Retrieves session id value
     *
     * @return {string}
     */
    get sessionId(): string {
        return this._sessionId;
    }

    /**
     * Retrieves user id value
     *
     * @return {string}
     */
    get userId(): string {
        return this._userId;
    }

    /**
     * Retrieves Time-To-Live value
     *
     * @return {number}
     */
    get ttl(): number {
        return this._ttl;
    }

    /**
     * Retrieves the time (unix) of last access
     *
     * @return {number}
     */
    get lastAccess(): number {
        return this._lastAccess;
    }

    /**
     * Retrieves the time (unix) that session be expired.
     *
     * @return {number}
     */
    get expires(): number {
        return this._expires;
    }

    /**
     * Retrieves duration that session be expired.
     *
     * @return {number}
     */
    get expiresIn(): number {
        return this._expires ?
            this._expires - this._manager._now() : 0;
    }

    get valid(): boolean {
        return !!(this._sessionId && this._userId && this._lastAccess);
    }

    /**
     * Retrieves idle duration in seconds
     *
     * @return {number}
     */
    get idle(): number {
        return this._manager._now() - this.lastAccess;
    }

    /**
     * Reads session info from redis server
     *
     * @return {Promise}
     */
    async read(): Promise<void> {
        const manager = this._manager;
        const sessKey = manager._ns + ':sess_' + this.sessionId;
        const client = await manager._getClient();
        const args = ['us', 'la', 'ex', 'ttl'];
        /* istanbul ignore else */
        if (manager._additionalFields) {
            for (const key of manager._additionalFields.keys())
                args.push('f' + key);
        }
        const resp = await promisify.fromCallback(cb => client.hmget(sessKey, ...args, cb));
        this._userId = resp[0] || '';
        this._lastAccess = Number(resp[1]) || 0;
        this._expires = Number(resp[2]) || 0;
        this._ttl = Number(resp[3]) || 0;
        /* istanbul ignore else */
        if (manager._additionalFields) {
            for (const [i, f] of manager._additionalFields.entries())
                this[f] = resp[4 + i];
        }
    }

    /**
     * Retrieves user data from session
     *
     * @param {string|Array<String>|Object<String,*>} key
     * @return {Promise<*>}
     */
    async get(key): Promise<any> {
        const manager = this._manager;
        const sessKey = manager._ns + ':sess_' + this.sessionId;
        const fromTyped = async (v) => {
            let x = v.substring(1);
            switch (v[0]) {
                case 'l': // Boolean
                    x = x === 'true';
                    break;
                case 'b':
                    x = Buffer.from(x, 'base64');
                    break;
                case 'd':
                    x = new Date(x);
                    break;
                case 'n':
                    x = Number(x);
                    break;
                case 'o':
                    x = JSON.parse((await unzip(Buffer.from(x, 'base64'))).toString());
                    break;
            }
            return x;
        };
        const client = await manager._getClient();

        // Prepare keys to query
        let keys;
        if (Array.isArray(key)) {
            keys = key.slice();
            for (const [i, k] of keys.entries())
                keys[i] = '$' + k;
        } else if (typeof key === 'object') {
            keys = Object.keys(key);
            for (const [i, k] of keys.entries())
                keys[i] = '$' + k;
        } else keys = ['$' + key];

        // Query values for keys
        const resp = await promisify.fromCallback(cb => client.hmget(sessKey, keys, cb));

        // Do type conversion
        for (const [i, v] of resp.entries())
            resp[i] = v !== null ? await fromTyped(v) : v;

        if (Array.isArray(key))
            return resp;
        if (typeof key === 'object') {
            for (const [i, k] of keys.entries()) {
                key[k.substring(1)] = resp[i];
            }
            return key;
        }
        return resp[0];
    }

    /**
     * Stores user data to session
     *
     * @param {Object} values
     * @return {Promise<number>}
     */
    async set(values: Record<string, any>): Promise<number>
    /**
     * Stores user data to session
     *
     * @param {string} [key]
     * @param {*} [value]
     * @return {Promise<number>}
     */
    async set(key: string, value: any): Promise<number>
    async set(arg0, arg1?): Promise<number> {
        const manager = this._manager;
        const sessKey = manager._ns + ':sess_' + this.sessionId;
        const client = await manager._getClient();
        const values = typeof arg0 === 'object' ?
            this._prepareUserData(arg0) : this._prepareUserData('' + arg0, arg1);
        const resp = await promisify.fromCallback(cb => client.hmset(sessKey, values, cb));
        /* istanbul ignore next */
        if (!String(resp).includes('OK'))
            throw new Error('Redis write operation failed');
        return Math.floor(values.length / 2);
    }

    /**
     * Kills the session
     *
     * @return {Promise}
     */
    async kill(): Promise<void> {
        const manager = this._manager;
        const client = await manager._getClient();
        const {sessionId, userId} = this;
        const resp = await manager._killScript.execute(client, manager._ns, sessionId, userId);
        /* istanbul ignore next */
        if (!resp)
            throw new Error('Unable to store session due to an unknown error');
    }

    /**
     *
     * @return {Promise}
     * @private
     */
    async write(): Promise<void> {
        const manager = this._manager;
        const client = await manager._getClient();
        this._lastAccess = manager._now();
        this._expires = this._ttl ?
            this._lastAccess + this._ttl : 0;

        const {sessionId, userId, lastAccess, expires, ttl} = this;
        const args = [manager._ns, lastAccess, userId, sessionId, expires, ttl];
        /* istanbul ignore else */
        if (manager._additionalFields)
            for (const f of manager._additionalFields)
                args.push(this[f] || null);

        const resp = await manager._writeScript.execute(client, ...args);
        /* istanbul ignore next */
        if (!resp)
            throw new Error('Unable to store session due to an unknown error');
    }

    private _prepareUserData(values: Record<string, any>): string[];
    private _prepareUserData(key, value): string[];
    private _prepareUserData(arg0, arg1?): string[] {
        const makeTyped = (v) => {
            if (typeof v === "boolean" || v instanceof Boolean)
                return 'l' + v.toString();
            if (v instanceof Buffer)
                return 'b' + v.toString('base64');
            if (v instanceof Date)
                return 'd' + v.toISOString();
            if (typeof v === 'number')
                return 'n' + String(v);
            if (typeof v === 'object')
                return 'o' + zlib.deflateSync(JSON.stringify(v)).toString('base64');
            return 's' + String(v);
        };
        let values: string[] = [];
        if (typeof arg0 === 'object') {
            for (const k of Object.keys(arg0)) {
                values.push('$' + k);
                values.push(makeTyped(arg0[k]));
            }
        } else values = ['$' + arg0, makeTyped(arg1)];
        return values;
    }

}
