/** Overview: the figures on the landing page */
import type { FastifyInstance } from 'fastify';
import * as usersRepo from '../../../core/db/users.js';
import * as usageRepo from '../../../core/db/usage.js';
import { fetchBalance } from '../../agents/provider.js';
import { listAgents } from '../../agents/registry.js';
import { guard } from './shared.js';

export function register(app: FastifyInstance): void {

  app.get('/api/admin/overview', guard, async () => {
    const monthStart = usageRepo.periodStart('monthly');
    const [balance, agents] = await Promise.all([fetchBalance(), listAgents()]);
    return {
      users: {
        total: usersRepo.count(),
        active: usersRepo.list().filter((u) => u.status === 'active').length,
      },
      usage: {
        month: usageRepo.totalsAll(monthStart),
        allTime: usageRepo.totalsAll(),
        daily: usageRepo.dailyAll(30),
        topUsers: usageRepo.topUsers(monthStart, 10),
      },
      balance,
      agents,
    };
  });
}
