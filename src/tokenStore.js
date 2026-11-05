// Storage for Onshape OAuth tokens, one entry per Onshape user id.
//
// SessionTokenStore (the one MatePilot uses) keeps them inside the browser's encrypted
// session cookie (see session.js), so they survive server restarts and need no disk or
// database. The browser can't read them: only the server holds the key.
// MemoryTokenStore has the same get/set/delete methods and is used by the tests.
import { currentSession } from './session.js';

export class MemoryTokenStore {
  #byUser = new Map();

  /** Returns { accessToken, refreshToken, expiresAt, user } or undefined. */
  async get(userId) {
    return this.#byUser.get(userId);
  }

  async set(userId, tokens) {
    this.#byUser.set(userId, tokens);
  }

  async delete(userId) {
    this.#byUser.delete(userId);
  }
}

/** Reads and writes the tokens in the current request's session, if it belongs to userId. */
export class SessionTokenStore {
  #session(userId) {
    const s = currentSession();
    return s && userId && s.userId === userId ? s : null;
  }

  async get(userId) {
    return this.#session(userId)?.tokens ?? undefined;
  }

  async set(userId, tokens) {
    const s = this.#session(userId);
    if (s) s.tokens = tokens;
  }

  async delete(userId) {
    const s = this.#session(userId);
    if (s) s.tokens = null;
  }
}

export const tokenStore = new SessionTokenStore();
