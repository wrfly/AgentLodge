import { SignJWT, jwtVerify } from 'jose';
import { config } from '../core/config.js';
import type { AgentId } from '../core/protocol.js';

/**
 * The runtime token — the only credential an agent process ever holds.
 *
 * It is not the upstream key. It is a short-lived ticket bound to
 * (user, conversation, turn). The agent calls the gateway with it; the gateway attributes
 * billing, checks quota, and swaps it for the real key on the way upstream. So the real
 * key never appears in a container or a child process, and metering cannot be bypassed.
 */

const secret = new TextEncoder().encode(config.jwtSecret);
const ISSUER = 'agentlodge-gateway';

export interface RuntimeClaims {
  /** userId */
  sub: string;
  cid: string;
  tid: string;
  agent: AgentId;
  /**
   * Whether this turn wants the agent's thinking.
   *
   * It rides on the ticket rather than being read from the conversation per request, so a
   * turn keeps the setting it started with — the same rule the model and the effort follow,
   * both of which are fixed when the process is launched. Flipping the switch mid-answer
   * would otherwise change the shape of the requests inside one turn.
   */
  thinking: boolean;
}

export async function signRuntimeToken(claims: RuntimeClaims, ttlMs: number): Promise<string> {
  return new SignJWT({ cid: claims.cid, tid: claims.tid, agent: claims.agent, think: claims.thinking })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${Math.ceil(ttlMs / 1000)}s`)
    .sign(secret);
}

export async function verifyRuntimeToken(token: string): Promise<RuntimeClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (typeof payload.sub !== 'string' || typeof payload.cid !== 'string') return null;
    return {
      sub: payload.sub,
      cid: payload.cid,
      tid: String(payload.tid ?? ''),
      agent: payload.agent as AgentId,
      // A ticket signed before the switch existed carries no claim, and what it meant was
      // "thinking", because nothing turned it off then
      thinking: payload.think !== false,
    };
  } catch {
    return null;
  }
}
