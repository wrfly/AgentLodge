/**
 * The install script, served so it can be read before it is run.
 *
 * It is the same for everybody and carries no secret — the key arrives as an argument — so
 * it needs no authentication, and serving it means the console shows one line instead of
 * seventy. The console still renders the whole thing behind a fold: `curl … | sh` is only
 * as good as the reader's ability to look first.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../../core/config.js';
import { tr } from '../../core/i18n/locale.js';
import { type InstallText, installScript } from '../cli-install.js';

/**
 * The address to write into the script.
 *
 * PUBLIC_GATEWAY_URL when it is set, because behind a reverse proxy that is the only thing
 * that knows the outside address; otherwise the request's own, which is exactly right on a
 * single machine and in development.
 */
export function publicBase(req: FastifyRequest): string {
  return config.publicGatewayUrl || `${req.protocol}://${req.host}`;
}

/** The messages the script prints, in the language the request asked for */
export function installText(req: FastifyRequest): InstallText {
  return {
    installed: tr(req, 'AgentLodge: claude now runs against this server.'),
    openShell: tr(req, 'open a new terminal, then run: claude'),
    keyFile: tr(req, 'to swap the key later, edit this file:'),
    undo: tr(req, 'undo:'),
    noClaude: tr(req, 'claude was not found on PATH. Install Claude Code first, then run this again.'),
    usage: tr(req, 'This script takes your key as an argument: … | sh -s -- al_xxxxx'),
    noKeyFile: tr(req, 'AgentLodge: the key file is missing. Put the key back, or install again.'),
  };
}

export function registerCliRoutes(app: FastifyInstance): void {
  app.get('/api/cli/install.sh', async (req, reply) => {
    // text/plain rather than a shell type: this is meant to open in a browser as readable
    // text, not to be offered as a download
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return installScript(publicBase(req), installText(req));
  });
}
