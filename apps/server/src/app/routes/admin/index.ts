/**
 * Where the console's routes are assembled.
 *
 * This was one 550-line admin.ts with eight concerns in it. Split up, each file does one
 * thing, and adding a console feature no longer means finding a place in a long file.
 */
import type { FastifyInstance } from 'fastify';
import * as overview from './overview.js';
import * as users from './users.js';
import * as pricing from './pricing.js';
import * as invites from './invites.js';
import * as settings from './settings.js';
import * as gate from './gate.js';
import * as providers from './providers.js';
import * as models from './models.js';
import * as credentials from './credentials.js';
import * as audit from './audit.js';
import * as auditProxy from './audit-proxy.js';
import * as traces from './traces.js';
import * as upstream from './upstream.js';

export function registerAdminRoutes(app: FastifyInstance): void {
  for (const m of [overview, users, pricing, invites, settings, gate, providers, models, credentials, audit, auditProxy, traces, upstream]) {
    m.register(app);
  }
}
